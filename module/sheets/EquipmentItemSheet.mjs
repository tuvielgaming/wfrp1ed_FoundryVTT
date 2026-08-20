import {
	EQUIPMENT_SECTION,
} from "../data-models/item/EquipmentData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

/** Native Foundry v14 authoring sheet for ordinary WFRP 1e Equipment Items. */
export class EquipmentItemSheet extends HandlebarsApplicationMixin(
	ItemSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"combat-item-sheet",
			"equipment-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 620,
			height: 650,
		},
		tag: "form",
		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},
	};

	static PARTS = {
		form: {
			template:
				"systems/wfrp1ed/templates/item/equipment-item-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const system = this.document.system;

		context.item = this.document;
		context.system = system;
		context.editable = this.isEditable;
		context.ui = equipmentUi();
		context.sectionOptions = selectOptions(
			[
				[
					EQUIPMENT_SECTION.EQUIPMENT,
					localize("Equipment / Trappings", "Ekwipunek"),
				],
				[
					EQUIPMENT_SECTION.WEALTH,
					localize("Wealth", "Majątek"),
				],
			],
			system?.inventorySection,
		);
		context.modeOptions = selectOptions(
			[
				[INVENTORY_MODE.CARRIED, localize("Carried", "Przenoszony")],
				[INVENTORY_MODE.HELD, localize("Used", "Używany")],
			],
			system?.state?.mode,
		);
		context.handOptions = selectOptions(
			[
				[INVENTORY_HAND.NONE, localize("None", "Brak")],
				[INVENTORY_HAND.MAIN, localize("Main hand", "Główna dłoń")],
				[INVENTORY_HAND.OFF, localize("Off hand", "Druga dłoń")],
				[INVENTORY_HAND.BOTH, localize("Both hands", "Obie dłonie")],
			],
			system?.state?.hand,
		);

		return context;
	}
}

function equipmentUi() {
	return Object.freeze({
		name: localize("Name", "Nazwa"),
		inventory: localize("Inventory", "Ekwipunek"),
		section: localize("Character sheet section", "Sekcja karty postaci"),
		mode: localize("Current state", "Aktualny stan"),
		hand: localize("Preferred hand", "Preferowana dłoń"),
		quantity: localize("Quantity", "Ilość"),
		encumbrance: localize("Encumbrance", "Obciążenie"),
		storageLocation: localize("Stored at", "Miejsce przechowywania"),
		availability: localize("Availability", "Dostępność"),
		price: localize("Price", "Cena"),
		gc: localize("GC", "ZK"),
		ss: localize("s", "s"),
		bp: localize("d", "p"),
		description: localize("Description", "Opis"),
	});
}

function selectOptions(entries, selectedValue) {
	const selected = String(selectedValue ?? "");
	return Object.freeze(
		entries.map(([value, label]) => Object.freeze({
			value,
			label,
			selected: value === selected,
		})),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
