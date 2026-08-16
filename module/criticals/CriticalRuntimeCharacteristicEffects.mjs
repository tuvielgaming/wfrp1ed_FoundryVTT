import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import {
	RULE_EFFECT_OPERATIONS,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";
import { coreCriticalConsequence } from "./CoreCriticalConsequences.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";
const EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const TIMED_FLAG_KEY = "criticalTimed";
const CRITICAL_WOUND_TYPE = "criticalWound";
const CHARACTERISTIC_ALIASES = Object.freeze({ sp: "m" });

let previousGetCharacteristicValue = null;

/**
 * Runtime Critical consequences such as Leg #4 are generated after the wound is
 * created and can carry a system-owned round timer. Foundry may prepare the
 * Item-grandchild ActiveEffect in a state which the generic resolver does not
 * expose even though the WFRP timer is still active. This wrapper is the final
 * characteristic-consumer bridge for those runtime consequences.
 *
 * It is deliberately deduplicating: if RuleEffectResolver already exposes the
 * wound's candidate for this target, the normal generic path owns the result and
 * this layer does nothing.
 */
Hooks.once("init", () => {
	if (previousGetCharacteristicValue) return;
	previousGetCharacteristicValue = Wfrp1edActor.prototype.getCharacteristicValue;

	Wfrp1edActor.prototype.getCharacteristicValue = function getCharacteristicWithRuntimeCriticals(id) {
		const value = previousGetCharacteristicValue.call(this, id);
		return applyMissingRuntimeCriticalConsequences(this, id, value);
	};
});

function applyMissingRuntimeCriticalConsequences(actor, id, startingValue) {
	if (!(actor instanceof foundry.documents.Actor)) return startingValue;
	const characteristicId = canonicalCharacteristicId(id);
	const targetId = `characteristic.${characteristicId}.current`;
	const resolvedCandidates = RuleEffectResolver.candidates(actor, targetId);
	let value = finiteNumber(startingValue);

	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;
		const runtime = wound.getFlag?.(FLAG_SCOPE, RUNTIME_FLAG_KEY);
		if (!runtime || runtime.state !== "applied") continue;

		const definition = coreCriticalConsequence(
			genericLocation(wound.system?.hitLocation),
			positiveInteger(wound.system?.resolution?.effectNumber),
		);
		const entry = definition?.characteristics?.find((candidate) =>
			String(candidate.characteristicId ?? "") === characteristicId,
		);
		if (!entry) continue;

		const managedEffect = [...(wound.effects ?? [])].find((effect) =>
			effect?.getFlag?.(FLAG_SCOPE, EFFECT_FLAG_KEY)?.kind === "characteristics"
		) ?? null;
		if (!managedEffect || managedEffect.disabled === true) continue;
		if (wfrpTimedEffectExpired(managedEffect)) continue;

		/* Do not apply the same wound twice when normal ActiveEffect discovery is
		 * working. The runtime bridge exists only for a missing candidate. */
		if (resolvedCandidates.some((candidate) =>
			String(candidate.itemUuid ?? "") === String(wound.uuid ?? "") &&
			String(candidate.targetId ?? "") === targetId
		)) continue;

		const operand = finiteNumber(entry.value);
		switch (String(entry.operation ?? "")) {
			case RULE_EFFECT_OPERATIONS.ADD: value += operand; break;
			case RULE_EFFECT_OPERATIONS.SUBTRACT: value -= operand; break;
			case RULE_EFFECT_OPERATIONS.MULTIPLY: value *= operand; break;
			case RULE_EFFECT_OPERATIONS.OVERRIDE: value = operand; break;
			default: break;
		}
	}

	return value;
}

function wfrpTimedEffectExpired(effect) {
	const timed = effect.getFlag?.(FLAG_SCOPE, TIMED_FLAG_KEY);
	if (
		timed &&
		typeof timed === "object" &&
		String(timed.units ?? "") === "rounds"
	) {
		return positiveInteger(timed.expiredAtRound) > 0;
	}
	return effect.duration?.expired === true;
}

function canonicalCharacteristicId(id) {
	const normalized = String(id ?? "").trim().toLowerCase();
	return CHARACTERISTIC_ALIASES[normalized] ?? normalized;
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

function finiteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}
