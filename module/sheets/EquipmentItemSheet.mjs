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

		return context;
	}
}

function equipmentUi() {
	return Object.freeze({
		name: localize("Name", "Nazwa"),
		inventory: localize("Inventory", "Ekwipunek"),
		wealth: localize("Wealth", "Majątek"),
		quantity: localize("Quantity", "Ilość"),
		encumbrance: localize("Encumbrance", "Obciążenie"),
		storageLocation: localize("Location", "Miejsce"),
		availability: localize("Availability", "Dostępność"),
		price: localize("Price", "Cena"),
		gc: localize("GC", "ZK"),
		ss: localize("s", "s"),
		bp: localize("d", "p"),
		description: localize("Description", "Opis"),
	});
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
