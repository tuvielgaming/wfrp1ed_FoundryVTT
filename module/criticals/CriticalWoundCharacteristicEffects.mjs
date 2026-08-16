import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import {
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";
import { criticalConsequenceForWound } from "./CriticalConsequenceDefinition.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";
const EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const LEGACY_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const TIMED_FLAG_KEY = "criticalTimed";
const CRITICAL_WOUND_TYPE = "criticalWound";

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);
const CHARACTERISTIC_ALIASES = Object.freeze({ sp: "m" });

let originalGetCharacteristicValue = null;

/**
 * One characteristic-effect consumer for every WFRP rule source.
 *
 * Critical Wounds are not special-cased by result number here. Core wounds and
 * user-authored wounds declare the same `system.consequence.characteristics`
 * data and are consumed through the same path. Native/manual ActiveEffects from
 * Skills, equipment, spells, etc. continue to come from RuleEffectResolver.
 */
Hooks.once("init", () => {
	registerCharacteristicEffectTargets();
	installCharacteristicValueResolver();
});

for (const hook of [
	"createItem", "updateItem", "deleteItem",
	"createActiveEffect", "updateActiveEffect", "deleteActiveEffect",
]) {
	Hooks.on(hook, (document) => refreshAffectedActor(document));
}

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		!(actor instanceof foundry.documents.Actor) ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;
	decorateAffectedCharacteristics(actor, element);
});

function registerCharacteristicEffectTargets() {
	for (const id of CHARACTERISTIC_IDS) {
		RuleEffectRegistry.registerTarget({
			id: characteristicTargetId(id),
			category: "characteristic-current",
			label: `Current ${id}`,
			labels: { pl: `Aktualna cecha ${id === "m" ? "Sz" : id}` },
			sides: [RULE_EFFECT_SIDES.SELF],
			operations: [
				RULE_EFFECT_OPERATIONS.ADD,
				RULE_EFFECT_OPERATIONS.SUBTRACT,
				RULE_EFFECT_OPERATIONS.MULTIPLY,
				RULE_EFFECT_OPERATIONS.OVERRIDE,
			],
			metadata: {
				consumer: "characteristic-current",
				characteristicId: id,
			},
		});
	}
}

function installCharacteristicValueResolver() {
	if (originalGetCharacteristicValue) return;
	originalGetCharacteristicValue = Wfrp1edActor.prototype.getCharacteristicValue;
	Wfrp1edActor.prototype.getCharacteristicValue = function getCharacteristicValueWithEffects(id) {
		const base = originalGetCharacteristicValue.call(this, id);
		return effectiveCharacteristic(this, id, base).value;
	};
}

function effectiveCharacteristic(actor, id, knownBase = undefined) {
	const canonicalId = canonicalCharacteristicId(id);
	const base = knownBase === undefined
		? baseCharacteristicValue(actor, canonicalId)
		: finiteNumber(knownBase);
	const targetId = characteristicTargetId(canonicalId);
	const generic = RuleEffectResolver.candidates(actor, targetId).filter((candidate) =>
		candidate.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC &&
		candidate.side === RULE_EFFECT_SIDES.SELF,
	);
	const candidates = [
		...generic,
		...managedCriticalWoundCandidates(actor, canonicalId, targetId, generic),
	].sort(compareCandidates);

	let value = base;
	const applied = [];
	for (const candidate of candidates) {
		const operand = Number(candidate.formula);
		if (!Number.isFinite(operand)) continue;
		switch (candidate.operation) {
			case RULE_EFFECT_OPERATIONS.ADD: value += operand; break;
			case RULE_EFFECT_OPERATIONS.SUBTRACT: value -= operand; break;
			case RULE_EFFECT_OPERATIONS.MULTIPLY: value *= operand; break;
			case RULE_EFFECT_OPERATIONS.OVERRIDE: value = operand; break;
			default: continue;
		}
		applied.push(candidate);
	}

	return Object.freeze({
		id: canonicalId,
		base,
		value,
		candidates: Object.freeze(applied),
	});
}

/**
 * Deterministic fallback for system-managed Critical consequence effects.
 *
 * Foundry can prepare Item-grandchild transfer effects asymmetrically: one
 * change from a multi-change effect may surface through the generic resolver
 * while another does not. This fallback reads the wound's declarative snapshot
 * and adds only the missing target. That is the class of failure which caused
 * Leg #4 Movement to halve while Initiative stayed unchanged.
 *
 * Old Core wounds created before declarative Item consequences are also accepted
 * here, but only through their existing ActiveEffect provenance. No Core result
 * number is hard-coded in this consumer.
 */
function managedCriticalWoundCandidates(actor, characteristicId, targetId, existing) {
	if (!(actor instanceof foundry.documents.Actor)) return [];
	const results = [];

	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;
		const runtime = runtimeState(wound);
		if (runtime && runtime.state !== "applied") continue;
		const definition = runtime?.definition ?? criticalConsequenceForWound(wound);
		const entry = definition?.characteristics?.find((candidate) =>
			String(candidate.characteristicId ?? "") === characteristicId,
		);
		if (!entry) continue;

		const managedEffect = [...(wound.effects ?? [])].find((effect) =>
			isManagedCharacteristicEffect(effect)
		) ?? null;
		if (!managedEffect || !managedEffectAvailable(managedEffect)) continue;

		if (existing.some((candidate) => sameManagedContribution(
			candidate,
			wound,
			managedEffect,
			targetId,
		))) continue;

		results.push(Object.freeze({
			id: `critical-consequence:${wound.uuid}:${managedEffect.id}:${characteristicId}`,
			targetId,
			operation: String(entry.operation ?? ""),
			formula: String(entry.value ?? ""),
			applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			side: RULE_EFFECT_SIDES.SELF,
			stacking: "per-acquisition",
			condition: consequenceCondition(definition),
			priority: 50,
			defaultSelected: true,
			actorUuid: actor.uuid,
			effectUuid: managedEffect.uuid,
			effectName: managedEffect.name,
			itemUuid: wound.uuid,
			itemName: wound.name,
			itemType: wound.type,
		}));
	}
	return results;
}

function isManagedCharacteristicEffect(effect) {
	if (effect?.getFlag?.(FLAG_SCOPE, EFFECT_FLAG_KEY)?.kind === "characteristics") return true;
	return Boolean(effect?.getFlag?.(FLAG_SCOPE, LEGACY_EFFECT_FLAG_KEY));
}

function sameManagedContribution(candidate, wound, effect, targetId) {
	if (String(candidate?.targetId ?? "") !== targetId) return false;
	if (String(candidate?.effectUuid ?? "") === String(effect.uuid ?? "")) return true;
	return String(candidate?.itemUuid ?? "") === String(wound.uuid ?? "") &&
		String(candidate?.effectName ?? "") === String(effect.name ?? "");
}

function managedEffectAvailable(effect) {
	if (effect?.disabled === true) return false;
	const timed = effect.getFlag?.(FLAG_SCOPE, TIMED_FLAG_KEY);
	if (timed && String(timed.units ?? "") === "rounds") {
		return positiveInteger(timed.expiredAtRound) === 0;
	}
	return effect?.duration?.expired !== true;
}

/**
 * Every active rule-driven characteristic change gets the same explicit marker.
 *
 * Permanent profile advancement already has its own Classic-sheet presentation;
 * this marker is reserved for ActiveEffect/rule contributions. Positive effects
 * are marked as deliberately as penalties so a temporarily boosted value cannot
 * be mistaken for the Actor's underlying profile.
 */
function decorateAffectedCharacteristics(actor, root) {
	for (const id of CHARACTERISTIC_IDS) {
		const effect = effectiveCharacteristic(actor, id);
		if (!effect.candidates.length) continue;
		const key = id === "m" && !root.querySelector('[data-characteristic="m"]') ? "sp" : id;
		const cell = root.querySelector(`.characteristics-row--current [data-characteristic="${key}"]`);
		if (!cell) continue;
		setCharacteristicDisplayValue(cell, id, effect.value);
		cell.querySelector("[data-wfrp-characteristic-effect-marker]")?.remove();
		cell.removeAttribute("title");

		const tooltip = effectTooltip(actor, id, effect.candidates, effect.base);
		const marker = root.ownerDocument.createElement("span");
		marker.className = "characteristic-current-effect-marker";
		marker.dataset.wfrpCharacteristicEffectMarker = "";
		marker.dataset.effectDirection = aggregateEffectDirection(effect.candidates, effect.base);
		marker.textContent = "!";
		marker.title = tooltip;
		marker.setAttribute("aria-label", tooltip);
		cell.append(marker);
		cell.title = tooltip;
	}
}

function setCharacteristicDisplayValue(cell, id, value) {
	const formatted = formatCharacteristicValue(value);
	const profile = cell.querySelector(".characteristic-current-profile");
	if (profile) {
		profile.textContent = formatted;
		return;
	}
	if (id === "w" || id === "a") return;
	for (const node of [...cell.childNodes]) {
		if (node.nodeType === Node.TEXT_NODE) node.remove();
	}
	const valueNode = cell.ownerDocument.createElement("span");
	valueNode.className = "characteristic-current-profile characteristic-current-profile--effective";
	valueNode.textContent = formatted;
	cell.prepend(valueNode);
}

function effectTooltip(actor, characteristicId, candidates, base) {
	return candidates.map((candidate) => {
		const source = briefEffectSource(actor, candidate);
		const operation = effectOperationLabel(candidate, base);
		const condition = String(candidate?.condition ?? "").trim();
		return [
			`${source} — ${characteristicLabel(characteristicId)} ${operation}`,
			condition,
		].filter(Boolean).join(" — ");
	}).join("\n");
}

function briefEffectSource(actor, candidate) {
	const item = documentFromUuidSync(candidate.itemUuid);
	if (item?.type === CRITICAL_WOUND_TYPE && item.parent?.uuid === actor.uuid) {
		return String(item.name ?? localize("Critical Wound", "Rana krytyczna"));
	}
	return String(candidate.itemName ?? candidate.effectName ?? localize("Active Effect", "Aktywny efekt")).trim();
}

function effectOperationLabel(candidate, base) {
	const value = Number(candidate?.formula);
	if (!Number.isFinite(value)) return String(candidate?.operation ?? "");

	if (candidate.operation === RULE_EFFECT_OPERATIONS.MULTIPLY) {
		if (value === 0.5) return localize("halved", "zmniejszona o połowę");
		if (value === 2) return localize("doubled", "podwojona");
		if (value === 3) return localize("tripled", "potrojona");
		return localize(
			`multiplied by ${formatCharacteristicValue(value)}`,
			`pomnożona przez ${formatCharacteristicValue(value)}`,
		);
	}

	if (candidate.operation === RULE_EFFECT_OPERATIONS.ADD) {
		if (value < 0) {
			return localize(
				`reduced by ${formatCharacteristicValue(Math.abs(value))}`,
				`zmniejszona o ${formatCharacteristicValue(Math.abs(value))}`,
			);
		}
		return localize(
			`increased by ${formatCharacteristicValue(value)}`,
			`zwiększona o ${formatCharacteristicValue(value)}`,
		);
	}

	if (candidate.operation === RULE_EFFECT_OPERATIONS.SUBTRACT) {
		if (value < 0) {
			return localize(
				`increased by ${formatCharacteristicValue(Math.abs(value))}`,
				`zwiększona o ${formatCharacteristicValue(Math.abs(value))}`,
			);
		}
		return localize(
			`reduced by ${formatCharacteristicValue(value)}`,
			`zmniejszona o ${formatCharacteristicValue(value)}`,
		);
	}

	if (candidate.operation === RULE_EFFECT_OPERATIONS.OVERRIDE) {
		return localize(
			`set to ${formatCharacteristicValue(value)} (base ${formatCharacteristicValue(base)})`,
			`ustawiona na ${formatCharacteristicValue(value)} (bazowo ${formatCharacteristicValue(base)})`,
		);
	}

	return `${candidate.operation} ${formatCharacteristicValue(value)}`;
}

function aggregateEffectDirection(candidates, base) {
	let hasPositive = false;
	let hasNegative = false;

	for (const candidate of candidates) {
		const direction = candidateDirection(candidate, base);
		if (direction === "positive") hasPositive = true;
		if (direction === "negative") hasNegative = true;
	}

	if (hasPositive && hasNegative) return "mixed";
	if (hasPositive) return "positive";
	if (hasNegative) return "negative";
	return "neutral";
}

function candidateDirection(candidate, base) {
	const value = Number(candidate?.formula);
	if (!Number.isFinite(value)) return "neutral";
	switch (candidate.operation) {
		case RULE_EFFECT_OPERATIONS.ADD:
			return value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
		case RULE_EFFECT_OPERATIONS.SUBTRACT:
			return value < 0 ? "positive" : value > 0 ? "negative" : "neutral";
		case RULE_EFFECT_OPERATIONS.MULTIPLY:
			return value > 1 ? "positive" : value >= 0 && value < 1 ? "negative" : "neutral";
		case RULE_EFFECT_OPERATIONS.OVERRIDE:
			return value > Number(base) ? "positive" : value < Number(base) ? "negative" : "neutral";
		default:
			return "neutral";
	}
}

function consequenceCondition(definition) {
	return definition?.duration?.until === "medical-attention"
		? localize("Until medical attention is received", "Do czasu otrzymania pomocy medycznej")
		: "";
}

function characteristicLabel(id) {
	const labels = {
		m: ["Movement", "Szybkość"], ws: ["Weapon Skill", "WW"], bs: ["Ballistic Skill", "US"],
		s: ["Strength", "S"], t: ["Toughness", "Wt"], w: ["Wounds", "Żw"],
		i: ["Initiative", "Inicjatywa"], a: ["Attacks", "A"], dex: ["Dexterity", "Zr"],
		ld: ["Leadership", "CP"], int: ["Intelligence", "Int"], cl: ["Cool", "Op"],
		wp: ["Will Power", "SW"], fel: ["Fellowship", "Ogd"],
	};
	return localize(...(labels[id] ?? [id, id]));
}

function runtimeState(wound) {
	const value = wound?.getFlag?.(FLAG_SCOPE, RUNTIME_FLAG_KEY);
	return value && typeof value === "object" && !Array.isArray(value)
		? foundry.utils.deepClone(value)
		: null;
}

function refreshAffectedActor(document) {
	let actor = null;
	if (document instanceof foundry.documents.Actor) actor = document;
	else if (document instanceof foundry.documents.Item) actor = document.parent;
	else if (document instanceof foundry.documents.ActiveEffect) {
		actor = document.parent instanceof foundry.documents.Actor
			? document.parent
			: document.parent?.parent;
	}
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!actor.sheet?.rendered) return;
	void actor.sheet.render();
}

function baseCharacteristicValue(actor, id) {
	const characteristics = actor.system?.characteristics ?? {};
	const key = id === "m" && !Object.hasOwn(characteristics, "m") ? "sp" : id;
	return finiteNumber(characteristics?.[key]?.current);
}

function characteristicTargetId(id) {
	return `characteristic.${id}.current`;
}

function canonicalCharacteristicId(id) {
	const normalized = String(id ?? "").trim().toLowerCase();
	return CHARACTERISTIC_ALIASES[normalized] ?? normalized;
}

function compareCandidates(first, second) {
	const firstPriority = Number.isFinite(Number(first?.priority)) ? Number(first.priority) : 50;
	const secondPriority = Number.isFinite(Number(second?.priority)) ? Number(second.priority) : 50;
	if (firstPriority !== secondPriority) return firstPriority - secondPriority;
	return String(first?.id ?? "").localeCompare(String(second?.id ?? ""));
}

function documentFromUuidSync(uuid) {
	const value = String(uuid ?? "").trim();
	if (!value) return null;
	try {
		return foundry.utils.fromUuidSync(value) ?? null;
	} catch (_error) {
		return null;
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

function formatCharacteristicValue(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "—";
	return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
