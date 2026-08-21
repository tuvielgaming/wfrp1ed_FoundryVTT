import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";
import { LootPileService } from "../loot/LootPileService.mjs";
import { HeldItemsCheck } from "./HeldItemsCheck.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "heldItemsCheck";
const CONSEQUENCE_KIND = "drop-held-items";
const CONSEQUENCE_STATE = Object.freeze({
	PENDING: "pending",
	APPLIED: "applied",
	NO_ITEMS: "no-items",
});

/*
 * Complete the physical consequence of the Core Jump/Fall held-items check.
 *
 * HeldItemsCheck owns the d100, manual/physical-dice editing, and Luck semantics.
 * LootPileService owns authoritative Item moves, GM socket routing, and ground-
 * pile chat. This integration connects the two contracts only after the d100 has
 * been accepted:
 *
 *   d100 <= 50 -> user explicitly resolves the pending physical Item drop.
 *
 * The previous implementation moved Items immediately after Foundry generated
 * the d100. That made physical dice unsafe: if Foundry rolled 01-50 first, the
 * world state changed before the player had a chance to type the real tabletop
 * result. The drop is now a visible pending consequence. The GM/Actor owner may
 * edit the d100 first, then apply the Item move only if the final result still
 * says DROP.
 *
 * Once a physical move has happened the roll is finalized. Rewriting the d100
 * afterward without returning the Items would split the rules state from the
 * world state, so manual edits and Luck are locked for APPLIED drops. A failed
 * check with no held physical Items remains adjustable because no external world
 * mutation occurred.
 */
installHeldItemsLootIntegration();

function installHeldItemsLootIntegration() {
	if (HeldItemsCheck.__wfrpLootIntegrationInstalled === true) return;

	const originalLuckOptions = HeldItemsCheck.luckOptions;

	HeldItemsCheck.luckOptions = function heldItemsLuckAfterPhysicalConsequence(message) {
		const state = this.stateFor(message);
		if (
			state?.consequence?.kind === CONSEQUENCE_KIND &&
			state?.consequence?.state === CONSEQUENCE_STATE.APPLIED
		) {
			return [];
		}
		return originalLuckOptions.call(this, message);
	};

	Hooks.on("renderChatMessageHTML", (message, html) => {
		decorateDropConsequence(message, html);
	});

	Object.defineProperty(
		HeldItemsCheck,
		"__wfrpLootIntegrationInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function decorateDropConsequence(message, html) {
	const state = HeldItemsCheck.stateFor(message);
	if (!state) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-held-items-card]")
		? root
		: root?.querySelector?.("[data-wfrp-held-items-card]");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-held-items-drop-action]")?.remove();

	if (String(state.outcome ?? "") !== "drop") return;
	if (state?.consequence?.kind !== CONSEQUENCE_KIND) return;

	const block = document.createElement("section");
	block.className = "wfrp1e-movement-consequence";
	block.dataset.wfrpHeldItemsDropAction = "";

	const consequenceState = String(state.consequence?.state ?? "");
	if (consequenceState === CONSEQUENCE_STATE.APPLIED) {
		const status = document.createElement("div");
		status.className = "wfrp1e-movement-consequence__status";
		status.textContent = localize(
			"Held items have been moved to a Loot Pile. This d100 is now read-only until that world-state consequence can be reversed.",
			"Trzymane przedmioty przeniesiono do Stosu Łupów. Ten wynik K100 jest teraz tylko do odczytu, dopóki nie będzie można cofnąć tej zmiany stanu świata.",
		);
		block.append(status);
		card.append(block);
		return;
	}

	if (consequenceState === CONSEQUENCE_STATE.NO_ITEMS) {
		const status = document.createElement("div");
		status.className = "wfrp1e-movement-consequence__status";
		status.textContent = localize(
			"The result says DROP, but the Actor had no physical held Items to move when the consequence was resolved.",
			"Wynik oznacza UPUSZCZA, ale podczas rozstrzygania konsekwencji Aktor nie miał żadnych fizycznych trzymanych przedmiotów do przeniesienia.",
		);
		block.append(status);
		card.append(block);
		return;
	}

	if (consequenceState !== CONSEQUENCE_STATE.PENDING) return;

	const actor = actorFromStateSync(state);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1e-movement-consequence__action";
	button.textContent = localize(
		"Resolve dropped held items",
		"Rozstrzygnij upuszczenie trzymanych przedmiotów",
	);
	button.title = localize(
		"Use this only after accepting the d100 result. If physical dice were used, enter that result above first.",
		"Użyj dopiero po zaakceptowaniu wyniku K100. Jeśli użyto fizycznych kości, najpierw wpisz ich wynik powyżej.",
	);

	if (!canManage(actor)) {
		button.disabled = true;
		button.title = localize(
			"Only the GM or an OWNER of this Actor can resolve the Item drop.",
			"Tylko MG albo Właściciel tego Aktora może rozstrzygnąć upuszczenie przedmiotów.",
		);
	} else {
		button.addEventListener("click", (event) => {
			event.preventDefault();
			button.disabled = true;
			void applyPendingDrop(message)
				.catch((error) => {
					console.error(
						"WFRP1ED | Held-items physical drop failed.",
						error,
					);
					ui.notifications.error(
						error?.message ?? localize(
							"Unable to resolve the held-item drop.",
							"Nie udało się rozstrzygnąć upuszczenia trzymanych przedmiotów.",
						),
					);
				})
				.finally(() => {
					button.disabled = false;
				});
		});
	}

	block.append(button);
	card.append(block);
}

async function applyPendingDrop(message) {
	const state = HeldItemsCheck.stateFor(message);
	if (!state) {
		throw new Error("Held-items state is unavailable.");
	}
	if (String(state.outcome ?? "") !== "drop") {
		throw new Error(localize(
			"The held-items result no longer requires a drop.",
			"Wynik testu utrzymania przedmiotów nie wymaga już upuszczenia.",
		));
	}
	if (
		state?.consequence?.kind !== CONSEQUENCE_KIND ||
		state?.consequence?.state !== CONSEQUENCE_STATE.PENDING
	) {
		throw new Error(localize(
			"This held-item drop is not pending.",
			"To upuszczenie przedmiotów nie oczekuje na rozstrzygnięcie.",
		));
	}

	const actor = await actorFromState(state);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(localize(
			"The Actor for this held-items result is unavailable.",
			"Aktor dla tego wyniku utrzymania przedmiotów jest niedostępny.",
		));
	}
	if (!canManage(actor)) {
		throw new Error(localize(
			"Only the GM or an OWNER of this Actor can resolve the Item drop.",
			"Tylko MG albo Właściciel tego Aktora może rozstrzygnąć upuszczenie przedmiotów.",
		));
	}

	const heldItems = [...(actor.items ?? [])].filter((item) =>
		LootPileService.isPhysicalItem(item) &&
		String(item.system?.state?.mode ?? "") === INVENTORY_MODE.HELD,
	);

	let lootResult = null;
	if (heldItems.length > 0) {
		lootResult = await LootPileService.createFromActorItems({
			sourceActor: actor,
			items: heldItems,
			reason: "held-items-check",
			sourceLabel: actor.name,
		});
	}

	const updated = foundry.utils.deepClone(
		HeldItemsCheck.stateFor(message),
	);
	if (!updated || String(updated.outcome ?? "") !== "drop") {
		throw new Error(localize(
			"The d100 result changed while the drop was being resolved. No result state was finalized.",
			"Wynik K100 zmienił się podczas rozstrzygania upuszczenia. Stan wyniku nie został zatwierdzony.",
		));
	}

	updated.consequence = {
		kind: CONSEQUENCE_KIND,
		state: lootResult?.pileUuid
			? CONSEQUENCE_STATE.APPLIED
			: CONSEQUENCE_STATE.NO_ITEMS,
		pileUuid: String(lootResult?.pileUuid ?? ""),
		moved: Number(lootResult?.moved ?? 0),
		appliedAt: lootResult?.pileUuid ? Date.now() : null,
	};
	updated.updatedBy = String(game.user?.id ?? "");
	updated.updatedAt = Date.now();

	await message.update({
		[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
	});
	return message;
}

function canManage(actor) {
	if (!game.user || !(actor instanceof foundry.documents.Actor)) return false;
	return game.user.isGM || actor.testUserPermission?.(
		game.user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

async function actorFromState(state) {
	try {
		const actor = await foundry.utils.fromUuid(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function actorFromStateSync(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}