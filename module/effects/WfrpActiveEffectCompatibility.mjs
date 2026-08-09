export const WFRP_ACTIVE_EFFECT_TYPE = "wfrp";

/**
 * Compatibility data model for ActiveEffects which were persisted as type
 * `wfrp` during the v14 persistence experiment.
 *
 * This module exists so existing world data remains loadable. It deliberately
 * does not make `wfrp` the default ActiveEffect type and does not migrate or
 * mutate any documents.
 */
export class WfrpActiveEffectData extends foundry.data.ActiveEffectTypeDataModel {}

Hooks.once("init", () => {
	CONFIG.ActiveEffect.dataModels[WFRP_ACTIVE_EFFECT_TYPE] =
		WfrpActiveEffectData;
});
