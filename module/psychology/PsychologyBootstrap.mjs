import { PsychologyData } from "../data-models/item/PsychologyData.mjs";
import { PsychologyItemSheet } from "../sheets/PsychologyItemSheet.mjs";
import "../races/RacePsychologyAuthoringIntegration.mjs";
import "./CharacterPsychologyIntegration.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

Hooks.once("init", () => {
	CONFIG.Item.dataModels.psychology = PsychologyData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		PsychologyItemSheet,
		{
			types: ["psychology"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		psychology: Object.freeze({
			...(game.WFRP1ED?.psychology ?? {}),
			canonicalIdentity,
		}),
	});
});

export function canonicalIdentity(psychology) {
	if (psychology?.type !== "psychology") return "";
	const rulesId = normalize(psychology.system?.rulesId);
	return rulesId || normalize(psychology.name);
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}
