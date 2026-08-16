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
import { coreCriticalConsequence } from "./CoreCriticalConsequences.mjs";
import { isCoreDetailedEffectProvider } from "./CoreDetailedCriticalTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";
const EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const PERIODIC_FLAG_KEY = "criticalPeriodic";
const VERSION = 1;

/**
 * Resolve declarative Critical consequences exactly once when a persistent Core
 * Critical Wound is materialized.
 *
 * Random duration formulas are rolled once and persisted on the wound before an
 * ActiveEffect is created. Reloading, disabling, or re-enabling the Effect can
 * therefore never reroll the injury. Destructive Item movement is a separate
 * one-shot Loot transaction rather than a repeatable ActiveEffect change.
 */
export class CriticalConsequenceEngine {
	static async apply(wound) {
		if (!isEligibleCoreWound(wound)) return null;
		const existing = runtimeState(wound);
		if (existing?.state === "applied") return existing;

		const location = genericLocation(wound.system?.hitLocation);
		const effectNumber = positiveInteger(wound.system?.resolution?.effectNumber);
		const definition = coreCriticalConsequence(location, effectNumber);
		if (!definition) return null;

		const resolved = await resolveRandomState(definition);
		const state = {
			version: VERSION,
			state: "applying",
			location,
			effectNumber,
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
	if (!isEligibleCoreWound(item) || !isConsequenceAuthority(item.parent)) return;
	void CriticalConsequenceEngine.apply(item).catch(reportConsequenceError);
});

/* Per-round automatic consequences are authoritative GM work. */
Hooks.on("combatTurnChange", (combat, prior, current) => {
	if (!isPrimaryActiveGm()) return;
	const priorRound = Number(prior?.round ?? combat.round ?? 0);
	const currentRound = Number(current?.round ?? combat.round ?? 0);
	if (!Number.isFinite(currentRound) || currentRound <= priorRound) return;
	void processPeriodicCriticals(combat, currentRound).catch(reportConsequenceError);
});

async function resolveRandomState(definition) {
	const resolved = {};
	if (definition.duration?.formula) {
		const roll = await evaluateFormula(definition.duration.formula);
		resolved.duration = {
			formula: String(definition.duration.formula),
			value: positiveInteger(roll.total),
			units: String(definition.duration.units ?? "rounds"),
			roll: roll.toJSON(),
		};
		await showDice(roll);
	}
	return resolved;
}

async function createManagedEffects(wound, definition, resolved) {
	const sources = [];

	/* Leg #5-#7 are still owned by the pre-existing audited characteristic
	 * consequence synchronizer. Do not duplicate them while the generic engine
	 * is introduced; Leg #4 proves the randomized-duration path. */
	const legacyCharacteristicOwner =
		genericLocation(wound.system?.hitLocation) === "leg" &&
		[5, 6, 7].includes(positiveInteger(wound.system?.resolution?.effectNumber));

	if (Array.isArray(definition.characteristics) && !legacyCharacteristicOwner) {
		const changes = definition.characteristics.map((entry) =>
			encodeRuleEffectChange({
				targetId: `characteristic.${String(entry.characteristicId)}.current`,
				operation: String(entry.operation),
				formula: String(entry.value),
				applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
				side: RULE_EFFECT_SIDES.SELF,
				stacking: "per-acquisition",
				condition: definition.until === "medical-attention"
					? localize("Until medical attention is received", "Do czasu otrzymania pomocy medycznej")
					: "",
			}),
		);
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
					expiry: null,
				},
			} : {}),
			flags: consequenceEffectFlags(wound, "characteristics", resolved),
		});
	}

	if (definition.periodicWounds?.formula) {
		sources.push({
			name: localize("Critical bleeding", "Krwawienie z rany krytycznej"),
			img: "icons/svg/blood.svg",
			disabled: false,
			transfer: true,
			changes: [],
			system: { changes: [] },
			flags: {
				...consequenceEffectFlags(wound, "periodic-wounds", resolved),
				[FLAG_SCOPE]: {
					...consequenceEffectFlags(wound, "periodic-wounds", resolved)[FLAG_SCOPE],
					[PERIODIC_FLAG_KEY]: {
						version: VERSION,
						kind: "wounds-per-round",
						formula: String(definition.periodicWounds.formula),
						until: String(definition.periodicWounds.until ?? ""),
						lastCombatId: "",
						lastRound: 0,
					},
				},
			},
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
	/* WFRP inventory uses dominant/non-dominant hand. Until the handedness field
	 * reaches the printed sheet, a persistent Actor flag may override the Core
	 * right-handed default. */
	const dominant = String(actor.getFlag?.(FLAG_SCOPE, "dominantHand") ?? "right").toLowerCase() === "left"
		? "left"
		: "right";
	const physical = location === "leftArm" ? "left" : "right";
	return physical === dominant ? INVENTORY_HAND.MAIN : INVENTORY_HAND.OFF;
}

async function processPeriodicCriticals(combat, round) {
	const actors = new Map();
	for (const combatant of combat.combatants ?? []) {
		const actor = combatant.actor;
		if (actor instanceof foundry.documents.Actor) actors.set(actor.uuid, actor);
	}

	for (const actor of actors.values()) {
		for (const wound of actor.items ?? []) {
			if (wound.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				const periodic = effect.getFlag?.(FLAG_SCOPE, PERIODIC_FLAG_KEY);
				if (!periodic || effect.disabled === true || effect.duration?.expired === true) continue;
				if (
					String(periodic.lastCombatId ?? "") === String(combat.id ?? "") &&
					Number(periodic.lastRound ?? 0) === round
				) continue;
				await applyPeriodicWounds(actor, wound, effect, periodic, combat, round);
			}
		}
	}
}

async function applyPeriodicWounds(actor, wound, effect, periodic, combat, round) {
	const packetId = `bleed-${effect.id}-${combat.id}-${round}`;
	const already = DamageApplication.transactionFor(actor, packetId);
	if (already?.state === "applied") {
		await stampPeriodic(effect, periodic, combat, round);
		return;
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
		},
	});
	const message = await DamageChat.publish({
		packet,
		resolution,
		speakerActor: actor,
	});
	const transaction = await DamageChat.applyMessage(message);
	if (!transaction) throw new Error("Critical bleeding damage could not be applied.");
	await stampPeriodic(effect, periodic, combat, round);
}

async function stampPeriodic(effect, periodic, combat, round) {
	await effect.setFlag(FLAG_SCOPE, PERIODIC_FLAG_KEY, {
		...foundry.utils.deepClone(periodic),
		lastCombatId: String(combat.id ?? ""),
		lastRound: round,
	});
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

function isEligibleCoreWound(wound) {
	return Boolean(
		wound instanceof foundry.documents.Item &&
		wound.type === "criticalWound" &&
		wound.parent instanceof foundry.documents.Actor &&
		isCoreDetailedEffectProvider(wound.system?.resolution?.providerId) &&
		positiveInteger(wound.system?.resolution?.effectNumber)
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

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
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
