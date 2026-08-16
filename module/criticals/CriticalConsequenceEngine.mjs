import { CombatEquipmentState } from "../combat/CombatEquipmentState.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolution } from "../damage/DamageResolution.mjs";
import {
	encodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { LootPileService } from "../loot/LootPileService.mjs";
import { criticalConsequenceForWound } from "./CriticalConsequenceDefinition.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";
const EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const PERIODIC_FLAG_KEY = "criticalPeriodic";
const TIMED_FLAG_KEY = "criticalTimed";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const VERSION = 14;
const processingTurns = new Set();
let processingWorldTime = false;

/**
 * Resolve declarative Critical consequences exactly once when a persistent
 * Critical Wound is materialized.
 *
 * The engine is intentionally ignorant of named Core results. A Core wound and
 * a user-authored wound expose the same `system.consequence` contract. Random
 * duration formulas are rolled once and the normalized definition is snapshotted
 * into runtime state, so later Item editing or a world reload cannot silently
 * change an already-applied injury.
 */
export class CriticalConsequenceEngine {
	static async apply(wound) {
		if (!isEligibleWound(wound)) return null;
		const existing = runtimeState(wound);
		if (existing?.state === "applied") return existing;

		const definition = criticalConsequenceForWound(wound);
		if (!definition?.enabled) return null;

		if (definition.dropHeld === "injured-hand") {
			const selected = await ensurePhysicalArmSide(wound);
			if (!selected) return null;
		}

		const resolved = await resolveRandomState(definition);
		const state = {
			version: VERSION,
			state: "applying",
			location: genericLocation(wound.system?.hitLocation),
			effectNumber: positiveInteger(wound.system?.resolution?.effectNumber),
			definition: foundry.utils.deepClone(definition),
			resolved,
			lootPileUuid: "",
			createdAt: Date.now(),
			completedAt: 0,
		};
		await wound.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, state);

		try {
			await createManagedEffects(wound, definition, resolved);

			if (definition.dropHeld) {
				const loot = await executeDropHeld(wound, definition.dropHeld);
				state.lootPileUuid = String(loot?.pileUuid ?? "");
			}

			state.state = "applied";
			state.completedAt = Date.now();
			await wound.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, state);
			refreshActorSheetIfOpen(wound.parent);
			return foundry.utils.deepFreeze(foundry.utils.deepClone(state));
		} catch (error) {
			state.state = "error";
			state.error = String(error?.message ?? error ?? "Unknown Critical consequence error");
			await wound.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, state).catch(() => {});
			throw error;
		}
	}
}

Hooks.on("createItem", (item) => {
	if (!isEligibleWound(item) || !isConsequenceAuthority(item.parent)) return;
	if (!criticalConsequenceForWound(item)?.enabled) return;
	void CriticalConsequenceEngine.apply(item).catch(reportConsequenceError);
});

/*
 * Round-based characteristic effects and periodic damage are anchored to the
 * initiative position at which the wound was applied. The partial remainder of
 * that turn/round never consumes a declared round and never causes an early tick.
 * Once captured, the numeric turn boundary is authoritative. Periodic damage is
 * reconciled from elapsed full cycles, so skipped/defeated turns do not need to
 * emit a dedicated anchor transition in order for bleeding to tick.
 */
Hooks.on("combatTurnChange", (combat, prior, current) => {
	if (!isPrimaryActiveGm()) return;
	queueTurnConsequences(combat, prior, current);
});

Hooks.on("updateCombat", (combat, changes) => {
	if (!isPrimaryActiveGm()) return;
	if (!Object.hasOwn(changes ?? {}, "round") && !Object.hasOwn(changes ?? {}, "turn")) return;
	queueTurnConsequences(combat, combat.previous, combat.current);
});

/* Foundry v14 world time is canonical seconds. Minute/hour/day periodic
 * lifetimes therefore remain deterministic even outside Combat. */
Hooks.on("updateWorldTime", (worldTime) => {
	if (!isPrimaryActiveGm() || processingWorldTime) return;
	processingWorldTime = true;
	void processPeriodicWorldTimeExpiries(Number(worldTime))
		.catch(reportConsequenceError)
		.finally(() => { processingWorldTime = false; });
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void repairExistingRuntimeEffects().catch(reportConsequenceError);
});

function queueTurnConsequences(combat, prior, current) {
	const key = combatTransitionKey(combat, prior, current);
	if (!combat?.id || !key || processingTurns.has(key)) return;
	processingTurns.add(key);
	void processTurnConsequences(combat, prior, current, key)
		.catch(reportConsequenceError)
		.finally(() => processingTurns.delete(key));
}

async function processTurnConsequences(combat, prior, current, transitionKey) {
	await processTimedCriticalTurnChange(combat, prior, current, transitionKey);
	await processPeriodicCriticalTurnChange(combat, prior, current, transitionKey);
}

async function resolveRandomState(definition) {
	const resolved = {};
	if (definition.duration?.formula) {
		const roll = await evaluateFormula(definition.duration.formula);
		resolved.duration = {
			formula: String(definition.duration.formula),
			value: positiveInteger(roll.total),
			units: String(definition.duration.units || "rounds"),
			roll: roll.toJSON(),
		};
		await showDice(roll);
	}

	const periodicDuration = definition.periodicWounds?.duration;
	if (
		definition.periodicWounds?.formula &&
		periodicDuration?.formula &&
		periodicDuration?.units
	) {
		const roll = await evaluateFormula(periodicDuration.formula);
		resolved.periodicDuration = {
			formula: String(periodicDuration.formula),
			value: positiveInteger(roll.total),
			units: String(periodicDuration.units),
			roll: roll.toJSON(),
		};
		await showDice(roll);
	}
	return resolved;
}

async function createManagedEffects(wound, definition, resolved) {
	const sources = [];

	if (Array.isArray(definition.characteristics) && definition.characteristics.length) {
		const condition = definition.duration?.until === "medical-attention"
			? localize("Until medical attention is received", "Do czasu otrzymania pomocy medycznej")
			: "";
		const changes = definition.characteristics.map((entry) =>
			encodeRuleEffectChange({
				targetId: `characteristic.${String(entry.characteristicId)}.current`,
				operation: String(entry.operation),
				formula: String(entry.value),
				applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
				side: RULE_EFFECT_SIDES.SELF,
				stacking: "per-acquisition",
				condition,
			}),
		);
		const flags = consequenceEffectFlags(wound, "characteristics", resolved);
		flags[FLAG_SCOPE][RULE_CHANGES_FLAG_KEY] = foundry.utils.deepClone(changes);
		if (resolved.duration?.units === "rounds") {
			flags[FLAG_SCOPE][TIMED_FLAG_KEY] = timedStateFor(
				wound.parent,
				resolved.duration,
			);
		}
		sources.push({
			name: localize("Critical Wound consequence", "Skutek rany krytycznej"),
			img: String(wound.img || "icons/svg/blood.svg"),
			disabled: false,
			transfer: true,
			changes: foundry.utils.deepClone(changes),
			system: { changes: foundry.utils.deepClone(changes) },
			...(resolved.duration ? {
				duration: {
					value: resolved.duration.value,
					units: resolved.duration.units,
					expired: false,
					expiry: resolved.duration.units === "rounds" ? "turnStart" : null,
				},
			} : {}),
			flags,
		});
	}

	if (definition.periodicWounds?.formula) {
		const flags = consequenceEffectFlags(wound, "periodic-wounds", resolved);
		flags[FLAG_SCOPE][PERIODIC_FLAG_KEY] = periodicStateFor(
			wound.parent,
			definition.periodicWounds,
			resolved.periodicDuration,
		);
		sources.push({
			name: localize("Critical bleeding", "Krwawienie z rany krytycznej"),
			img: "icons/svg/blood.svg",
			disabled: false,
			transfer: true,
			/* Bleeding is event-driven state, not a characteristic mutation. */
			changes: [],
			system: { changes: [] },
			flags,
		});
	}

	if (!sources.length) return [];
	return wound.createEmbeddedDocuments("ActiveEffect", sources);
}

function consequenceEffectFlags(wound, kind, resolved) {
	return {
		[FLAG_SCOPE]: {
			[EFFECT_FLAG_KEY]: {
				version: VERSION,
				kind,
				woundUuid: wound.uuid,
				location: genericLocation(wound.system?.hitLocation),
				effectNumber: positiveInteger(wound.system?.resolution?.effectNumber),
				resolved: foundry.utils.deepClone(resolved),
			},
		},
	};
}

function timedStateFor(actor, duration) {
	const combat = activeCombatForActor(actor);
	const current = combat?.current ?? {};
	return {
		version: VERSION,
		units: "rounds",
		durationRounds: positiveInteger(duration?.value),
		combatId: String(combat?.id ?? ""),
		startRound: combat ? nonNegativeInteger(combat.round ?? current.round) : 0,
		anchorCombatantId: String(combat?.combatant?.id ?? current.combatantId ?? ""),
		anchorTurn: combatTurnIndex(combat?.turn ?? current.turn),
		completedRounds: 0,
		lastTransitionKey: "",
		expiredAtRound: 0,
		expiredAtTurn: -1,
	};
}

function periodicStateFor(actor, definition, resolvedDuration) {
	const duration = resolvedDuration
		? foundry.utils.deepClone(resolvedDuration)
		: null;
	const combat = activeCombatForActor(actor);
	const current = combat?.current ?? {};
	const worldTime = currentWorldTime();
	const worldSeconds = duration && duration.units !== "rounds"
		? durationSeconds(duration.value, duration.units)
		: 0;
	return {
		version: VERSION,
		kind: "wounds-per-round",
		formula: String(definition.formula),
		until: String(definition.until ?? ""),
		duration,
		combatId: String(combat?.id ?? ""),
		startRound: combat ? nonNegativeInteger(combat.round ?? current.round) : 0,
		anchorCombatantId: String(combat?.combatant?.id ?? current.combatantId ?? ""),
		anchorTurn: combatTurnIndex(combat?.turn ?? current.turn),
		lastTransitionKey: "",
		lastCombatId: "",
		lastRound: 0,
		lastCycle: 0,
		ticksApplied: 0,
		startWorldTime: worldSeconds > 0 ? worldTime : 0,
		endWorldTime: worldSeconds > 0 ? worldTime + worldSeconds : 0,
		expiredAtRound: 0,
		expiredAtWorldTime: 0,
	};
}

async function ensurePhysicalArmSide(wound) {
	const current = String(wound.system?.hitLocation ?? "");
	if (current === "leftArm" || current === "rightArm") return current;
	if (current !== "arm") return current;

	/* A Critical Wound materialized from attack damage already has authoritative
	 * left/right hit-location provenance. Recover it defensively before offering
	 * the manual template dialog. */
	const inherited = physicalArmFromResolutionProvenance(wound);
	if (inherited) {
		await wound.update({ "system.hitLocation": inherited });
		return inherited;
	}

	const { DialogV2 } = foundry.applications.api;
	const choice = await DialogV2.wait({
		window: {
			title: localize("Choose injured arm", "Wybierz zranione ramię"),
		},
		content: `<p>${escapeHtml(localize(
			`The template '${wound.name}' does not know which arm was hit. Choose the physical arm before the automatic held-item consequence is applied.`,
			`Szablon '${wound.name}' nie określa, które ramię zostało trafione. Wybierz stronę przed automatycznym upuszczeniem trzymanych przedmiotów.`,
		))}</p>`,
		modal: true,
		rejectClose: false,
		buttons: [
			{
				action: "left",
				label: localize("Left arm", "Lewa ręka"),
				callback: () => "leftArm",
			},
			{
				action: "right",
				label: localize("Right arm", "Prawa ręka"),
				default: true,
				callback: () => "rightArm",
			},
		],
	});
	if (choice !== "leftArm" && choice !== "rightArm") {
		ui.notifications.info(localize(
			"The Critical Wound was added, but its side-dependent automatic consequence was not applied.",
			"Rana krytyczna została utworzona, ale automatyczny skutek zależny od strony nie został zastosowany.",
		));
		return "";
	}
	await wound.update({ "system.hitLocation": choice });
	return choice;
}

function physicalArmFromResolutionProvenance(wound) {
	const resolution = wound.system?.resolution ?? {};
	const sourceMessage = game.messages?.get(String(resolution.sourceMessageId ?? ""));
	const sourceLocation = sourceMessage
		?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY)
		?.packet?.hitLocation;
	if (isPhysicalArm(sourceLocation)) return String(sourceLocation);

	const resultMessage = game.messages?.get(String(resolution.resultMessageId ?? ""));
	const resultLocation = resultMessage
		?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY)
		?.resolution?.hitLocation;
	return isPhysicalArm(resultLocation) ? String(resultLocation) : "";
}

function isPhysicalArm(value) {
	return value === "leftArm" || value === "rightArm";
}

async function executeDropHeld(wound, mode) {
	const actor = wound.parent;
	if (!(actor instanceof foundry.documents.Actor)) return null;
	const items = heldItemsForMode(actor, String(mode), String(wound.system?.hitLocation ?? ""));
	if (!items.length) return null;
	return LootPileService.createFromActorItems({
		sourceActor: actor,
		items,
		reason: `critical-wound:${wound.uuid}`,
		sourceLabel: String(actor.name ?? ""),
	});
}

function heldItemsForMode(actor, mode, hitLocation) {
	const held = [...(actor.items ?? [])].filter((item) => {
		if (!LootPileService.isPhysicalItem(item)) return false;
		try {
			return CombatEquipmentState.usedMode(item) === INVENTORY_MODE.HELD &&
				String(item.system?.state?.mode ?? "") === INVENTORY_MODE.HELD;
		} catch (_error) {
			return false;
		}
	});
	if (mode === "all") return held;
	if (mode !== "injured-hand") return [];

	const targetHand = relativeHandForPhysicalArm(actor, hitLocation);
	if (!targetHand) return [];
	return held.filter((item) => {
		const hand = String(item.system?.state?.hand ?? INVENTORY_HAND.NONE);
		return hand === INVENTORY_HAND.BOTH || hand === targetHand;
	});
}

function relativeHandForPhysicalArm(actor, hitLocation) {
	const location = String(hitLocation ?? "");
	if (location !== "leftArm" && location !== "rightArm") return "";
	const dominant = String(actor.getFlag?.(FLAG_SCOPE, "dominantHand") ?? "right").toLowerCase() === "left"
		? "left"
		: "right";
	const physical = location === "leftArm" ? "left" : "right";
	return physical === dominant ? INVENTORY_HAND.MAIN : INVENTORY_HAND.OFF;
}

async function processTimedCriticalTurnChange(combat, prior, current, transitionKey) {
	const currentRound = nonNegativeInteger(combat?.round ?? current?.round);
	const currentTurn = combatTurnIndex(combat?.turn ?? current?.turn);

	for (const actor of combatActors(combat)) {
		for (const wound of actor.items ?? []) {
			if (wound.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				let timed = effectFlag(effect, TIMED_FLAG_KEY);
				if (!timed || effect.disabled === true) continue;
				if (positiveInteger(timed.expiredAtRound)) continue;
				const durationRounds = positiveInteger(timed.durationRounds);
				if (!durationRounds || String(timed.units ?? "") !== "rounds") continue;

				const hadAnchor = initiativeStateHasAnchor(timed, combat);
				timed = timedStateWithAnchor(effect, timed, combat, current);
				if (String(timed.lastTransitionKey ?? "") === transitionKey) continue;
				if (!hadAnchor) {
					await effect.setFlag(FLAG_SCOPE, TIMED_FLAG_KEY, {
						...foundry.utils.deepClone(timed),
						lastTransitionKey: transitionKey,
					});
					continue;
				}

				if (!transitionCrossesInitiativeAnchor(timed, combat, prior, current)) continue;
				if (currentRound <= nonNegativeInteger(timed.startRound)) {
					await effect.setFlag(FLAG_SCOPE, TIMED_FLAG_KEY, {
						...foundry.utils.deepClone(timed),
						lastTransitionKey: transitionKey,
					});
					continue;
				}

				const completedRounds = nonNegativeInteger(timed.completedRounds) + 1;
				if (completedRounds < durationRounds) {
					await effect.setFlag(FLAG_SCOPE, TIMED_FLAG_KEY, {
						...foundry.utils.deepClone(timed),
						completedRounds,
						lastTransitionKey: transitionKey,
					});
					continue;
				}

				await effect.update({
					disabled: true,
					"duration.expired": true,
					[`flags.${FLAG_SCOPE}.${TIMED_FLAG_KEY}`]: {
						...foundry.utils.deepClone(timed),
						completedRounds,
						lastTransitionKey: transitionKey,
						expiredAtRound: currentRound,
						expiredAtTurn: currentTurn,
					},
				});
				refreshActorSheetIfOpen(actor);
			}
		}
	}
}

function timedStateWithAnchor(effect, timed, combat, current) {
	if (initiativeStateHasAnchor(timed, combat)) return timed;

	const start = effect?.start ?? {};
	const sameCombat = String(start.combat ?? "") === String(combat?.id ?? "");
	const anchorCombatantId = sameCombat
		? String(start.combatant ?? "")
		: String(combat?.combatant?.id ?? current?.combatantId ?? "");
	const startRound = sameCombat
		? nonNegativeInteger(start.round)
		: nonNegativeInteger(combat?.round ?? current?.round);
	const anchorTurn = sameCombat
		? combatTurnIndex(start.turn)
		: combatTurnIndex(combat?.turn ?? current?.turn);

	return {
		...foundry.utils.deepClone(timed),
		version: VERSION,
		combatId: String(combat?.id ?? ""),
		startRound,
		anchorCombatantId,
		anchorTurn,
		completedRounds: nonNegativeInteger(timed.completedRounds),
		lastTransitionKey: String(timed.lastTransitionKey ?? ""),
		expiredAtRound: nonNegativeInteger(timed.expiredAtRound),
		expiredAtTurn: combatTurnIndex(timed.expiredAtTurn),
	};
}

async function processPeriodicCriticalTurnChange(combat, _prior, current, transitionKey) {
	const currentRound = nonNegativeInteger(combat?.round ?? current?.round);

	for (const actor of combatActors(combat)) {
		for (const wound of actor.items ?? []) {
			if (wound.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				let periodic = effectFlag(effect, PERIODIC_FLAG_KEY);
				if (!periodic || effect.disabled === true) continue;
				if (await expirePeriodicIfWorldTimeElapsed(effect, periodic, currentWorldTime())) continue;

				const hadAnchor = initiativeStateHasAnchor(periodic, combat);
				periodic = periodicStateWithAnchor(periodic, combat, current);
				if (!hadAnchor) {
					await effect.setFlag(FLAG_SCOPE, PERIODIC_FLAG_KEY, {
						...foundry.utils.deepClone(periodic),
						lastTransitionKey: transitionKey,
					});
					continue;
				}

				let targetTicks = completedInitiativeCycles(periodic, combat, current);
				const duration = periodic.duration && typeof periodic.duration === "object"
					? periodic.duration
					: null;
				if (duration?.units === "rounds" && positiveInteger(duration.value)) {
					targetTicks = Math.min(targetTicks, positiveInteger(duration.value));
				}

				let ticksApplied = nonNegativeInteger(periodic.ticksApplied);
				if (targetTicks <= ticksApplied) continue;

				while (ticksApplied < targetTicks && effect.disabled !== true) {
					const cycleNumber = ticksApplied + 1;
					periodic = await applyPeriodicWounds(
						actor,
						wound,
						effect,
						periodic,
						combat,
						currentRound,
						cycleNumber,
						transitionKey,
					);
					ticksApplied = nonNegativeInteger(periodic.ticksApplied);
					if (positiveInteger(periodic.expiredAtRound)) break;
				}
			}
		}
	}
}

function periodicStateWithAnchor(periodic, combat, current) {
	if (initiativeStateHasAnchor(periodic, combat)) return periodic;

	return {
		...foundry.utils.deepClone(periodic),
		version: VERSION,
		combatId: String(combat?.id ?? ""),
		startRound: nonNegativeInteger(combat?.round ?? current?.round),
		anchorCombatantId: String(combat?.combatant?.id ?? current?.combatantId ?? ""),
		anchorTurn: combatTurnIndex(combat?.turn ?? current?.turn),
		lastTransitionKey: String(periodic.lastTransitionKey ?? ""),
		lastCycle: nonNegativeInteger(periodic.lastCycle),
	};
}

async function applyPeriodicWounds(
	actor,
	wound,
	effect,
	periodic,
	combat,
	round,
	cycleNumber,
	transitionKey,
) {
	const packetId = `bleed-${effect.id}-${combat.id}-cycle-${cycleNumber}`;
	const already = DamageApplication.transactionFor(actor, packetId);
	if (already?.state === "applied") {
		return stampPeriodic(
			effect,
			periodic,
			combat,
			round,
			cycleNumber,
			transitionKey,
		);
	}

	const roll = await evaluateFormula(periodic.formula);
	await showDice(roll);
	const amount = positiveInteger(roll.total);
	const packet = new DamagePacket({
		id: packetId,
		rawAmount: amount,
		targetActorUuid: actor.uuid,
		source: {
			kind: "critical-bleeding",
			id: effect.id,
			uuid: wound.uuid,
			label: effect.name,
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
	});
	const resolution = DamageResolution.forPacket(packet, {
		finalAmount: amount,
		breakdown: {
			source: "critical-bleeding",
			formula: String(periodic.formula),
			roll: amount,
			woundUuid: wound.uuid,
			cycle: cycleNumber,
		},
	});
	const message = await DamageChat.publish({ packet, resolution, speakerActor: actor });
	const transaction = await DamageChat.applyMessage(message);
	if (!transaction) throw new Error("Critical bleeding damage could not be applied.");
	return stampPeriodic(
		effect,
		periodic,
		combat,
		round,
		cycleNumber,
		transitionKey,
	);
}

async function stampPeriodic(effect, periodic, combat, round, cycleNumber, transitionKey) {
	const ticksApplied = Math.max(
		nonNegativeInteger(periodic.ticksApplied) + 1,
		nonNegativeInteger(cycleNumber),
	);
	const duration = periodic.duration && typeof periodic.duration === "object"
		? foundry.utils.deepClone(periodic.duration)
		: null;
	const expiresByRounds = Boolean(
		duration?.units === "rounds" &&
		positiveInteger(duration.value) > 0 &&
		ticksApplied >= positiveInteger(duration.value)
	);
	const next = {
		...foundry.utils.deepClone(periodic),
		lastTransitionKey: transitionKey,
		lastCombatId: String(combat.id ?? ""),
		lastRound: round,
		lastCycle: nonNegativeInteger(cycleNumber),
		ticksApplied,
		expiredAtRound: expiresByRounds ? round : nonNegativeInteger(periodic.expiredAtRound),
	};
	const update = {
		[`flags.${FLAG_SCOPE}.${PERIODIC_FLAG_KEY}`]: next,
	};
	if (expiresByRounds) {
		update.disabled = true;
		update["duration.expired"] = true;
	}
	await effect.update(update);
	if (expiresByRounds) refreshActorSheetIfOpen(effect.parent?.parent);
	return next;
}

async function processPeriodicWorldTimeExpiries(worldTime) {
	if (!Number.isFinite(worldTime)) return;
	for (const actor of game.actors ?? []) {
		for (const wound of actor.items ?? []) {
			if (wound?.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				const periodic = effectFlag(effect, PERIODIC_FLAG_KEY);
				if (!periodic || effect.disabled === true) continue;
				await expirePeriodicIfWorldTimeElapsed(effect, periodic, worldTime);
			}
		}
	}
}

async function expirePeriodicIfWorldTimeElapsed(effect, periodic, worldTime) {
	const duration = periodic?.duration;
	if (!duration || duration.units === "rounds" || !positiveInteger(duration.value)) return false;
	let endWorldTime = Number(periodic.endWorldTime ?? 0);
	if (!Number.isFinite(endWorldTime) || endWorldTime <= 0) {
		const seconds = durationSeconds(duration.value, duration.units);
		if (seconds <= 0) return false;
		const anchored = {
			...foundry.utils.deepClone(periodic),
			startWorldTime: worldTime,
			endWorldTime: worldTime + seconds,
		};
		await effect.setFlag(FLAG_SCOPE, PERIODIC_FLAG_KEY, anchored);
		return false;
	}
	if (worldTime < endWorldTime) return false;
	await effect.update({
		disabled: true,
		"duration.expired": true,
		[`flags.${FLAG_SCOPE}.${PERIODIC_FLAG_KEY}`]: {
			...foundry.utils.deepClone(periodic),
			expiredAtWorldTime: worldTime,
		},
	});
	refreshActorSheetIfOpen(effect.parent?.parent);
	return true;
}

async function repairExistingRuntimeEffects() {
	for (const actor of game.actors ?? []) {
		let touched = false;
		for (const wound of actor.items ?? []) {
			if (wound?.type !== "criticalWound") continue;
			const runtime = runtimeState(wound);
			const duration = runtime?.resolved?.duration;
			if (!duration || String(duration.units ?? "") !== "rounds") continue;
			for (const effect of wound.effects ?? []) {
				const metadata = effectFlag(effect, EFFECT_FLAG_KEY);
				if (metadata?.kind !== "characteristics") continue;
				if (effectFlag(effect, TIMED_FLAG_KEY)) continue;
				await effect.setFlag(
					FLAG_SCOPE,
					TIMED_FLAG_KEY,
					timedStateFor(actor, duration),
				);
				touched = true;
			}
		}
		if (touched) refreshActorSheetIfOpen(actor);
	}
}

function combatActors(combat) {
	const actors = new Map();
	for (const combatant of combat?.combatants ?? []) {
		const actor = combatant.actor;
		if (actor instanceof foundry.documents.Actor) actors.set(actor.uuid, actor);
	}
	return [...actors.values()];
}

function activeCombatForActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return null;
	for (const combat of game.combats ?? []) {
		if (!combat?.started || nonNegativeInteger(combat.round) <= 0) continue;
		if ([...(combat.combatants ?? [])].some((combatant) => combatant.actor?.uuid === actor.uuid)) {
			return combat;
		}
	}
	return null;
}

function initiativeStateHasAnchor(state, combat) {
	return Boolean(
		String(state?.combatId ?? "") === String(combat?.id ?? "") &&
		nonNegativeInteger(state?.startRound) > 0 &&
		(
			String(state?.anchorCombatantId ?? "") ||
			combatTurnIndex(state?.anchorTurn) >= 0
		)
	);
}

function completedInitiativeCycles(state, combat, current) {
	const startRound = nonNegativeInteger(state?.startRound);
	const currentRound = nonNegativeInteger(combat?.round ?? current?.round);
	const currentTurn = combatTurnIndex(combat?.turn ?? current?.turn);
	const anchorTurn = virtualAnchorTurn(state, combat);
	if (!startRound || currentRound <= startRound || currentTurn < 0 || anchorTurn < 0) {
		return 0;
	}

	const completed = currentRound - startRound - (currentTurn < anchorTurn ? 1 : 0);
	return Math.max(0, completed);
}

function transitionCrossesInitiativeAnchor(state, combat, prior, current) {
	const priorRound = nonNegativeInteger(prior?.round ?? combat?.previous?.round);
	const currentRound = nonNegativeInteger(combat?.round ?? current?.round);
	const priorTurn = combatTurnIndex(prior?.turn ?? combat?.previous?.turn);
	const currentTurn = combatTurnIndex(combat?.turn ?? current?.turn);
	if (currentRound <= 0 || priorTurn < 0 || currentTurn < 0) return false;
	if (currentRound < priorRound) return false;

	const anchorCombatantId = String(state?.anchorCombatantId ?? "");
	const liveCurrentCombatantId = String(combat?.combatant?.id ?? "");
	if (anchorCombatantId && liveCurrentCombatantId === anchorCombatantId) return true;

	/*
	 * If the original anchor is skipped or no longer present, the saved turn
	 * index remains as a virtual boundary. The live Combat turn is used for the
	 * current side so a defeated status cannot hide a visible tracker turn from
	 * this scheduler.
	 */
	const anchorTurn = virtualAnchorTurn(state, combat);
	if (anchorTurn < 0) return false;

	if (currentRound === priorRound) {
		return currentTurn > priorTurn && anchorTurn > priorTurn && anchorTurn <= currentTurn;
	}
	if (currentRound - priorRound > 1) return true;
	return anchorTurn > priorTurn || anchorTurn <= currentTurn;
}

function virtualAnchorTurn(state, combat) {
	const savedTurn = combatTurnIndex(state?.anchorTurn);
	const turnCount = Number(combat?.turns?.length ?? 0);
	if (savedTurn < 0 || !Number.isInteger(turnCount) || turnCount <= 0) return -1;
	/* A saved index equal to the new turn count represents the old last slot.
	 * Its virtual boundary is therefore crossed when Combat wraps to turn 0. */
	return Math.min(savedTurn, turnCount);
}

function combatTransitionKey(combat, prior, current) {
	if (!combat?.id) return "";
	return [
		String(combat.id),
		`${nonNegativeInteger(prior?.round ?? combat?.previous?.round)}:${combatTurnIndex(prior?.turn ?? combat?.previous?.turn)}:${String(prior?.combatantId ?? "")}`,
		`${nonNegativeInteger(combat?.round ?? current?.round)}:${combatTurnIndex(combat?.turn ?? current?.turn)}:${String(combat?.combatant?.id ?? current?.combatantId ?? "")}`,
	].join("|");
}

function combatTurnIndex(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : -1;
}

function effectFlag(effect, key) {
	const direct = effect?.getFlag?.(FLAG_SCOPE, key);
	if (direct !== undefined && direct !== null) return foundry.utils.deepClone(direct);
	const source = effect?.toObject?.() ?? {};
	const fallback = source.flags?.[FLAG_SCOPE]?.[key];
	return fallback === undefined || fallback === null
		? null
		: foundry.utils.deepClone(fallback);
}

async function evaluateFormula(formula) {
	const roll = await new Roll(String(formula)).evaluate({ allowInteractive: false });
	if (!Number.isInteger(Number(roll.total)) || Number(roll.total) <= 0) {
		throw new Error(`Critical consequence roll '${formula}' did not produce a positive integer.`);
	}
	return roll;
}

async function showDice(roll) {
	try {
		if (game.dice3d?.showForRoll) await game.dice3d.showForRoll(roll, game.user, true);
	} catch (_error) {
		/* Dice So Nice is presentation-only. */
	}
}

function runtimeState(wound) {
	const value = wound.getFlag?.(FLAG_SCOPE, RUNTIME_FLAG_KEY);
	return value && typeof value === "object" && !Array.isArray(value)
		? foundry.utils.deepClone(value)
		: null;
}

function isEligibleWound(wound) {
	return Boolean(
		wound instanceof foundry.documents.Item &&
		wound.type === "criticalWound" &&
		wound.parent instanceof foundry.documents.Actor
	);
}

function isConsequenceAuthority(actor) {
	const gm = primaryActiveGm();
	if (gm) return game.user?.id === gm.id;
	return Boolean(actor?.isOwner);
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return Boolean(game.user?.isGM && primaryActiveGm()?.id === game.user.id);
}

function currentWorldTime() {
	const value = Number(game.time?.worldTime ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function durationSeconds(value, units) {
	const amount = positiveInteger(value);
	if (!amount) return 0;
	switch (String(units ?? "")) {
		case "minutes": return amount * 60;
		case "hours": return amount * 60 * 60;
		case "days": return amount * 24 * 60 * 60;
		default: return 0;
	}
}

function genericLocation(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "leftArm":
		case "rightArm":
		case "arm": return "arm";
		case "leftLeg":
		case "rightLeg":
		case "leg": return "leg";
		case "head": return "head";
		case "body": return "body";
		default: return "";
	}
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function refreshActorSheetIfOpen(actor) {
	const sheet = actor?.sheet;
	if (!sheet?.rendered) return;
	void sheet.render();
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function reportConsequenceError(error) {
	console.error("WFRP1ED | Critical consequence application failed.", error);
	if (game.user?.isGM) {
		ui.notifications.warn(error?.message ?? localize(
			"A Critical Wound was created, but one automatic consequence failed.",
			"Rana krytyczna została utworzona, ale jeden automatyczny skutek nie został zastosowany.",
		));
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
