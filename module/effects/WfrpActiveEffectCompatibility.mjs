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
 * wfrp1ed.mjs registers the custom change type during init. Foundry v14 also
 * materializes a runtime ActiveEffect.CHANGE_TYPES registry used by the native
 * sheet renderer. Update both registries when possible; WfrpActiveEffectSheet
 * additionally contains a narrow DOM fallback for worlds/builds where the
 * runtime registry is immutable.
 */
Hooks.once("ready", () => {
	const configured = CONFIG.ActiveEffect.changeTypes[WFRP_RULE_CHANGE_TYPE];
	if (!configured) {
		console.error(
			"WFRP1ED | WFRP Rule ActiveEffect change type was not registered.",
		);
		return;
	}

	const rendered = {
		...configured,
		render: renderWfrpRuleChange,
	};
	CONFIG.ActiveEffect.changeTypes[WFRP_RULE_CHANGE_TYPE] = rendered;

	const runtime = foundry.documents.ActiveEffect.CHANGE_TYPES;
	if (!runtime || typeof runtime !== "object") return;

	try {
		const current = runtime[WFRP_RULE_CHANGE_TYPE] ?? rendered;
		runtime[WFRP_RULE_CHANGE_TYPE] = {
			...current,
			render: renderWfrpRuleChange,
		};
	} catch (error) {
		/* Some Foundry builds expose the materialized registry as immutable. The
		 * custom sheet's render-time fallback still presents a safe editable WFRP
		 * row, so this is diagnostic rather than a user-facing failure. */
		console.debug(
			"WFRP1ED | Runtime ActiveEffect change registry is immutable; using sheet renderer fallback.",
			error,
		);
	}
});
