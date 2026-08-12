import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
	ARMOUR_PIECE,
} from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import { HandEquipValidator } from "../combat/HandEquipValidator.mjs";

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
			width: 680,
			height: 780,
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
		const allowedHands = HandEquipValidator.allowedHands(this.document);
		const selectedHand = allowedHands.includes(INVENTORY_HAND.NONE)
			? INVENTORY_HAND.NONE
			: HandEquipValidator.preferredHand(this.document);

		context.item = this.document;
		context.system = system;
		context.editable = this.isEditable;
		context.ui = armourUi();
		context.modeOptions = selectOptions(
			[
				[INVENTORY_MODE.CARRIED, localize("Carried", "Przenoszony")],
				[usedMode, localize("Equipped", "Używany")],
			],
			displayedMode,
		);
		context.handOptions = selectOptions(
			handOptionEntries().filter(([value]) => allowedHands.includes(value)),
			selectedHand,
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
		context.pieceOptions = selectOptions(corePieceOptions(), system?.piece);
		context.coverage = ARMOUR_LOCATIONS.map((location) => Object.freeze({
			id: location,
			label: locationLabel(location),
			checked: system?.coverage?.[location] === true,
		}));

		return context;
	}
}

function handOptionEntries() {
	return [
		[INVENTORY_HAND.NONE, localize("None", "Brak")],
		[INVENTORY_HAND.MAIN, localize("Main hand", "Główna dłoń")],
		[INVENTORY_HAND.OFF, localize("Off hand", "Druga dłoń")],
		[INVENTORY_HAND.BOTH, localize("Both hands", "Obie dłonie")],
	];
}

function corePieceOptions() {
	return [
		[ARMOUR_PIECE.SHIELD, localize("Shield", "Tarcza")],
		[ARMOUR_PIECE.MAIL_SHIRT, localize("Mail shirt", "Koszulka kolcza")],
		[ARMOUR_PIECE.SLEEVED_MAIL_SHIRT, localize("Sleeved mail shirt", "Koszulka kolcza z rękawami")],
		[ARMOUR_PIECE.MAIL_COAT, localize("Mail coat", "Kaftan kolczy")],
		[ARMOUR_PIECE.SLEEVED_MAIL_COAT, localize("Sleeved mail coat", "Kaftan kolczy z rękawami")],
		[ARMOUR_PIECE.MAIL_COIF, localize("Mail coif", "Czepiec kolczy")],
		[ARMOUR_PIECE.BREASTPLATE, localize("Breastplate", "Napierśnik")],
		[ARMOUR_PIECE.MAIL_ARM_BRACER, localize("Mail arm bracer", "Kolczy ochraniacz ramienia")],
		[ARMOUR_PIECE.PLATE_ARM_BRACER, localize("Plate arm bracer", "Metalowy naramiennik")],
		[ARMOUR_PIECE.LEGGINGS, localize("Leggings", "Nagolennice")],
		[ARMOUR_PIECE.HELMET, localize("Helmet", "Hełm")],
		[ARMOUR_PIECE.CUSTOM, localize("Custom", "Niestandardowy")],
	];
}

function armourUi() {
	return Object.freeze({
		name: localize("Name", "Nazwa"),
		description: localize("Description", "Opis"),
		rulesId: localize("Rules ID", "Identyfikator zasad"),
		armourClass: localize("Armour class", "Rodzaj pancerza"),
		armourPiece: localize("Core armour piece", "Element pancerza z zasad"),
		armourPoints: localize("Armour Points", "Punkty pancerza"),
		mode: localize("Current state", "Aktualny stan"),
		hand: localize("Preferred hand", "Preferowana dłoń"),
		quantity: localize("Quantity", "Ilość"),
		encumbrance: localize("Encumbrance", "Obciążenie"),
		coverage: localize("Body areas covered", "Chronione obszary ciała"),
		parry: localize("Parrying", "Parowanie"),
		parrySuitable: localize("Suitable for parrying", "Nadaje się do parowania"),
		parryBonus: localize("Main-rule parry bonus", "Premia do parowania z zasad podstawowych"),
		shieldHint: localize(
			"Core p.121 permits armour layering only for specific named pieces. Choose the Core armour piece so the equip validator can enforce those combinations. Custom pieces cannot overlap other worn armour unless a future rule provider defines them.",
			"Zasady podstawowe na s. 121 dopuszczają nakładanie pancerza tylko dla konkretnych elementów. Wybierz element z zasad, aby system mógł sprawdzić dozwolone kombinacje. Niestandardowy element nie może nakładać się z innym noszonym pancerzem bez zdefiniowanej reguły.",
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
