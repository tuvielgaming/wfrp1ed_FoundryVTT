import { INVENTORY_HAND } from "../data-models/item/InventoryItemFields.mjs";
import { CombatEquipmentState } from "../combat/CombatEquipmentState.mjs";

const {
	ApplicationV2,
	DialogV2,
	HandlebarsApplicationMixin,
} = foundry.applications.api;

const PHYSICAL_ITEM_TYPES = new Set(["equipment", "weapon", "armour"]);

/**
 * Unrestricted physical inventory browser for the Classic sheet.
 *
 * The printed page keeps Weapons and Armour in their historical combat tables
 * and ordinary gear in Ekwipunek. This window is the common management surface
 * for authored quantity, encumbrance, storage, equip state and hand assignment
 * without forcing extra columns into the scanned paper layout.
 */
export class InventoryManagerWindow extends HandlebarsApplicationMixin(
	ApplicationV2,
) {
	static #instances = new Map();

	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"inventory-manager-window",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 760,
			height: 560,
		},
		window: {
			icon: "fas fa-box-open",
			resizable: true,
		},
		actions: {
			openItem: this.#openItem,
			toggleUsed: this.#toggleUsed,
			nextHand: this.#nextHand,
			previousHand: this.#previousHand,
			removeItem: this.#removeItem,
		},
	};

	static PARTS = {
		body: {
			template:
				"systems/wfrp1ed/templates/apps/inventory-manager-window.hbs",
		},
	};

	constructor(actor, options = {}) {
		if (!isActor(actor)) {
			throw new Error("Inventory Manager requires an Actor document.");
		}

		super({
			...options,
			id: options.id ?? `wfrp1ed-inventory-${safeApplicationId(actor.uuid)}`,
		});
		this.actor = actor;
	}

	get title() {
		return `${localize("Inventory", "Ekwipunek")} — ${this.actor.name}`;
	}

	get canEdit() {
		return Boolean(
			game.user?.isGM ||
			this.actor.testUserPermission(
				game.user,
				CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
			),
		);
	}

	static async open(actor) {
		if (!isActor(actor)) {
			throw new Error("Inventory Manager requires an Actor document.");
		}

		let application = this.#instances.get(actor.uuid);
		if (!application) {
			application = new InventoryManagerWindow(actor);
			this.#instances.set(actor.uuid, application);
		}

		await application.render({ force: true });
		application.bringToFront();
		return application;
	}

	static async refresh(actor) {
		if (!isActor(actor)) return;
		const application = this.#instances.get(actor.uuid);
		if (!application?.rendered) return;
		await application.render({ force: true });
	}

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const items = physicalItems(this.actor);

		context.actor = {
			id: this.actor.id,
			uuid: this.actor.uuid,
			name: this.actor.name,
		};
		context.editable = this.canEdit;
		context.items = items.map(itemPresentation);
		context.ui = {
			item: localize("Item", "Przedmiot"),
			type: localize("Type", "Typ"),
			quantity: localize("Qty", "Ilość"),
			encumbrance: localize("Enc.", "Obc."),
			storage: localize("Storage", "Miejsce"),
			state: localize("State", "Stan"),
			hand: localize("Hand", "Dłoń"),
			actions: localize("Actions", "Akcje"),
			empty: localize("No physical equipment.", "Brak ekwipunku."),
			open: localize("Open Item", "Otwórz przedmiot"),
			remove: localize("Delete Item", "Usuń przedmiot"),
		};

		return context;
	}

	_onClose(options) {
		super._onClose(options);
		if (InventoryManagerWindow.#instances.get(this.actor.uuid) === this) {
			InventoryManagerWindow.#instances.delete(this.actor.uuid);
		}
	}

	/** @this {InventoryManagerWindow} */
	static async #openItem(event, target) {
		event.preventDefault();
		const item = itemFromTarget(this.actor, target);
		await item.sheet?.render?.({ force: true });
	}

	/** @this {InventoryManagerWindow} */
	static async #toggleUsed(event, target) {
		event.preventDefault();
		if (!this.canEdit) return;
		const item = itemFromTarget(this.actor, target);

		try {
			await CombatEquipmentState.toggleUsed(item);
			await this.render({ force: true });
		} catch (error) {
			ui.notifications.warn(error.message);
		}
	}

	/** @this {InventoryManagerWindow} */
	static async #nextHand(event, target) {
		event.preventDefault();
		await cycleHandFromWindow(this, target, 1);
	}

	/** @this {InventoryManagerWindow} */
	static async #previousHand(event, target) {
		event.preventDefault();
		await cycleHandFromWindow(this, target, -1);
	}

	/** @this {InventoryManagerWindow} */
	static async #removeItem(event, target) {
		event.preventDefault();
		if (!this.canEdit) return;
		const item = itemFromTarget(this.actor, target);
		const confirmed = await DialogV2.confirm({
			window: { title: localize("Delete Item", "Usuń przedmiot") },
			content: localize(
				`Delete '${item.name}' from this character?`,
				`Usunąć „${item.name}” z tej postaci?`,
			),
			rejectClose: false,
			modal: true,
		});
		if (!confirmed) return;
		await this.actor.deleteEmbeddedDocuments("Item", [item.id]);
		await this.render({ force: true });
	}
}

async function cycleHandFromWindow(application, target, direction) {
	if (!application.canEdit) return;
	const item = itemFromTarget(application.actor, target);
	try {
		await CombatEquipmentState.cycleHand(item, direction);
		await application.render({ force: true });
	} catch (error) {
		ui.notifications.warn(error.message);
	}
}

function physicalItems(actor) {
	return [...(actor.items ?? [])]
		.filter((item) => PHYSICAL_ITEM_TYPES.has(item?.type))
		.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function itemPresentation(item) {
	const used = CombatEquipmentState.isUsed(item);
	const allowedHands = CombatEquipmentState.allowedHands(item);
	const showHand = !(allowedHands.length === 1 && allowedHands[0] === INVENTORY_HAND.NONE);
	const hand = showHand ? CombatEquipmentState.preferredHand(item) : INVENTORY_HAND.NONE;

	return Object.freeze({
		id: item.id,
		name: item.name,
		type: localizedType(item.type),
		quantity: nonNegativeInteger(item.system?.quantity),
		encumbrance: nonNegativeNumber(item.system?.encumbrance),
		storageLocation: String(item.system?.storageLocation ?? "") || "—",
		used,
		stateLabel: used
			? localize("Equipped", "Używany")
			: localize("Carried", "Przenoszony"),
		showHand,
		handLabel: handLabel(hand),
	});
}

function handLabel(hand) {
	switch (hand) {
		case INVENTORY_HAND.MAIN: return localize("Main", "Główna");
		case INVENTORY_HAND.OFF: return localize("Off", "Druga");
		case INVENTORY_HAND.BOTH: return localize("Both", "Obie");
		default: return "—";
	}
}

function localizedType(type) {
	switch (type) {
		case "weapon": return localize("Weapon", "Broń");
		case "armour": return localize("Armour", "Zbroja");
		default: return localize("Equipment", "Ekwipunek");
	}
}

function itemFromTarget(actor, target) {
	const row = target.closest?.("[data-item-id]");
	const id = String(row?.dataset?.itemId ?? "");
	const item = actor.items?.get?.(id);
	if (!item || !PHYSICAL_ITEM_TYPES.has(item.type)) {
		throw new Error("Inventory Item could not be resolved.");
	}
	return item;
}

function isActor(value) {
	return value instanceof foundry.documents.Actor;
}

function safeApplicationId(value) {
	return String(value ?? "actor")
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "actor";
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function nonNegativeNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
