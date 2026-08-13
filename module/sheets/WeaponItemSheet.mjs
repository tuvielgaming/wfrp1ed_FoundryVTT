import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import {
	WEAPON_GROUP,
	WEAPON_HANDEDNESS,
	WEAPON_KIND,
} from "../data-models/item/WeaponData.mjs";
import { HandEquipValidator } from "../combat/HandEquipValidator.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

/** Native Foundry v14 authoring sheet for WFRP 1e Weapon Items. */
export class WeaponItemSheet extends HandlebarsApplicationMixin(
	ItemSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"combat-item-sheet",
			"weapon-item-sheet",
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
				"systems/wfrp1ed/templates/item/weapon-item-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const system = this.document.system;
		const allowedHands = HandEquipValidator.allowedHands(this.document);
		const selectedHand = HandEquipValidator.preferredHand(this.document);

		context.item = this.document;
		context.system = system;
		context.editable = this.isEditable;
		context.ui = weaponUi();
		context.isRanged = system?.kind === WEAPON_KIND.RANGED;
		context.modeOptions = selectOptions(
			[
				[INVENTORY_MODE.CARRIED, localize("Carried", "Przenoszona")],
				[INVENTORY_MODE.HELD, localize("Equipped", "Używana")],
			],
			system?.state?.mode,
		);
		context.handOptions = selectOptions(
			handOptionEntries().filter(([value]) => allowedHands.includes(value)),
			selectedHand,
		);
		context.kindOptions = selectOptions(
			[
				[WEAPON_KIND.MELEE, localize("Melee", "Walka wręcz")],
				[WEAPON_KIND.RANGED, localize("Ranged / thrown", "Dystansowa / rzucana")],
			],
			system?.kind,
		);
		context.groupOptions = selectOptions(
			[
				[WEAPON_GROUP.ORDINARY, localize("Ordinary", "Zwykła")],
				[WEAPON_GROUP.SPECIALIST, localize("Specialist", "Specjalistyczna")],
				[WEAPON_GROUP.IMPROVISED, localize("Improvised", "Improwizowana")],
			],
			system?.group,
		);
		context.handednessOptions = selectOptions(
			[
				[WEAPON_HANDEDNESS.ONE, localize("One-handed", "Jednoręczna")],
				[WEAPON_HANDEDNESS.TWO, localize("Two-handed", "Dwuręczna")],
				[WEAPON_HANDEDNESS.EITHER, localize("One or two hands", "Jedna lub dwie dłonie")],
			],
			system?.handedness,
		);

		return context;
	}
}

function handOptionEntries() {
	return [
		[INVENTORY_HAND.MAIN, localize("Main hand", "Główna dłoń")],
		[INVENTORY_HAND.OFF, localize("Off hand", "Druga dłoń")],
		[INVENTORY_HAND.BOTH, localize("Both hands", "Obie dłonie")],
	];
}

function weaponUi() {
	return Object.freeze({
		name: localize("Name", "Nazwa"),
		description: localize("Description", "Opis"),
		rulesId: localize("Rules ID", "Identyfikator zasad"),
		weaponClass: localize("Weapon class", "Rodzaj broni"),
		kind: localize("Combat kind", "Rodzaj walki"),
		group: localize("Weapon group", "Grupa broni"),
		specialistSkillId: localize("Specialist Skill ID", "ID umiejętności specjalistycznej"),
		handedness: localize("Handedness", "Sposób trzymania"),
		mode: localize("Current state", "Aktualny stan"),
		hand: localize("Preferred hand", "Preferowana dłoń"),
		quantity: localize("Quantity", "Ilość"),
		encumbrance: localize("Encumbrance", "Obciążenie"),
		parry: localize("Parrying", "Parowanie"),
		parrySuitable: localize("Suitable for parrying", "Nadaje się do parowania"),
		parryBonus: localize("Main-rule parry bonus", "Premia do parowania z zasad podstawowych"),
		rangedDetails: localize("Ranged / thrown weapon", "Broń dystansowa / rzucana"),
		shortRange: localize("Short range", "Krótki zasięg"),
		longRange: localize("Long range", "Daleki zasięg"),
		maximumRange: localize("Extreme range", "Maksymalny zasięg"),
		effectiveStrength: localize("Effective Strength", "Siła efektywna"),
		reload: localize("Reload", "Ładowanie"),
		optionalModifiers: localize("Optional Weapon Modifiers", "Opcjonalne modyfikatory broni"),
		optionalHint: localize(
			"Stored from the optional Core Weapon Modifiers table. These values are not applied unless the combat rules explicitly enable that optional rule.",
			"Wartości z opcjonalnej tabeli Modyfikatorów broni. Nie są stosowane, dopóki zasady walki jawnie nie włączą tej zasady opcjonalnej.",
		),
		initiative: localize("Initiative", "Inicjatywa"),
		toHit: localize("To Hit", "Trafienie"),
		damage: localize("Damage", "Obrażenia"),
		parryModifier: localize("Parry", "Parowanie"),
		inventory: localize("Inventory", "Ekwipunek"),
		combat: localize("Combat", "Walka"),
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
