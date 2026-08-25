import {
	DAMAGE_AMOUNT_MODIFIER_TARGET_ID,
	DAMAGE_ARMOUR_PENETRATION_TARGET_ID,
	DAMAGE_IGNORE_ARMOUR_TARGET_ID,
	DAMAGE_IGNORE_TOUGHNESS_TARGET_ID,
} from "./DamageRuleEffects.mjs";

/**
 * Group resolved damage-rule changes by their exact Item and Active Effect.
 *
 * Combat transactions already persist the immutable rule audit entries. This
 * presentation layer keeps chat truthful to that snapshot: the Item name is a
 * section heading and each embedded Active Effect is shown once with all of
 * its resolved mechanical changes.
 *
 * @param {Object[]} entries
 * @returns {readonly Object[]}
 */
export function damageRuleEffectGroups(entries = []) {
	const sources = new Map();

	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry !== "object") continue;
		const result = damageRuleResultLabel(entry);
		if (!result) continue;

		const sourceKind = text(entry.sourceKind) || "item";
		const sourceName = text(entry.sourceName) || sourceKindLabel(sourceKind);
		const sourceKey = [sourceKind, text(entry.sourceUuid), sourceName].join("|");
		let source = sources.get(sourceKey);
		if (!source) {
			source = {
				sourceKind,
				sourceName,
				effects: new Map(),
			};
			sources.set(sourceKey, source);
		}

		const effectName = text(entry.effectName) || localize(
			"Active Effect",
			"Aktywny Efekt",
		);
		const effectKey = [text(entry.effectId), effectName].join("|");
		let effect = source.effects.get(effectKey);
		if (!effect) {
			effect = { effectName, results: [] };
			source.effects.set(effectKey, effect);
		}
		if (!effect.results.includes(result)) effect.results.push(result);
	}

	return Object.freeze([...sources.values()].map((source) => Object.freeze({
		sourceKind: source.sourceKind,
		sourceName: source.sourceName,
		effects: Object.freeze([...source.effects.values()].map((effect) =>
			Object.freeze({
				effectName: effect.effectName,
				valueLabel: effect.results.join(" · "),
			})
		)),
	})));
}

export function damageRuleSourceHeading(sourceName) {
	const name = text(sourceName) || sourceKindLabel("item");
	return localize(
		`Active Effects — ${name}`,
		`Aktywne Efekty — ${name}`,
	);
}

function damageRuleResultLabel(entry) {
	const targetId = text(entry.resolvedTargetId || entry.targetId);
	switch (targetId) {
		case DAMAGE_AMOUNT_MODIFIER_TARGET_ID:
			return signedNumber(entry.value);
		case DAMAGE_ARMOUR_PENETRATION_TARGET_ID:
			return localize(
				`Armour penetration ${formatNumber(entry.value)}`,
				`Przebicie pancerza ${formatNumber(entry.value)}`,
			);
		case DAMAGE_IGNORE_ARMOUR_TARGET_ID:
			return localize("Ignores Armour", "Pomija Pancerz");
		case DAMAGE_IGNORE_TOUGHNESS_TARGET_ID:
			return localize("Ignores Toughness", "Pomija Wytrzymałość");
		default:
			return "";
	}
}

function sourceKindLabel(kind) {
	switch (kind) {
		case "weapon": return localize("Weapon", "Broń");
		case "ammunition": return localize("Ammunition", "Amunicja");
		default: return localize("Item", "Przedmiot");
	}
}

function signedNumber(value) {
	const number = finiteNumber(value);
	return `${number >= 0 ? "+" : ""}${formatNumber(number)}`;
}

function formatNumber(value) {
	const number = finiteNumber(value);
	return Number.isInteger(number)
		? String(number)
		: String(Math.round(number * 100) / 100);
}

function finiteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function text(value) {
	return String(value ?? "").trim();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
