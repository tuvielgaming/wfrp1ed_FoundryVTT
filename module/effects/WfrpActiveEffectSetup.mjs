import { WFRP_RULE_CHANGE_TYPE } from "./RuleEffectRegistry.mjs";

export const WFRP_ACTIVE_EFFECT_TYPE = "wfrp";

/**
 * WFRP-owned Active Effect type data.
 *
 * Foundry v14 moved effect changes into ActiveEffect.system.changes and
 * provides ActiveEffectTypeDataModel as the canonical persisted schema for
 * those changes. WFRP inherits that schema unchanged; our custom rule change
 * vocabulary remains declarative and is consumed by WFRP subsystems.
 */
export class WfrpActiveEffectData extends foundry.data.ActiveEffectTypeDataModel {}

Hooks.once("init", () => {
	CONFIG.ActiveEffect.dataModels[WFRP_ACTIVE_EFFECT_TYPE] =
		WfrpActiveEffectData;
	CONFIG.ActiveEffect.defaultType = WFRP_ACTIVE_EFFECT_TYPE;
});

/**
 * Effects authored before the WFRP subtype existed may still be `type: base`.
 * Foundry v14 does not permit changing a typed Document's `type` unless its
 * paired `system` field is replaced in the same update with a
 * ForcedReplacement operator. Convert the rule-save update into that exact
 * transaction instead of attempting an ordinary partial system update.
 */
Hooks.on("preUpdateActiveEffect", (effect, updateData) => {
	if (effect?.type === WFRP_ACTIVE_EFFECT_TYPE) {
		return;
	}

	const changes = readUpdatedChanges(updateData);

	if (!containsWfrpRuleChange(changes)) {
		return;
	}

	const replacementSystem = foundry.utils.deepClone(
		effect?.system?.toObject?.() ?? {},
	);
	replacementSystem.changes = foundry.utils.deepClone(changes);

	/*
	 * Remove the partial/dotted update before replacing `system` wholesale.
	 * The two forms must not compete in the same differential payload.
	 */
	delete updateData["system.changes"];

	updateData.type = WFRP_ACTIVE_EFFECT_TYPE;
	updateData.system =
		foundry.data.operators.ForcedReplacement.create(
			replacementSystem,
		);
});

function readUpdatedChanges(updateData) {
	const direct = updateData?.["system.changes"];

	if (Array.isArray(direct)) {
		return direct;
	}

	const nested = updateData?.system?.changes;

	return Array.isArray(nested)
		? nested
		: [];
}

function containsWfrpRuleChange(changes) {
	return changes.some(
		(change) => String(change?.type ?? "") === WFRP_RULE_CHANGE_TYPE,
	);
}
