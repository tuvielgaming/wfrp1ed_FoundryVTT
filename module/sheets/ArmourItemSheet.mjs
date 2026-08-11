import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
} from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

/** Native Foundry v14 authoring sheet for WFRP 1e Armour Items. */
export class ArmourItemSheet extends HandlebarsApplicationMixin(
	ItemSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"combat-item-sheet",
			"armour-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 660,
			height: 760,
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
				"systems/wfrp1ed/templates/item/armour-item-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const system = this.document.system;
		const usedMode = system?.armourClass === ARMOUR_CLASS.SHIELD
			? INVENTORY_MODE.HELD
			: INVENTORY_MODE.WORN;
		const displayedMode = system?.state?.mode === INVENTORY_MODE.CARRIED
			? INVENTORY_MODE.CARRIED
			: usedMode;

		context.item = this.document;
		context.system = system;
		context.editable = this.isEditable;
		context.ui = armourUi();
		context.modeOptions = selectOptions(
			[
				[INVENTORY_MODE.CARRIED, localize("Carried", "Przenoszony")],
				[usedMode, localize("Used", "Używany")],
			],
			displayedMode,
		);
		context.handOptions = selectOptions(
			[
				[INVENTORY_HAND.NONE, localize("None", "Brak")],
				[INVENTORY_HAND.RIGHT, localize("Right hand", "Prawa dłoń")],
				[INVENTORY_HAND.LEFT, localize("Left hand", "Lewa dłoń")],
				[INVENTORY_HAND.BOTH, localize("Both hands", "Obie dłonie")],
			],
			system?.state?.hand,
		);
		context.classOptions = selectOptions(
			[
				[ARMOUR_CLASS.SHIELD, localize("Shield", "Tarcza")],
				[ARMOUR_CLASS.MAIL, localize("Mail", "Kolczuga")],
				[ARMOUR_CLASS.PLATE, localize("Plate", "Płyty")],
				[ARMOUR_CLASS.LEATHER, localize("Leather", "Skóra")],
				[ARMOUR_CLASS.OTHER, localize("Other", "Inny")],
			],
			system?.armourClass,
		);
		context.coverage = ARMOUR_LOCATIONS.map((location) => Object.freeze({
			id: location,
			label: locationLabel(location),
			checked: system?.coverage?.[location] === true,
		}));

		return context;
	}
}

function armourUi() {
	return Object.freeze({
		name: localize("Name", "Nazwa"),
		description: localize("Description", "Opis"),
		rulesId: localize("Rules ID", "Identyfikator zasad"),
		armourClass: localize("Armour class", "Rodzaj pancerza"),
		armourPoints: localize("Armour Points", "Punkty pancerza"),
		mode: localize("Current state", "Aktualny stan"),
		hand: localize("Held in", "Trzymany w"),
		quantity: localize("Quantity", "Ilość"),
		encumbrance: localize("Encumbrance", "Obciążenie"),
		coverage: localize("Body areas covered", "Chronione obszary ciała"),
		parry: localize("Parrying", "Parowanie"),
		parrySuitable: localize("Suitable for parrying", "Nadaje się do parowania"),
		parryBonus: localize("Main-rule parry bonus", "Premia do parowania z zasad podstawowych"),
		shieldHint: localize(
			"Core shields are held armour: AP 1 to all body areas and +20 WS when used to parry. The Item stores those facts explicitly instead of inferring them from its localized name.",
			"Tarcza z zasad podstawowych jest trzymanym pancerzem: 1 PP na wszystkie obszary ciała i +20 WW podczas parowania. Przedmiot zapisuje te fakty jawnie zamiast rozpoznawać je po zlokalizowanej nazwie.",
		),
		inventory: localize("Inventory", "Ekwipunek"),
		protection: localize("Protection", "Ochrona"),
	});
}

function locationLabel(location) {
	const labels = {
		head: ["Head", "Głowa"],
		body: ["Body", "Korpus"],
		rightArm: ["Right arm", "Prawe ramię"],
		leftArm: ["Left arm", "Lewe ramię"],
		rightLeg: ["Right leg", "Prawa noga"],
		leftLeg: ["Left leg", "Lewa noga"],
	};
	const [english, polish] = labels[location] ?? [location, location];
	return localize(english, polish);
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