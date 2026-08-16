import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";
import { LootPileService } from "./LootPileService.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MESSAGE_FLAG_KEY = "lootPile";

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
		requestAnimationFrame(() => void ui.chat?.render?.({ force: true }));
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
	if (!(card instanceof HTMLElement)) return;

	/*
	 * Foundry v14 may call renderChatMessageHTML while the rendered message tree
	 * is still detached from document. The previous isConnected guard therefore
	 * discarded the enhancement every time on that render path, leaving only the
	 * empty placeholder emitted by LootPileService. Mutating the detached node is
	 * correct: Foundry inserts that same rendered tree afterwards.
	 */
	const pile = await LootPileService.pileFromMessage(message);

	if (!pile) {
		card.replaceChildren();
		card.classList.add("is-exhausted");
		const status = document.createElement("strong");
		status.textContent = localize("Loot unavailable", "Łup niedostępny");
		card.append(status);
		return;
	}

	const items = [...(pile.items ?? [])].filter(LootPileService.isPhysicalItem);
	const exhausted = items.length === 0;
	card.classList.toggle("is-exhausted", exhausted);
	card.replaceChildren();

	const header = document.createElement("div");
	header.className = "wfrp1ed-loot-card__header";
	const title = document.createElement("strong");
	title.textContent = String(pile.name ?? localize("Loot", "Łup"));
	const summary = document.createElement("span");
	summary.textContent = exhausted
		? localize("EMPTY / EXHAUSTED", "PUSTY / WYCZERPANY")
		: localize(
			`${items.length} item${items.length === 1 ? "" : "s"} on the ground`,
			`${items.length} ${polishItemCount(items.length)} na ziemi`,
		);
	header.append(title, summary);
	card.append(header);

	if (exhausted) {
		const empty = document.createElement("div");
		empty.className = "wfrp1ed-loot-card__empty";
		empty.textContent = localize(
			"Nothing remains in this Loot Pile.",
			"W tym stosie łupu nic już nie pozostało.",
		);
		card.append(empty);
	} else {
		const toggle = document.createElement("button");
		toggle.type = "button";
		toggle.className = "wfrp1ed-loot-card__toggle";
		toggle.textContent = localize("Loot ▾", "Łup ▾");
		const list = document.createElement("div");
		list.className = "wfrp1ed-loot-card__items";
		list.hidden = true;

		for (const item of items) list.append(itemRow(item));

		toggle.addEventListener("click", () => {
			list.hidden = !list.hidden;
			toggle.textContent = list.hidden
				? localize("Loot ▾", "Łup ▾")
				: localize("Loot ▴", "Łup ▴");
		});
		card.append(toggle, list);
	}

	if (game.user?.isGM) {
		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "wfrp1ed-loot-card__delete";
		deleteButton.textContent = localize("Delete pile", "Usuń stos");
		deleteButton.addEventListener("click", () => {
			void LootPileService.deletePile(pile).catch(reportLootError);
		});
		card.append(deleteButton);
	}

	/* Existing piles are universal drop targets: owned Actor Item = move,
	 * Compendium/world Item = copy. */
	card.addEventListener("dragover", (event) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
	});
	card.addEventListener("drop", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void addDroppedItem(pile, event).catch(reportLootError);
	});
}

function itemRow(item) {
	const row = document.createElement("div");
	row.className = "wfrp1ed-loot-card__item";
	row.dataset.itemId = String(item.id ?? "");
	row.draggable = true;

	const image = document.createElement("img");
	image.src = String(item.img || "icons/svg/item-bag.svg");
	image.alt = "";
	const name = document.createElement("span");
	name.textContent = String(item.name ?? "");
	const qty = Number(item.system?.quantity ?? 1);
	const quantity = document.createElement("span");
	quantity.className = "wfrp1ed-loot-card__quantity";
	quantity.textContent = Number.isFinite(qty) && qty > 1 ? `×${Math.trunc(qty)}` : "";
	row.append(image, name, quantity);

	row.addEventListener("dragstart", (event) => {
		const data = item.toDragData();
		const serialized = JSON.stringify(data);
		event.dataTransfer.setData("text/plain", serialized);
		event.dataTransfer.setData("application/json", serialized);
		event.dataTransfer.effectAllowed = "move";
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

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
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
