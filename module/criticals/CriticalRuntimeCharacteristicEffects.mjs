import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import {
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";
import { coreCriticalConsequence } from "./CoreCriticalConsequences.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";
const EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const TIMED_FLAG_KEY = "criticalTimed";
const CRITICAL_WOUND_TYPE = "criticalWound";
const CHARACTERISTIC_ALIASES = Object.freeze({ sp: "m" });
const EPSILON = 0.000001;

let previousGetCharacteristicValue = null;

/**
 * Runtime Critical consequences such as Leg #4 are generated after the wound is
 * created and carry a system-owned round timer. Foundry can prepare the nested
 * Item ActiveEffect differently from an Actor ActiveEffect, so this bridge is a
 * final, deterministic characteristic consumer for those runtime consequences.
 *
 * The generic RuleEffectResolver is still useful for normal Active Effects, but
 * merely discovering a nested runtime candidate is not proof that an earlier
 * characteristic wrapper actually consumed it. We therefore project the value
 * once without and once with the runtime wound and compare those projections to
 * the value produced by the preceding characteristic pipeline. This avoids both
 * the former Initiative false-positive and double-applying Movement.
 */
Hooks.once("init", () => {
	if (previousGetCharacteristicValue) return;
	previousGetCharacteristicValue = Wfrp1edActor.prototype.getCharacteristicValue;

	Wfrp1edActor.prototype.getCharacteristicValue = function getCharacteristicWithRuntimeCriticals(id) {
		const value = previousGetCharacteristicValue.call(this, id);
		return applyMissingRuntimeCriticalConsequences(this, id, value);
	};
});

/*
 * The older Critical characteristic decorator only owns the permanent Core
 * Leg #5-#7 effects. Timed runtime consequences need the same visual contract:
 * effective value plus the `!` marker/tooltip on the Classic sheet.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		!(actor instanceof foundry.documents.Actor) ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	decorateRuntimeCharacteristics(actor, element);
});

function applyMissingRuntimeCriticalConsequences(actor, id, startingValue) {
	if (!(actor instanceof foundry.documents.Actor)) return startingValue;
	const characteristicId = canonicalCharacteristicId(id);
	const sources = runtimeCharacteristicSources(actor, characteristicId);
	if (!sources.length) return startingValue;

	const targetId = `characteristic.${characteristicId}.current`;
	const allCandidates = RuleEffectResolver.candidates(actor, targetId).filter((candidate) =>
		candidate.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC &&
		candidate.side === RULE_EFFECT_SIDES.SELF,
	);
	const runtimeWoundUuids = new Set(
		sources.map((source) => String(source.wound?.uuid ?? "")).filter(Boolean),
	);
	const nonRuntimeCandidates = allCandidates.filter((candidate) =>
		!runtimeWoundUuids.has(String(candidate.itemUuid ?? "")),
	);

	const current = finiteNumber(startingValue);
	const raw = rawCharacteristicValue(actor, characteristicId);
	const projectedWithoutRuntime = applyCandidates(raw, nonRuntimeCandidates);
	const projectedWithRuntime = applyRuntimeSources(projectedWithoutRuntime, sources);

	/* The preceding pipeline already consumed this runtime wound. */
	if (nearlyEqual(current, projectedWithRuntime)) return current;

	/* The preceding pipeline produced the value without the runtime wound. This
	 * is the Leg #4 Initiative failure we observed: RuleEffectResolver could see
	 * the nested I candidate while the earlier wrapper had not consumed it. */
	if (
		nearlyEqual(current, projectedWithoutRuntime) ||
		nearlyEqual(current, raw)
	) {
		return applyRuntimeSources(current, sources);
	}

	/* If no runtime candidate was discoverable at all, the bridge is definitely
	 * the sole owner and must apply it. Otherwise keep an unfamiliar transformed
	 * value unchanged rather than risk applying the same wound twice. */
	const runtimeCandidateExists = allCandidates.some((candidate) =>
		runtimeWoundUuids.has(String(candidate.itemUuid ?? "")),
	);
	return runtimeCandidateExists
		? current
		: applyRuntimeSources(current, sources);
}

function decorateRuntimeCharacteristics(actor, root) {
	for (const characteristicId of ["m", "i"]) {
		const sources = runtimeCharacteristicSources(actor, characteristicId);
		if (!sources.length) continue;

		const storageId = characteristicId === "m" && !root.querySelector('[data-characteristic="m"]')
			? "sp"
			: characteristicId;
		const cell = root.querySelector(
			`.characteristics-row--current [data-characteristic="${storageId}"]`,
		);
		if (!cell) continue;

		const value = Number(actor.getCharacteristicValue(characteristicId));
		if (Number.isFinite(value)) {
			const profile = cell.querySelector(".characteristic-current-profile");
			if (profile) profile.textContent = formatValue(value);
		}

		const tooltip = sources.map(runtimeSourceTooltip).join("\n");
		let marker = cell.querySelector("[data-wfrp-characteristic-effect-marker]");
		if (!marker) {
			marker = root.ownerDocument.createElement("span");
			marker.className = "characteristic-current-effect-marker";
			marker.dataset.wfrpCharacteristicEffectMarker = "";
			marker.textContent = "!";
			cell.append(marker);
		}
		const prior = String(marker.title ?? "").trim();
		marker.title = prior && !prior.includes(tooltip) ? `${prior}\n${tooltip}` : tooltip;
		marker.setAttribute("aria-label", marker.title);
		cell.title = marker.title;
	}
}

function runtimeCharacteristicSources(actor, characteristicId) {
	const sources = [];
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
		if (!managedEffect || managedEffect.disabled === true || wfrpTimedEffectExpired(managedEffect)) continue;

		sources.push({ wound, effect: managedEffect, entry, runtime, definition });
	}
	return sources;
}

function runtimeSourceTooltip(source) {
	const woundName = String(source.wound?.name ?? localize("Critical Wound", "Rana krytyczna"));
	const operation = String(source.entry?.operation ?? "");
	const operand = Number(source.entry?.value);
	let consequence = "";
	if (operation === RULE_EFFECT_OPERATIONS.MULTIPLY && operand === 0.5) {
		consequence = localize("halved", "zmniejszona o połowę");
	} else {
		consequence = `${operation} ${formatValue(operand)}`;
	}
	const timed = source.effect?.getFlag?.(FLAG_SCOPE, TIMED_FLAG_KEY);
	const duration = positiveInteger(timed?.durationRounds);
	return duration
		? localize(
			`${woundName} — ${consequence} for ${duration} round${duration === 1 ? "" : "s"}`,
			`${woundName} — ${consequence} przez ${duration} ${polishRounds(duration)}`,
		)
		: `${woundName} — ${consequence}`;
}

function applyRuntimeSources(value, sources) {
	let result = finiteNumber(value);
	for (const source of sources) {
		result = applyOperation(result, source.entry?.operation, source.entry?.value);
	}
	return result;
}

function applyCandidates(value, candidates) {
	let result = finiteNumber(value);
	for (const candidate of candidates ?? []) {
		result = applyOperation(result, candidate?.operation, candidate?.formula);
	}
	return result;
}

function applyOperation(value, operation, operandValue) {
	const operand = finiteNumber(operandValue);
	switch (String(operation ?? "")) {
		case RULE_EFFECT_OPERATIONS.ADD: return value + operand;
		case RULE_EFFECT_OPERATIONS.SUBTRACT: return value - operand;
		case RULE_EFFECT_OPERATIONS.MULTIPLY: return value * operand;
		case RULE_EFFECT_OPERATIONS.OVERRIDE: return operand;
		default: return value;
	}
}

function rawCharacteristicValue(actor, characteristicId) {
	const characteristics = actor.system?.characteristics ?? {};
	const key = characteristicId === "m" && !Object.hasOwn(characteristics, "m")
		? "sp"
		: characteristicId;
	return finiteNumber(characteristics?.[key]?.current);
}

function nearlyEqual(first, second) {
	return Math.abs(finiteNumber(first) - finiteNumber(second)) <= EPSILON;
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

function formatValue(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "—";
	return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function polishRounds(count) {
	if (count === 1) return "rundę";
	const mod10 = count % 10;
	const mod100 = count % 100;
	return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)
		? "rundy"
		: "rund";
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
