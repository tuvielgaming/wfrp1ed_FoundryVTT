import { AdversaryData } from "../data-models/actor/AdversaryData.mjs";
import { AdversaryActorSheet } from "../sheets/AdversaryActorSheet.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Actor } = foundry.documents;

/**
 * Register native WFRP1ED NPC/Creature data and sheets during Foundry init.
 *
 * These Actor types share one adversary profile domain but remain separate from
 * the Character-only Career/Experience/Character-Creation architecture.
 */
Hooks.once("init", () => {
	CONFIG.Actor.dataModels ??= {};
	CONFIG.Actor.dataModels.npc = AdversaryData;
	CONFIG.Actor.dataModels.creature = AdversaryData;

	DocumentSheetConfig.registerSheet(
		Actor,
		game.system.id,
		AdversaryActorSheet,
		{
			types: ["npc", "creature"],
			makeDefault: true,
		},
	);
});
