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

let previousGetCharacteristicValue = null;

/**
 * Runtime Critical consequences such as Leg #4 are generated after the wound is
 * created and carry a system-owned round timer. Foundry can prepare the nested
 * Item ActiveEffect differently from an Actor ActiveEffect, so this bridge is a
 * final, deterministic characteristic consumer for those runtime consequences.
 *
 * It applies only a consequence which the normal RuleEffectResolver did not
 * already expose as an automatic self-effect. That keeps the bridge compatible
 * with future Foundry improvements without ever halving a characteristic twice.
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
	const targetId = `characteristic.${characteristicId}.current`;
	const resolvedCandidates = RuleEffectResolver.candidates(actor, targetId).filter((candidate) =>
		candidate.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC &&
		candidate.side === RULE_EFFECT_SIDES.SELF,
	);
	let value = finiteNumber(startingValue);

	for (const source of runtimeCharacteristicSources(actor, characteristicId)) {
		/* CriticalWoundCharacteristicEffects consumes exactly this filtered class
		 * of RuleEffectResolver candidate before this wrapper runs. A matching
		 * automatic/self candidate therefore means the value already includes it. */
		if (resolvedCandidates.some((candidate) =>
			String(candidate.itemUuid ?? "") === String(source.wound.uuid ?? "") &&
			String(candidate.targetId ?? "") === targetId
		)) continue;

		value = applyOperation(value, source.entry.operation, source.entry.value);
	}

	return value;
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
