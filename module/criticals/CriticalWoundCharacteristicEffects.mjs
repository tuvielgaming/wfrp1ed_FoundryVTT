import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import {
	encodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";
import {
	ensureCoreDetailedCriticalTables,
	isCoreDetailedEffectProvider,
} from "./CoreDetailedCriticalTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const TABLE_RESULT_FLAG_KEY = "detailedCriticalEffect";
const CRITICAL_WOUND_TYPE = "criticalWound";

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);
const CHARACTERISTIC_ALIASES = Object.freeze({ sp: "m" });

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
	void synchronizeCoreCharacteristicEffect(item).catch(reportEffectError);
});

Hooks.on("updateItem", (item) => {
	if (item?.type !== CRITICAL_WOUND_TYPE) return;
	void synchronizeCoreCharacteristicEffect(item).catch(reportEffectError);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void repairExistingCoreCharacteristicEffects().catch(reportEffectError);
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
		: finiteNumber(knownBase, `characteristics.${canonicalId}.current`);
	const targetId = characteristicTargetId(canonicalId);
	const generic = RuleEffectResolver.candidates(actor, targetId).filter((candidate) =>
		candidate.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC &&
		candidate.side === RULE_EFFECT_SIDES.SELF,
	);
	const candidates = [
		...generic,
		...managedCoreWoundCandidates(actor, canonicalId, targetId, generic),
	];

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

function managedCoreWoundCandidates(actor, characteristicId, targetId, existing) {
	if (!(actor instanceof foundry.documents.Actor)) return [];
	const results = [];

	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;
		if (!isCoreDetailedEffectProvider(wound.system?.resolution?.providerId)) continue;
		const definition = coreConsequenceForWound(wound);
		const entry = definition?.effects?.find((effect) => effect.characteristicId === characteristicId);
		if (!entry) continue;

		const managedEffect = [...(wound.effects ?? [])].find((effect) => {
			const flag = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
			return Boolean(flag) &&
				Number(flag.effectNumber) === definition.effectNumber &&
				String(flag.location ?? "") === definition.location;
		}) ?? null;
		if (!managedEffect || managedEffect.disabled === true || managedEffect.duration?.expired === true) continue;

		if (existing.some((candidate) =>
			String(candidate.itemUuid ?? "") === String(wound.uuid ?? "") &&
			String(candidate.targetId ?? "") === targetId
		)) continue;

		results.push(Object.freeze({
			id: `core-critical:${wound.uuid}:${managedEffect.id}:${characteristicId}`,
			targetId,
			operation: entry.operation,
			formula: String(entry.value),
			applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			side: RULE_EFFECT_SIDES.SELF,
			stacking: "per-acquisition",
			condition: localize(
				"Until medical attention is received",
				"Do czasu otrzymania pomocy medycznej",
			),
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

async function repairExistingCoreCharacteristicEffects() {
	await ensureCoreDetailedCriticalTables();
	for (const actor of game.actors ?? []) {
		let touched = false;
		for (const item of actor.items ?? []) {
			if (item.type !== CRITICAL_WOUND_TYPE) continue;
			const before = item.effects?.size ?? item.effects?.length ?? 0;
			await synchronizeCoreCharacteristicEffect(item);
			const after = item.effects?.size ?? item.effects?.length ?? 0;
			touched ||= before !== after;
		}
		if (touched) refreshActorSheetIfOpen(actor);
	}
}

async function synchronizeCoreCharacteristicEffect(wound) {
	if (wound?.documentName !== "Item" || wound.type !== CRITICAL_WOUND_TYPE) return null;

	const managed = [...(wound.effects ?? [])].filter((effect) =>
		Boolean(effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY)),
	);
	const definition = isCoreDetailedEffectProvider(wound.system?.resolution?.providerId)
		? coreConsequenceForWound(wound)
		: null;
	const matching = definition
		? managed.find((effect) => {
			const flag = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
			return Number(flag?.effectNumber) === definition.effectNumber &&
				String(flag?.location ?? "") === definition.location;
		}) ?? null
		: null;

	const staleIds = managed
		.filter((effect) => effect !== matching)
		.map((effect) => effect.id)
		.filter(Boolean);
	if (staleIds.length) await wound.deleteEmbeddedDocuments("ActiveEffect", staleIds);
	if (!definition) return null;
	if (matching) return matching;

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
		img: String(wound.img || foundry.documents.ActiveEffect.DEFAULT_ICON),
		disabled: false,
		transfer: true,
		changes: foundry.utils.deepClone(changes),
		system: { changes: foundry.utils.deepClone(changes) },
		flags: {
			[FLAG_SCOPE]: {
				[RULE_CHANGES_FLAG_KEY]: foundry.utils.deepClone(changes),
				[CORE_EFFECT_FLAG_KEY]: {
					version: 1,
					location: definition.location,
					effectNumber: definition.effectNumber,
					durationKind: "until-medical-attention",
				},
			},
		},
	};
	const [created] = await wound.createEmbeddedDocuments("ActiveEffect", [source]);
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
	const direct = positiveInteger(wound.system?.resolution?.effectNumber);
	if (direct) return direct;
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
		const negative = effect.candidates.filter((candidate) => isNegativeCandidate(candidate, effect.base));
		if (!effect.candidates.length) continue;
		const key = id === "m" && !root.querySelector('[data-characteristic="m"]') ? "sp" : id;
		const cell = root.querySelector(`.characteristics-row--current [data-characteristic="${key}"]`);
		if (!cell) continue;
		setCharacteristicDisplayValue(cell, id, effect.value);
		cell.querySelector("[data-wfrp-characteristic-effect-marker]")?.remove();
		cell.removeAttribute("data-tooltip");
		cell.removeAttribute("title");
		if (!negative.length) continue;
		const tooltip = negativeTooltip(actor, id, negative);
		const marker = document.createElement("span");
		marker.className = "characteristic-current-effect-marker";
		marker.dataset.wfrpCharacteristicEffectMarker = "";
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
	const valueNode = document.createElement("span");
	valueNode.className = "characteristic-current-profile characteristic-current-profile--effective";
	valueNode.textContent = formatted;
	cell.prepend(valueNode);
}

function isNegativeCandidate(candidate, base) {
	const value = Number(candidate?.formula);
	if (!Number.isFinite(value)) return false;
	switch (candidate.operation) {
		case RULE_EFFECT_OPERATIONS.ADD: return value < 0;
		case RULE_EFFECT_OPERATIONS.SUBTRACT: return value > 0;
		case RULE_EFFECT_OPERATIONS.MULTIPLY: return value >= 0 && value < 1;
		case RULE_EFFECT_OPERATIONS.OVERRIDE: return value < Number(base);
		default: return false;
	}
}

function negativeTooltip(actor, characteristicId, candidates) {
	return candidates.map((candidate) => {
		const source = briefEffectSource(actor, candidate);
		return `${source} — ${characteristicLabel(characteristicId)} ${negativeOperationLabel(candidate)}`;
	}).join("\n");
}

function briefEffectSource(actor, candidate) {
	const item = documentFromUuidSync(candidate.itemUuid);
	if (item?.type === CRITICAL_WOUND_TYPE && item.parent?.uuid === actor.uuid) {
		return localize(
			`${hitLocationLabel(item.system?.hitLocation)} Critical Wound`,
			`Rana krytyczna: ${hitLocationLabel(item.system?.hitLocation)}`,
		);
	}
	return String(candidate.itemName ?? candidate.effectName ?? localize("Active Effect", "Aktywny efekt")).trim();
}

function negativeOperationLabel(candidate) {
	const value = Number(candidate?.formula);
	if (candidate.operation === RULE_EFFECT_OPERATIONS.MULTIPLY && value === 0.5) {
		return localize("halved", "zmniejszona o połowę");
	}
	if (candidate.operation === RULE_EFFECT_OPERATIONS.SUBTRACT) {
		return localize(`reduced by ${formatCharacteristicValue(value)}`, `zmniejszona o ${formatCharacteristicValue(value)}`);
	}
	if (candidate.operation === RULE_EFFECT_OPERATIONS.ADD && value < 0) {
		return localize(`reduced by ${formatCharacteristicValue(Math.abs(value))}`, `zmniejszona o ${formatCharacteristicValue(Math.abs(value))}`);
	}
	if (candidate.operation === RULE_EFFECT_OPERATIONS.MULTIPLY) {
		return localize(`multiplied by ${formatCharacteristicValue(value)}`, `pomnożona przez ${formatCharacteristicValue(value)}`);
	}
	if (candidate.operation === RULE_EFFECT_OPERATIONS.OVERRIDE) {
		return localize(`set to ${formatCharacteristicValue(value)}`, `ustawiona na ${formatCharacteristicValue(value)}`);
	}
	return String(candidate?.formula ?? "");
}

function characteristicLabel(id) {
	const labels = {
		en: {
			m: "Movement", ws: "Weapon Skill", bs: "Ballistic Skill", s: "Strength",
			t: "Toughness", w: "Wounds", i: "Initiative", a: "Attacks",
			dex: "Dexterity", ld: "Leadership", int: "Intelligence", cl: "Cool",
			wp: "Will Power", fel: "Fellowship",
		},
		pl: {
			m: "Szybkość", ws: "Walka Wręcz", bs: "Umiejętności Strzeleckie", s: "Siła",
			t: "Wytrzymałość", w: "Żywotność", i: "Inicjatywa", a: "Atak",
			dex: "Zręczność", ld: "Cechy Przywódcze", int: "Inteligencja", cl: "Opanowanie",
			wp: "Siła Woli", fel: "Ogłada",
		},
	};
	return labels[game.i18n.lang === "pl" ? "pl" : "en"]?.[id] ?? id;
}

function hitLocationLabel(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "head": return localize("Head", "Głowa");
		case "rightArm": return localize("Right arm", "Prawa ręka");
		case "leftArm": return localize("Left arm", "Lewa ręka");
		case "arm": return localize("Arm", "Ręka");
		case "body": return localize("Body", "Korpus");
		case "rightLeg": return localize("Right leg", "Prawa noga");
		case "leftLeg": return localize("Left leg", "Lewa noga");
		case "leg": return localize("Leg", "Noga");
		default: return localize("Critical injury", "Rana krytyczna");
	}
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

function refreshCriticalEffectActor(effect) {
	const item = effect?.parent;
	const actor = item?.parent;
	if (item?.type !== CRITICAL_WOUND_TYPE || !(actor instanceof foundry.documents.Actor)) return;
	requestAnimationFrame(() => refreshActorSheetIfOpen(actor));
}

function refreshActorSheetIfOpen(actor) {
	const sheet = actor?.sheet;
	if (!sheet?.rendered) return;
	void sheet.render();
}

function halfMovementAndInitiativeUntilMedicalAttention() {
	return Object.freeze([
		Object.freeze({ characteristicId: "m", operation: RULE_EFFECT_OPERATIONS.MULTIPLY, value: 0.5 }),
		Object.freeze({ characteristicId: "i", operation: RULE_EFFECT_OPERATIONS.MULTIPLY, value: 0.5 }),
	]);
}

function effectLocation(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "rightLeg":
		case "leftLeg":
		case "leg": return "leg";
		case "rightArm":
		case "leftArm":
		case "arm": return "arm";
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
	if (!CHARACTERISTIC_IDS.includes(canonical)) throw new Error(`Unknown WFRP characteristic '${id}'.`);
	return canonical;
}

function baseCharacteristicValue(actor, id) {
	const characteristic = actor.system?.characteristics?.[id] ??
		(id === "m" ? actor.system?.characteristics?.sp : null);
	return finiteNumber(characteristic?.current, `characteristics.${id}.current`);
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
	return number;
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function formatCharacteristicValue(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "—";
	return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100);
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
	console.error("WFRP1ED | Unable to synchronize a Core Critical Wound Active Effect.", error);
	ui.notifications.warn(error?.message ?? localize(
		"A Critical Wound exists, but its automatic characteristic effect could not be synchronized.",
		"Rana krytyczna istnieje, ale nie udało się zsynchronizować jej automatycznego wpływu na cechy.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
