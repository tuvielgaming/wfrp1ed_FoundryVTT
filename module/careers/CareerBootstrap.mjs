import {
	CAREER_CLASS,
	CAREER_DOCUMENT_TYPE,
	CAREER_ENTRY_MODE,
	CAREER_TIER,
	CareerData,
} from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/**
 * Register the audited WFRP 1e Career document contract before Career
 * progression integrations begin consuming Career Items.
 */
Hooks.once("init", () => {
	CONFIG.Item.dataModels.career = CareerData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		CareerItemSheet,
		{
			types: ["career"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		career: Object.freeze({
			...(game.WFRP1ED?.career ?? {}),
			careerClass: CAREER_CLASS,
			careerTier: CAREER_TIER,
			entryMode: CAREER_ENTRY_MODE,
			documentType: CAREER_DOCUMENT_TYPE,
		}),
	});
});
