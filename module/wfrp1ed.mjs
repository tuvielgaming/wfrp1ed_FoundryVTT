import { WFRP1ED } from "./helpers/config.mjs";
import { Wfrp1edActorSheet } from "./sheets/Wfrp1edActorSheet.mjs";
import { Wfrp1edFoundryStyleActorSheet } from "./sheets/Wfrp1edFoundryStyleActorSheet.mjs";
import { Wfrp1edItemSheet } from "./sheets/Wfrp1edItemSheet.mjs";
import { Wfrp1edActor } from "./documents/wfrp1edActor.mjs";
import { Wfrp1edItem } from "./documents/Wfrp1edItem.mjs";

Hooks.once("init", function () {
	console.log("Wfrp1ed Initiaizing WFRP 1st edition");

	game.WFRP1ED = {
		Wfrp1edActor,
		Wfrp1edItem,
	};
	CONFIG.WFRP1ED = WFRP1ED;
	Actors.unregisterSheet("core", ActorSheet);
	Actors.registerSheet("wfrp1ed", Wfrp1edActorSheet, { makeDefault: true });
	Actors.registerSheet("wfrp1ed", Wfrp1edFoundryStyleActorSheet);

	Items.unregisterSheet("core", ItemSheet);
	Items.registerSheet("wfrp1ed", Wfrp1edItemSheet, { makeDefault: true });

	CONFIG.Actor.documentClass = Wfrp1edActor;
	CONFIG.Item.documentClass = Wfrp1edItem;

	// return preloadHandlebarsTemplates();
});
