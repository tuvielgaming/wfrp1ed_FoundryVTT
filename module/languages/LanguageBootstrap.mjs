import { LanguageData } from "../data-models/item/LanguageData.mjs";
import { LanguageItemSheet } from "../sheets/LanguageItemSheet.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

Hooks.once("init", () => {
	CONFIG.Item.dataModels.language = LanguageData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		LanguageItemSheet,
		{
			types: ["language"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		language: Object.freeze({
			...(game.WFRP1ED?.language ?? {}),
			canonicalIdentity,
		}),
	});
});

export function canonicalIdentity(language) {
	if (language?.type !== "language") return "";
	const rulesId = normalize(language.system?.rulesId);
	return rulesId || normalize(language.name);
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}
