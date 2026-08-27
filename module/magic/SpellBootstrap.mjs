import {
	SPELL_COST_INTERVAL,
	SPELL_TRADITION,
	SpellData,
} from "../data-models/item/SpellData.mjs";
import { SpellItemSheet } from "../sheets/SpellItemSheet.mjs";
import "../tests/TestResultOwnerAdjudicationIntegration.mjs";
import "./FireBallVulnerabilitySync.mjs";
import {
	FireBallProcedure,
	installFireBallPresentation,
} from "./FireBallProcedureV2.mjs";
import { installFireBallTargetingDialogIntegration } from "./FireBallTargetingDialogIntegration.mjs";
import { SpellProcedureRegistry } from "./SpellProcedureRegistry.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/** Register the rulebook-backed Spell document and its authoring sheet. */
Hooks.once("init", () => {
	CONFIG.Item.dataModels.spell = SpellData;
	SpellProcedureRegistry.register(FireBallProcedure);
	installFireBallPresentation();
	installFireBallTargetingDialogIntegration();

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		SpellItemSheet,
		{
			types: ["spell"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		magic: Object.freeze({
			...(game.WFRP1ED?.magic ?? {}),
			spellTradition: SPELL_TRADITION,
			spellCostInterval: SPELL_COST_INTERVAL,
			spellProcedures: SpellProcedureRegistry,
		}),
	});
});