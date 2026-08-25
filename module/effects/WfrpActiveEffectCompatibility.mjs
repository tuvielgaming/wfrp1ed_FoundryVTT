import {
	WFRP_RULE_CHANGE_TYPE,
} from "./RuleEffectRegistry.mjs";
import {
	renderWfrpRuleChange,
	WfrpActiveEffectSheet,
} from "../sheets/WfrpActiveEffectSheet.mjs";

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

	/*
	 * Keep Foundry's native ActiveEffectConfig behavior, but use our thin v14
	 * subclass as the system default so the editor is wide/resizable and can
	 * host the guided WFRP Rule workflow.
	 */
	foundry.applications.apps.DocumentSheetConfig.registerSheet(
		foundry.documents.ActiveEffect,
		game.system.id,
		WfrpActiveEffectSheet,
		{
			makeDefault: true,
			label: "WFRP1ED Active Effect",
		},
	);
});

/*
 * wfrp1ed.mjs registers the custom change type during init. Attach the native
 * v14 per-change renderer after initialization is complete, before users can
 * open the world UI. Replacing the config record avoids mutating another
 * package's frozen object if Foundry ever normalizes change-type definitions.
 */
Hooks.once("ready", () => {
	const current = CONFIG.ActiveEffect.changeTypes[WFRP_RULE_CHANGE_TYPE];
	if (!current) {
		console.error(
			"WFRP1ED | WFRP Rule ActiveEffect change type was not registered.",
		);
		return;
	}

	CONFIG.ActiveEffect.changeTypes[WFRP_RULE_CHANGE_TYPE] = {
		...current,
		render: renderWfrpRuleChange,
	};
});
