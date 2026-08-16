import { LootPileService } from "../loot/LootPileService.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "criticalConsequenceRuntime";

/**
 * LIFO guard/rollback for one-shot Critical consequences which escape the
 * Critical Wound Item itself. Timed/periodic ActiveEffects are embedded in the
 * wound and disappear naturally with the Item. Dropped Items live in a separate
 * Loot Pile and therefore require an explicit inverse transaction.
 */
export async function preflightCriticalConsequenceRollback(wound) {
	const context = await lootRollbackContext(wound);
	if (!context) return null;
	assertUntouched(context);
	return context;
}

export async function revertCriticalConsequences(wound) {
	const context = await preflightCriticalConsequenceRollback(wound);
	if (!context) return { restoredLootItems: 0 };
	const result = await LootPileService.restoreUntouchedPile(
		context.pile,
		context.actor,
	);
	return { restoredLootItems: Number(result?.restored ?? 0) };
}

async function lootRollbackContext(wound) {
	if (!(wound instanceof foundry.documents.Item) || wound.type !== "criticalWound") return null;
	const actor = wound.parent;
	if (!(actor instanceof foundry.documents.Actor)) return null;
	const runtime = wound.getFlag?.(FLAG_SCOPE, RUNTIME_FLAG_KEY);
	const pileUuid = String(runtime?.lootPileUuid ?? "").trim();
	if (!pileUuid) return null;
	let pile;
	try {
		pile = await foundry.utils.fromUuid(pileUuid);
	} catch (_error) {
		pile = null;
	}
	if (!LootPileService.isLootPile(pile)) {
		throw new Error(localize(
			"The Loot Pile created by this Critical Wound no longer exists. The Critical cannot be rolled back safely.",
			"Stos łupu utworzony przez tę Ranę Krytyczną już nie istnieje. Nie można bezpiecznie cofnąć trafienia krytycznego.",
		));
	}
	return { wound, actor, runtime, pile };
}

function assertUntouched({ actor, pile }) {
	if (String(pile.system?.sourceActorUuid ?? "") !== String(actor.uuid)) {
		throw new Error("The linked Loot Pile no longer belongs to this Critical Wound target.");
	}
	if (Number(pile.system?.revision ?? 0) !== 0) {
		throw new Error(localize(
			"Items in this Critical Wound's Loot Pile were moved after the injury. Revert those newer Loot transfers before invalidating the Critical/Damage transaction.",
			"Przedmioty w stosie łupu tej Rany Krytycznej zostały później przeniesione. Przed unieważnieniem trafienia krytycznego/obrażeń cofnij nowsze transfery łupu.",
		));
	}
	const physicalCount = [...(pile.items ?? [])].filter(LootPileService.isPhysicalItem).length;
	if (physicalCount !== Number(pile.system?.initialItemCount ?? 0)) {
		throw new Error(localize(
			"The linked Loot Pile was modified outside the tracked transfer workflow and cannot be rolled back automatically.",
			"Powiązany stos łupu został zmieniony poza śledzonym mechanizmem transferu i nie można go automatycznie cofnąć.",
		));
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
