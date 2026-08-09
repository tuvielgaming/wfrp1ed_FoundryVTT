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
