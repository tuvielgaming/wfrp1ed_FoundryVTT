import { CombatEquipmentState } from "../combat/CombatEquipmentState.mjs";
import { CombatInitiativeClock } from "../combat/CombatInitiativeClock.mjs";
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
const CRITICAL_ROLL_SUMMARY_FLAG_KEY = "criticalRollSummary";
const VERSION = 16;
const processingPeriodicTicks = new Set();
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

		const resolved = await resolveRandomState(wound, definition);
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
			const effects = await createManagedEffects(wound, definition, resolved);
			if (effects.length) refreshActorSheetIfOpen(wound.parent);

			if (definition.dropHeld) {
				const loot = await executeDropHeld(wound, definition.dropHeld);
				state.lootPileUuid = String(loot?.pileUuid ?? "");
			}

			state.state = "applied";
			state.completedAt = Date.now();
			await wound.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, state);
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
 * Round-based Critical consequences use one shared immutable Initiative clock.
 * The clock is captured from the round's canonical Initiative value, not from
 * Foundry's mutable turn index or from the Combatant identity. Temporary order
 * changes therefore cannot move an existing wound's lifecycle boundary.
 *
 * CombatInitiativeClock is emitted only by Wfrp1edCombat's real Next Turn /
 * Next Round progression. Tracker drag/focus changes do not age the wound. End
 * of round is the agreed fallback boundary when the saved Initiative point was
 * skipped or made unreachable during that round.
 */
CombatInitiativeClock.registerConsumer(async (combat, event) => {
	if (!isPrimaryActiveGm()) return;
	try {
		await processClockConsequences(combat, event);
	} catch (error) {
		reportConsequenceError(error);
	}
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

async function processClockConsequences(combat, event) {
	await processTimedCriticalClock(combat, event);
	await processPeriodicCriticalClock(combat, event);
}

/**
 * Resolve random Critical values in presentation order. When a real roll is
 * involved, rules processing intentionally waits until Dice So Nice has finished
 * and the explanatory chat summary has been published. Non-random consequences
 * do not pay this presentation cost.
 */
async function resolveRandomState(wound, definition) {
	const resolved = {};
	if (definition.duration?.formula) {
		const roll = await evaluateFormula(definition.duration.formula);
		resolved.duration = {
			formula: String(definition.duration.formula),
			value: positiveInteger(roll.total),
			units: String(definition.duration.units || "rounds"),
			roll: roll.toJSON(),
		};
		await presentCriticalRoll(wound, roll, {
			kind: "characteristic-duration",
			formula: resolved.duration.formula,
			value: resolved.duration.value,
			units: resolved.duration.units,
		});
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
		await presentCriticalRoll(wound, roll, {
			kind: "periodic-duration",
			formula: resolved.periodicDuration.formula,
			value: resolved.periodicDuration.value,
			units: resolved.periodicDuration.units,
		});
	}
	return resolved;
}

async function presentCriticalRoll(wound, roll, result) {
	await showDice(roll);
	await publishCriticalRollSummary(wound, result);
}

async function publishCriticalRollSummary(wound, result) {
	const actor = wound.parent;
	const kind = String(result?.kind ?? "");
	const value = positiveInteger(result?.value);
	const units = String(result?.units ?? "rounds");
	const formula = String(result?.formula ?? "");
	const purpose = kind === "periodic-duration"
		? localize(
			"Duration of periodic Wound loss",
			"Czas trwania okresowej utraty Żywotności",
		)
		: localize(
			"Duration of characteristic changes",
			"Czas trwania zmian cech",
		);
	const determined = formatDuration(value, units);
	const title = localize("Critical Wound roll", "Rzut rany krytycznej");
	const labels = {
		wound: localize("Wound", "Rana"),
		target: localize("Target", "Cel"),
		purpose: localize("Why this roll", "Cel rzutu"),
		roll: localize("Roll", "Rzut"),
		determined: localize("Determined", "Ustalono"),
	};
	const content = `
		<section class="wfrp1ed critical-roll-summary" data-wfrp-critical-roll-summary>
			<h3>${escapeHtml(title)}</h3>
			<div><strong>${escapeHtml(labels.target)}:</strong> ${escapeHtml(actor?.name ?? "—")}</div>
			<div><strong>${escapeHtml(labels.wound)}:</strong> ${escapeHtml(wound.name ?? "—")}</div>
			<div><strong>${escapeHtml(labels.purpose)}:</strong> ${escapeHtml(purpose)}</div>
			<div><strong>${escapeHtml(labels.roll)}:</strong> ${escapeHtml(formula)} → <strong>${escapeHtml(String(value))}</strong></div>
			<div><strong>${escapeHtml(labels.determined)}:</strong> ${escapeHtml(`${purpose}: ${determined}`)}</div>
		</section>
	`;

	await ChatMessage.create({
		speaker: actor instanceof foundry.documents.Actor
			? ChatMessage.getSpeaker({ actor })
			: ChatMessage.getSpeaker(),
		content,
		flags: {
			[FLAG_SCOPE]: {
				[CRITICAL_ROLL_SUMMARY_FLAG_KEY]: {
					version: 1,
					woundUuid: String(wound.uuid ?? ""),
					kind,
					formula,
					value,
					units,
					createdAt: Date.now(),
				},
			},
		},
	});
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
			/* Round duration is owned exclusively by the WFRP Initiative clock.
			 * Giving Foundry its own round expiry here would create a second,
			 * incompatible lifecycle. Non-round units may still use metadata. */
			...(resolved.duration && resolved.duration.units !== "rounds" ? {
				duration: {
					value: resolved.duration.value,
					units: resolved.duration.units,
					expired: false,
					expiry: null,
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
	return {
		version: VERSION,
		units: "rounds",
		durationRounds: positiveInteger(duration?.value),
		...CombatInitiativeClock.capture(combat),
		completedRounds: 0,
		expiredAtRound: 0,
		expiredAtTurn: -1,
	};
}

function periodicStateFor(actor, definition, resolvedDuration) {
	const duration = resolvedDuration
		? foundry.utils.deepClone(resolvedDuration)
		: null;
	const combat = activeCombatForActor(actor);
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
		...CombatInitiativeClock.capture(combat),
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

async function processTimedCriticalClock(combat, event) {
	const currentRound = nonNegativeInteger(event?.round);
	const currentTurn = combatTurnIndex(combat?.turn);

	for (const actor of combatActors(combat)) {
		for (const wound of actor.items ?? []) {
			if (wound.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				let timed = effectFlag(effect, TIMED_FLAG_KEY);
				if (!timed || effect.disabled === true) continue;
				if (positiveInteger(timed.expiredAtRound)) continue;
				const durationRounds = positiveInteger(timed.durationRounds);
				if (!durationRounds || String(timed.units ?? "") !== "rounds") continue;

				const hadClock = CombatInitiativeClock.anchored(timed, combat);
				timed = clockStateWithLegacyAnchor(timed, combat);
				if (!hadClock) {
					/* Legacy turn-index states are migrated conservatively. Establish the
					 * immutable Initiative point on the first clock event and do not age
					 * the effect on that same migration event. */
					await effect.setFlag(FLAG_SCOPE, TIMED_FLAG_KEY, {
						...timed,
						lastClockRound: Math.max(
							nonNegativeInteger(timed.lastClockRound),
							currentRound,
						),
					});
					continue;
				}

				if (!CombatInitiativeClock.isDue(timed, event)) continue;
				timed = CombatInitiativeClock.stamp(timed, event);
				const completedRounds = nonNegativeInteger(timed.completedRounds) + 1;

				if (completedRounds < durationRounds) {
					await effect.setFlag(FLAG_SCOPE, TIMED_FLAG_KEY, {
						...timed,
						version: VERSION,
						completedRounds,
					});
					continue;
				}

				await effect.update({
					disabled: true,
					"duration.expired": true,
					[`flags.${FLAG_SCOPE}.${TIMED_FLAG_KEY}`]: {
						...timed,
						version: VERSION,
						completedRounds,
						expiredAtRound: currentRound,
						expiredAtTurn: currentTurn,
					},
				});
				refreshActorSheetIfOpen(actor);
			}
		}
	}
}

async function processPeriodicCriticalClock(combat, event) {
	const currentRound = nonNegativeInteger(event?.round);

	for (const actor of combatActors(combat)) {
		for (const wound of actor.items ?? []) {
			if (wound.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				let periodic = effectFlag(effect, PERIODIC_FLAG_KEY);
				if (!periodic || effect.disabled === true) continue;
				if (await expirePeriodicIfWorldTimeElapsed(effect, periodic, currentWorldTime())) continue;

				const hadClock = CombatInitiativeClock.anchored(periodic, combat);
				periodic = clockStateWithLegacyAnchor(periodic, combat);
				if (!hadClock) {
					await effect.setFlag(FLAG_SCOPE, PERIODIC_FLAG_KEY, {
						...periodic,
						lastClockRound: Math.max(
							nonNegativeInteger(periodic.lastClockRound),
							currentRound,
						),
					});
					continue;
				}

				if (!CombatInitiativeClock.isDue(periodic, event)) continue;
				const duration = periodic.duration && typeof periodic.duration === "object"
					? periodic.duration
					: null;
				const ticksApplied = nonNegativeInteger(periodic.ticksApplied);
				if (
					duration?.units === "rounds" &&
					positiveInteger(duration.value) > 0 &&
					ticksApplied >= positiveInteger(duration.value)
				) {
					await effect.update({
						disabled: true,
						"duration.expired": true,
					});
					continue;
				}

				const cycleNumber = ticksApplied + 1;
				await applyPeriodicWounds(
					actor,
					wound,
					effect,
					periodic,
					combat,
					event,
					cycleNumber,
				);
			}
		}
	}
}

function clockStateWithLegacyAnchor(state, combat) {
	if (CombatInitiativeClock.anchored(state, combat)) {
		return foundry.utils.deepClone(state);
	}

	let clockInitiative = null;
	const legacyId = String(state?.anchorCombatantId ?? "");
	if (legacyId) {
		clockInitiative = CombatInitiativeClock.canonicalInitiative(
			combat?.combatants?.get?.(legacyId) ?? null,
		);
	}
	if (clockInitiative === null) {
		const legacyTurn = combatTurnIndex(state?.anchorTurn);
		if (legacyTurn >= 0) {
			clockInitiative = CombatInitiativeClock.canonicalInitiative(
				combat?.turns?.[legacyTurn] ?? null,
			);
		}
	}

	const captured = CombatInitiativeClock.capture(combat);
	return {
		...foundry.utils.deepClone(state ?? {}),
		version: VERSION,
		combatId: String(combat?.id ?? captured.combatId ?? ""),
		startRound: nonNegativeInteger(state?.startRound) || captured.startRound,
		clockInitiative: clockInitiative ?? captured.clockInitiative,
		lastClockRound: nonNegativeInteger(state?.lastClockRound),
	};
}

async function applyPeriodicWounds(
	actor,
	wound,
	effect,
	periodic,
	combat,
	event,
	cycleNumber,
) {
	const packetId = `bleed-${effect.id}-${combat.id}-cycle-${cycleNumber}`;
	const tickKey = `${actor.uuid}|${packetId}`;
	if (processingPeriodicTicks.has(tickKey)) return null;
	processingPeriodicTicks.add(tickKey);

	try {
		const already = DamageApplication.transactionFor(actor, packetId);
		if (already?.state === "applied") {
			return await stampPeriodic(
				effect,
				periodic,
				combat,
				event,
				cycleNumber,
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
				clockEvent: String(event?.kind ?? ""),
			},
		});
		const message = await DamageChat.publish({ packet, resolution, speakerActor: actor });
		const transaction = await DamageChat.applyMessage(message);
		if (!transaction) throw new Error("Critical bleeding damage could not be applied.");
		return await stampPeriodic(
			effect,
			periodic,
			combat,
			event,
			cycleNumber,
		);
	} finally {
		processingPeriodicTicks.delete(tickKey);
	}
}

async function stampPeriodic(effect, periodic, combat, event, cycleNumber) {
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
	const stamped = CombatInitiativeClock.stamp(periodic, event);
	const next = {
		...stamped,
		version: VERSION,
		lastCombatId: String(combat.id ?? ""),
		lastRound: nonNegativeInteger(event?.round),
		lastCycle: nonNegativeInteger(cycleNumber),
		ticksApplied,
		expiredAtRound: expiresByRounds
			? nonNegativeInteger(event?.round)
			: nonNegativeInteger(periodic.expiredAtRound),
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

function formatDuration(value, units) {
	const amount = positiveInteger(value);
	const unit = String(units ?? "");
	if (game.i18n.lang !== "pl") {
		const singular = {
			rounds: "round",
			minutes: "minute",
			hours: "hour",
			days: "day",
		}[unit] ?? unit;
		return `${amount} ${amount === 1 ? singular : `${singular}s`}`;
	}

	const forms = {
		rounds: ["runda", "rundy", "rund"],
		minutes: ["minuta", "minuty", "minut"],
		hours: ["godzina", "godziny", "godzin"],
		days: ["dzień", "dni", "dni"],
	}[unit] ?? [unit, unit, unit];
	return `${amount} ${polishPlural(amount, forms)}`;
}

function polishPlural(value, [one, few, many]) {
	const amount = Math.abs(Math.trunc(Number(value)));
	if (amount === 1) return one;
	const lastTwo = amount % 100;
	const last = amount % 10;
	if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return few;
	return many;
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
