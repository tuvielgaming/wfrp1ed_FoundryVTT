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
 * Older effects authored before the WFRP ActiveEffect subtype existed may be
 * type "base". When a WFRP rule change is next saved, migrate that effect to
 * the WFRP subtype in the same database update so system.changes is persisted
 * by the declared system data contract.
 */
Hooks.on("preUpdateActiveEffect", (effect, updateData) => {
	const changes = readUpdatedChanges(updateData);

	if (!containsWfrpRuleChange(changes)) {
		return;
	}

	if (effect?.type !== WFRP_ACTIVE_EFFECT_TYPE) {
		updateData.type = WFRP_ACTIVE_EFFECT_TYPE;
	}
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
