import { LootPileData } from "../data-models/actor/LootPileData.mjs";

Hooks.once("init", () => {
	CONFIG.Actor.dataModels.lootPile = LootPileData;
});
