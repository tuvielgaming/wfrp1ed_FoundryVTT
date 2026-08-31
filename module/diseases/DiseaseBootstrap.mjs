import { DiseaseData } from "../data-models/item/DiseaseData.mjs";
import { DiseaseItemSheet } from "../sheets/DiseaseItemSheet.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

Hooks.once("init", () => {
	CONFIG.Item.dataModels.disease = DiseaseData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		DiseaseItemSheet,
		{
			types: ["disease"],
			makeDefault: true,
		},
	);
});
