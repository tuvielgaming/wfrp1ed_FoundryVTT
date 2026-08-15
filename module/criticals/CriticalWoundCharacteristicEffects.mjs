import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import {
	encodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";
import { isCoreDetailedEffectProvider } from "./CoreDetailedCriticalTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const TABLE_RESULT_FLAG_KEY = "detailedCriticalEffect";
const CRITICAL_WOUND_TYPE = "criticalWound";

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);
const CHARACTERISTIC_ALIASES = Object.freeze({ sp: "m" });

/*
 * Deterministic Core critical consequences which can be represented safely by
 * the current characteristic-effect contract without inventing treatment,
 * bleeding, prone, limb-use, or duration state machines.
 *
 * Core detailed leg effects #5, #6 and #7 all halve Movement and Initiative
 * until medical attention. Their exact English/Polish source text is already
 * audited in CoreDetailedCriticalTables.mjs (Combat, printed pp. 122-124).
 *
 * Leg #4 also halves M/I but only for D4 rounds. It is intentionally NOT added
 * here until round-duration ActiveEffect expiration is authoritative, because
 * an indefinite penalty would be mechanically wrong.
 */
const CORE_CHARACTERISTIC_EFFECTS = Object.freeze({
	leg: Object.freeze({
		5: halfMovementAndInitiativeUntilMedicalAttention(),
		6: halfMovementAndInitiativeUntilMedicalAttention(),
		7: halfMovementAndInitiativeUntilMedicalAttention(),
	}),
});

let originalGetCharacteristicValue = null;

Hooks.once("init", () => {
	registerCharacteristicEffectTargets();
	installCharacteristicValueResolver();
});

Hooks.on("createItem", (item, _options, userId) => {
	if (
		item?.type !== CRITICAL_WOUND_TYPE ||
		String(userId ?? "") !== String(game.user?.id ?? "")
	) return;

	void ensureCoreCharacteristicEffect(item).catch(reportEffectError);
});

Hooks.once("ready", () => {
	/* Repair previously-created Core wounds once, using one authoritative GM. */
	if (!isPrimaryActiveGm()) return;
	void ensureExistingCoreCharacteristicEffects().catch(reportEffectError);
});

for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
	Hooks.on(hook, (effect) => refreshCriticalEffectActor(effect));
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
			labels: {
				pl: `Aktualna cecha ${id === "m" ? "Sz" : id}`,
			},
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

/**
 * Resolve every active automatic self-effect which targets one current value.
 * The persistent Initial/Purchased/Career profile is never mutated.
 */
function effectiveCharacteristic(actor, id, knownBase = undefined) {
	const canonicalId = canonicalCharacteristicId(id);
	const base = knownBase === undefined
		? baseCharacteristicValue(actor, canonicalId)
		: finiteNumber(knownBase, `characteristics.${canonicalId}.current`);
	const candidates = RuleEffectResolver.candidates(
		actor,
		characteristicTargetId(canonicalId),
	).filter((candidate) =>
		candidate.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC &&
		candidate.side === RULE_EFFECT_SIDES.SELF,
	);

	let value = base;
	const applied = [];
	for (const candidate of candidates) {
		const operand = Number(candidate.formula);
		if (!Number.isFinite(operand)) continue;

		switch (candidate.operation) {
			case RULE_EFFECT_OPERATIONS.ADD:
				value += operand;
				break;
			case RULE_EFFECT_OPERATIONS.SUBTRACT:
				value -= operand;
				break;
			case RULE_EFFECT_OPERATIONS.MULTIPLY:
				value *= operand;
				break;
			case RULE_EFFECT_OPERATIONS.OVERRIDE:
				value = operand;
				break;
			default:
				continue;
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

async function ensureExistingCoreCharacteristicEffects() {
	for (const actor of game.actors ?? []) {
		for (const item of actor.items ?? []) {
			if (item.type !== CRITICAL_WOUND_TYPE) continue;
			await ensureCoreCharacteristicEffect(item);
		}
	}
}

async function ensureCoreCharacteristicEffect(wound) {
	if (
		wound?.documentName !== "Item" ||
		wound.type !== CRITICAL_WOUND_TYPE ||
		!isCoreDetailedEffectProvider(wound.system?.resolution?.providerId)
	) return null;

	const definition = coreConsequenceForWound(wound);
	if (!definition) return null;

	const existing = [...(wound.effects ?? [])].find((effect) => {
		const flag = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
		return Number(flag?.effectNumber) === definition.effectNumber &&
			String(flag?.location ?? "") === definition.location;
	});
	if (existing) return existing;

	const changes = definition.effects.map((entry) =>
		encodeRuleEffectChange({
			targetId: characteristicTargetId(entry.characteristicId),
			operation: entry.operation,
			formula: String(entry.value),
			applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			side: RULE_EFFECT_SIDES.SELF,
			stacking: "per-acquisition",
			condition: localize(
				"Until medical attention is received",
				"Do czasu otrzymania pomocy medycznej",
			),
		}),
	);
	const source = {
		name: localize(
			"Critical Wound — Movement and Initiative halved",
			"Rana krytyczna — Szybkość i Inicjatywa o połowę",
		),
		img: String(
			wound.img || foundry.documents.ActiveEffect.DEFAULT_ICON,
		),
		disabled: false,
		transfer: true,
		system: { changes },
		flags: {
			[FLAG_SCOPE]: {
				[CORE_EFFECT_FLAG_KEY]: {
					version: 1,
					location: definition.location,
					effectNumber: definition.effectNumber,
					durationKind: "until-medical-attention",
				},
			},
		},
	};

	const [created] = await wound.createEmbeddedDocuments(
		"ActiveEffect",
		[source],
	);
	return created ?? null;
}

function coreConsequenceForWound(wound) {
	const location = effectLocation(wound.system?.hitLocation);
	const effectNumber = coreEffectNumber(wound);
	const effects = CORE_CHARACTERISTIC_EFFECTS[location]?.[effectNumber];
	if (!effects) return null;
	return { location, effectNumber, effects };
}

function coreEffectNumber(wound) {
	const tableUuid = String(wound.system?.resolution?.tableUuid ?? "").trim();
	const resultId = String(wound.system?.resolution?.tableResultId ?? "").trim();
	if (!tableUuid || !resultId) return 0;

	try {
		const table = foundry.utils.fromUuidSync(tableUuid);
		const result = table?.results?.get?.(resultId) ??
			[...(table?.results ?? [])].find((entry) => String(entry.id) === resultId);
		const flag = result?.getFlag?.(FLAG_SCOPE, TABLE_RESULT_FLAG_KEY);
		return positiveInteger(flag?.effectNumber);
	} catch (_error) {
		return 0;
	}
}

function decorateAffectedCharacteristics(actor, root) {
	for (const id of CHARACTERISTIC_IDS) {
		const effect = effectiveCharacteristic(actor, id);
		if (!effect.candidates.length) continue;

		const key = id === "m" && !root.querySelector('[data-characteristic="m"]')
			? "sp"
			: id;
		const cell = root.querySelector(
			`.characteristics-row--current [data-characteristic="${key}"]`,
		);
		if (!cell) continue;

		setCharacteristicDisplayValue(cell, id, effect.value);
		cell.querySelector("[data-wfrp-characteristic-effect-marker]")?.remove();

		const marker = document.createElement("span");
		marker.className = "characteristic-current-effect-marker";
		marker.dataset.wfrpCharacteristicEffectMarker = "";
		marker.textContent = "!";
		marker.title = effectTooltip(effect);
		marker.dataset.tooltip = marker.title;
		marker.setAttribute("aria-label", marker.title);
		cell.append(marker);
	}
}

function setCharacteristicDisplayValue(cell, id, value) {
	const formatted = formatCharacteristicValue(value);
	const profile = cell.querySelector(".characteristic-current-profile");
	if (profile) {
		profile.textContent = formatted;
		return;
	}

	/* Wounds and Attacks own richer resource UI; current Core wound mappings do not target them. */
	if (id === "w" || id === "a") return;

	for (const node of [...cell.childNodes]) {
		if (node.nodeType === Node.TEXT_NODE) node.remove();
	}
	const valueNode = document.createElement("span");
	valueNode.className = "characteristic-current-profile characteristic-current-profile--effective";
	valueNode.textContent = formatted;
	cell.prepend(valueNode);
}

function effectTooltip(effect) {
	const lines = [localize(
		`Base value: ${formatCharacteristicValue(effect.base)} · Current effective value: ${formatCharacteristicValue(effect.value)}`,
		`Wartość bazowa: ${formatCharacteristicValue(effect.base)} · Aktualna wartość efektywna: ${formatCharacteristicValue(effect.value)}`,
	)];

	for (const candidate of effect.candidates) {
		const source = [candidate.itemName, candidate.effectName]
			.map((value) => String(value ?? "").trim())
			.filter(Boolean)
			.join(" — ");
		lines.push(`${source || localize("Active Effect", "Aktywny Efekt")}: ${operationLabel(candidate)}`);
		if (candidate.condition) lines.push(String(candidate.condition));
	}
	return lines.join("\n");
}

function operationLabel(candidate) {
	const value = String(candidate.formula ?? "");
	switch (candidate.operation) {
		case RULE_EFFECT_OPERATIONS.ADD: return `+${value}`;
		case RULE_EFFECT_OPERATIONS.SUBTRACT: return `−${value}`;
		case RULE_EFFECT_OPERATIONS.MULTIPLY: return `×${value}`;
		case RULE_EFFECT_OPERATIONS.OVERRIDE: return `=${value}`;
		default: return value;
	}
}

function refreshCriticalEffectActor(effect) {
	const item = effect?.parent;
	const actor = item?.parent;
	if (
		item?.type !== CRITICAL_WOUND_TYPE ||
		!(actor instanceof foundry.documents.Actor)
	) return;

	requestAnimationFrame(() => {
		void actor.sheet?.render?.({ force: true });
	});
}

function halfMovementAndInitiativeUntilMedicalAttention() {
	return Object.freeze([
		Object.freeze({
			characteristicId: "m",
			operation: RULE_EFFECT_OPERATIONS.MULTIPLY,
			value: 0.5,
		}),
		Object.freeze({
			characteristicId: "i",
			operation: RULE_EFFECT_OPERATIONS.MULTIPLY,
			value: 0.5,
		}),
	]);
}

function effectLocation(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "rightLeg":
		case "leftLeg":
			return "leg";
		case "rightArm":
		case "leftArm":
			return "arm";
		case "head": return "head";
		case "body": return "body";
		default: return "";
	}
}

function characteristicTargetId(id) {
	return `characteristic.${canonicalCharacteristicId(id)}.current`;
}

function canonicalCharacteristicId(id) {
	const normalized = String(id ?? "").trim().toLowerCase();
	const canonical = CHARACTERISTIC_ALIASES[normalized] ?? normalized;
	if (!CHARACTERISTIC_IDS.includes(canonical)) {
		throw new Error(`Unknown WFRP characteristic '${id}'.`);
	}
	return canonical;
}

function baseCharacteristicValue(actor, id) {
	const characteristic = actor.system?.characteristics?.[id] ??
		(id === "m" ? actor.system?.characteristics?.sp : null);
	return finiteNumber(
		characteristic?.current,
		`characteristics.${id}.current`,
	);
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return number;
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function formatCharacteristicValue(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "—";
	return Number.isInteger(number)
		? String(number)
		: String(Math.round(number * 100) / 100);
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return Boolean(game.user?.isGM && primaryActiveGm()?.id === game.user.id);
}

function reportEffectError(error) {
	console.error(
		"WFRP1ED | Unable to materialize a Core Critical Wound Active Effect.",
		error,
	);
	ui.notifications.warn(error?.message ?? localize(
		"A Critical Wound was applied, but its automatic characteristic effect could not be created.",
		"Rana krytyczna została zastosowana, ale nie udało się utworzyć jej automatycznego wpływu na cechy.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
