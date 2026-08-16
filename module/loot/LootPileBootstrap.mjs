import { LootPileData } from "../data-models/actor/LootPileData.mjs";

Hooks.once("init", () => {
	CONFIG.Actor.dataModels.lootPile = LootPileData;
	installLootPileDirectoryFilter();
});

/**
 * Loot Piles are world Actors because Foundry gives us reliable embedded Item
 * storage, UUID resolution, permissions, and transactional document updates.
 * They are nevertheless system-owned ground containers, not campaign Actors,
 * so they must not pollute the normal Actor Directory.
 *
 * Foundry v14 builds the Actor Directory tree through the collection's visible
 * tree-content hook. Filter only that presentation path: the Actor remains in
 * game.actors and is still fully reachable by UUID from Loot chat cards and the
 * transfer service.
 */
function installLootPileDirectoryFilter() {
	const Actors = foundry.documents?.collections?.Actors;
	const prototype = Actors?.prototype;
	const original = prototype?._getVisibleTreeContents;
	if (typeof original !== "function" || prototype.__wfrpLootPileDirectoryFilterInstalled === true) {
		return;
	}

	prototype._getVisibleTreeContents = function wfrpVisibleActorTreeContents(entry) {
		const contents = original.call(this, entry);
		if (!Array.isArray(contents)) return contents;
		return contents.filter((actor) => actor?.type !== "lootPile");
	};

	Object.defineProperty(
		prototype,
		"__wfrpLootPileDirectoryFilterInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}
