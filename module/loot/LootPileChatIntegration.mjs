import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";
import { LootPileService } from "./LootPileService.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MESSAGE_FLAG_KEY = "lootPile";
const pendingPileRefreshes = new Set();

installLootDropHandling();

Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, MESSAGE_FLAG_KEY)) return;
	void renderLootCard(message, html);
});

for (const hookName of ["createItem", "updateItem", "deleteItem", "updateActor"]) {
	Hooks.on(hookName, (document) => {
		const actor = document instanceof foundry.documents.Actor
			? document
			: document?.parent;
		if (!LootPileService.isLootPile(actor)) return;
		queueVisiblePileRefresh(actor.uuid);
	});
}

/**
 * ActorSheetV2 resolves standard Item drag data before this hook. Intercept an
 * Item whose parent is a Loot Pile and perform a move transaction instead of
 * letting the base sheet create a copy and leave the ground Item behind.
 */
function installLootDropHandling() {
	if (ClassicActorSheet.prototype.__wfrpLootDropInstalled === true) return;
	const original = ClassicActorSheet.prototype._onDropItem;
	if (typeof original !== "function") return;

	ClassicActorSheet.prototype._onDropItem = async function lootAwareDrop(event, item) {
		if (
			item instanceof foundry.documents.Item &&
			LootPileService.isLootPile(item.parent)
		) {
			try {
				await LootPileService.takeItem(item.parent, item, this.document);
				return true;
			} catch (error) {
				console.error("WFRP1ED | Unable to take Loot Item.", error);
				ui.notifications.warn(error?.message ?? localize(
					"Unable to take that Loot Item.",
					"Nie udało się podnieść tego przedmiotu.",
				));
				return false;
			}
		}
		return original.call(this, event, item);
	};

	Object.defineProperty(
		ClassicActorSheet.prototype,
		"__wfrpLootDropInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

async function renderLootCard(message, html) {
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-loot-card]")
		? root
		: root?.querySelector?.("[data-wfrp-loot-card]");
	if (!isElement(card)) return;

	/* A detached ApplicationV2 lives in a separate browser Document. Always
	 * create children in the card's own document and avoid cross-realm
	 * `instanceof HTMLElement` checks. */
	const ownerDocument = card.ownerDocument ?? document;
	const pile = await LootPileService.pileFromMessage(message);

	/* `renderLootCard` can be called repeatedly on the same ChatMessage element.
	 * Use event-handler properties for the persistent card drop target so each
	 * render replaces the previous handler instead of accumulating listeners. */
	card.ondragover = null;
	card.ondrop = null;

	if (!pile) {
		card.replaceChildren();
		card.classList.add("is-exhausted");
		const status = ownerDocument.createElement("strong");
		status.textContent = localize("Loot unavailable", "Łup niedostępny");
		card.append(status);
		return;
	}

	const items = [...(pile.items ?? [])].filter(LootPileService.isPhysicalItem);
	const exhausted = items.length === 0;
	card.classList.toggle("is-exhausted", exhausted);
	card.replaceChildren();

	const header = ownerDocument.createElement("div");
	header.className = "wfrp1ed-loot-card__header";
	const title = ownerDocument.createElement("strong");
	title.textContent = String(pile.name ?? localize("Loot", "Łup"));
	const summary = ownerDocument.createElement("span");
	summary.textContent = exhausted
		? localize("EMPTY / EXHAUSTED", "PUSTY / WYCZERPANY")
		: localize(
			`${items.length} item${items.length === 1 ? "" : "s"} on the ground`,
			`${items.length} ${polishItemCount(items.length)} na ziemi`,
		);
	header.append(title, summary);
	card.append(header);

	if (exhausted) {
		const empty = ownerDocument.createElement("div");
		empty.className = "wfrp1ed-loot-card__empty";
		empty.textContent = localize(
			"Nothing remains in this Loot Pile.",
			"W tym stosie łupu nic już nie pozostało.",
		);
		card.append(empty);
	} else {
		const toggle = ownerDocument.createElement("button");
		toggle.type = "button";
		toggle.className = "wfrp1ed-loot-card__toggle";
		toggle.textContent = localize("Loot ▾", "Łup ▾");
		const list = ownerDocument.createElement("div");
		list.className = "wfrp1ed-loot-card__items";
		list.hidden = true;

		for (const item of items) list.append(itemRow(item, ownerDocument));

		toggle.addEventListener("click", () => {
			list.hidden = !list.hidden;
			toggle.textContent = list.hidden
				? localize("Loot ▾", "Łup ▾")
				: localize("Loot ▴", "Łup ▴");
		});
		card.append(toggle, list);
	}

	if (game.user?.isGM) {
		const deleteButton = ownerDocument.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "wfrp1ed-loot-card__delete";
		deleteButton.textContent = localize("Delete pile", "Usuń stos");
		deleteButton.addEventListener("click", () => {
			void LootPileService.deletePile(pile).catch(reportLootError);
		});
		card.append(deleteButton);
	}

	/* Existing piles are universal drop targets: owned Actor Item = move,
	 * Compendium/world Item = copy. Assign, don't append, these handlers because
	 * the same card root survives multiple presentation refreshes. */
	card.ondragover = (event) => {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
	};
	card.ondrop = (event) => {
		event.preventDefault();
		event.stopPropagation();
		void addDroppedItem(pile, event).catch(reportLootError);
	};
}

function itemRow(item, ownerDocument = document) {
	const row = ownerDocument.createElement("div");
	row.className = "wfrp1ed-loot-card__item";
	row.dataset.itemId = String(item.id ?? "");
	row.dataset.itemUuid = String(item.uuid ?? "");
	row.draggable = true;

	const image = ownerDocument.createElement("img");
	image.src = String(item.img || "icons/svg/item-bag.svg");
	image.alt = "";
	/* Let the containing row own dragstart. Native image dragging otherwise
	 * produces a browser image payload instead of Foundry Item drag data. */
	image.draggable = false;
	const name = ownerDocument.createElement("span");
	name.textContent = String(item.name ?? "");
	const qty = Number(item.system?.quantity ?? 1);
	const quantity = ownerDocument.createElement("span");
	quantity.className = "wfrp1ed-loot-card__quantity";
	quantity.textContent = Number.isFinite(qty) && qty > 1 ? `×${Math.trunc(qty)}` : "";
	row.append(image, name, quantity);

	row.addEventListener("dragstart", (event) => {
		const data = item.toDragData();
		const serialized = JSON.stringify(data);
		event.dataTransfer?.setData("text/plain", serialized);
		event.dataTransfer?.setData("application/json", serialized);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	});
	row.addEventListener("dblclick", () => void item.sheet?.render?.({ force: true }));
	return row;
}

async function addDroppedItem(pile, event) {
	const data = foundry.applications.ux.TextEditor.getDragEventData(event);
	if (String(data?.type ?? "") !== "Item") return;
	const uuid = String(data.uuid ?? "").trim();
	if (!uuid) return;
	const item = await foundry.utils.fromUuid(uuid);
	if (!LootPileService.isPhysicalItem(item)) {
		throw new Error(localize(
			"Only Weapon, Armour, or Equipment Items can be placed in Loot.",
			"Do łupu można przenosić tylko broń, pancerz i ekwipunek.",
		));
	}
	const sourceActor = item.parent instanceof foundry.documents.Actor ? item.parent : null;
	const move = Boolean(sourceActor && !LootPileService.isLootPile(sourceActor));
	await LootPileService.addItem(pile, item, { move });
}

/**
 * Foundry v14 can detach an ApplicationV2 into a separate browser Document.
 * Update visible Loot cards in every rendered host document, not only the main
 * workspace document. The ApplicationV2 instance registry provides those host
 * documents even after ChatLog has been detached.
 */
function queueVisiblePileRefresh(pileUuid) {
	const uuid = String(pileUuid ?? "");
	if (!uuid || pendingPileRefreshes.has(uuid)) return;
	pendingPileRefreshes.add(uuid);
	requestAnimationFrame(() => {
		pendingPileRefreshes.delete(uuid);
		void refreshVisiblePileCards(uuid);
	});
}

async function refreshVisiblePileCards(pileUuid) {
	const documents = renderedHostDocuments();
	for (const message of LootPileService.messagesForPile(pileUuid)) {
		const selector = `[data-message-id="${CSS.escape(String(message.id ?? ""))}"]`;
		for (const hostDocument of documents) {
			for (const messageRoot of hostDocument.querySelectorAll(selector)) {
				await renderLootCard(message, messageRoot);
			}
		}
	}
}

function renderedHostDocuments() {
	const documents = new Set([document]);
	const instances = foundry.applications?.instances;
	if (instances?.values) {
		for (const application of instances.values()) {
			const hostDocument = application?.element?.ownerDocument;
			if (hostDocument?.querySelectorAll) documents.add(hostDocument);
		}
	}
	const popoutDocument = ui.chat?.popout?.element?.ownerDocument;
	if (popoutDocument?.querySelectorAll) documents.add(popoutDocument);
	return documents;
}

function asElement(html) {
	if (isElement(html)) return html;
	if (isElement(html?.[0])) return html[0];
	return null;
}

function isElement(value) {
	return Boolean(value && value.nodeType === 1 && typeof value.querySelector === "function");
}

function polishItemCount(count) {
	if (count === 1) return "przedmiot";
	const mod10 = count % 10;
	const mod100 = count % 100;
	return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)
		? "przedmioty"
		: "przedmiotów";
}

function reportLootError(error) {
	console.error("WFRP1ED | Loot action failed.", error);
	ui.notifications.warn(error?.message ?? localize(
		"Loot action failed.",
		"Operacja łupu nie powiodła się.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
