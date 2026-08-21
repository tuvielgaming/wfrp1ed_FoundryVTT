const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

/*
 * World/Compendium Equipment acts as an authored definition. Its visible
 * `Ilość` field is the reference package quantity from the Core tables, so keep
 * the hidden default current quantity synchronized with it. Once an Item is
 * embedded in an Actor, current quantity belongs to that character and must no
 * longer follow reference-quantity edits.
 */
Hooks.on("preUpdateItem", (item, changes) => {
	if (item?.type !== "equipment") return;

	const actor = item?.actor ?? item?.parent;
	if (actor?.documentName === "Actor") return;

	const directKey = "system.referenceQuantity";
	const rawReference = Object.hasOwn(changes ?? {}, directKey)
		? changes[directKey]
		: foundry.utils.getProperty(changes, directKey);
	if (rawReference === undefined) return;

	const referenceQuantity = positiveInteger(rawReference, 1);

	if (Object.hasOwn(changes, directKey)) {
		changes[directKey] = referenceQuantity;
		changes["system.quantity"] = referenceQuantity;
		return;
	}

	foundry.utils.setProperty(
		changes,
		"system.referenceQuantity",
		referenceQuantity,
	);
	foundry.utils.setProperty(
		changes,
		"system.quantity",
		referenceQuantity,
	);
});

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
		container: localize("Container", "Pojemnik"),
		clothing: localize("Clothing", "Odzież"),
		quantity: localize("Quantity", "Ilość"),
		encumbrance: localize("Encumbrance", "Obciążenie"),
		availability: localize("Availability", "Dostępność"),
		price: localize("Price", "Cena"),
		gc: localize("GC", "ZK"),
		ss: "SS",
		bp: "BP",
		description: localize("Description", "Opis"),
	});
}

function positiveInteger(value, fallback = 1) {
	const number = Number(value);
	if (!Number.isFinite(number)) return Math.max(1, Math.trunc(fallback));
	return Math.max(1, Math.trunc(number));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
