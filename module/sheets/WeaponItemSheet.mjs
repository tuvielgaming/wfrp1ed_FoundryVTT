import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import {
	AMMUNITION_TYPE,
} from "../data-models/item/AmmunitionTypes.mjs";
import {
	EFFECTIVE_STRENGTH_MODE,
	WEAPON_GROUP,
	WEAPON_HANDEDNESS,
	WEAPON_KIND,
} from "../data-models/item/WeaponData.mjs";
import { HandEquipValidator } from "../combat/HandEquipValidator.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const WEAPON_TABS = Object.freeze(["details", "effects"]);
const activeWeaponTabs = new WeakMap();

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
		actions: {
			showDetails: this.#showDetails,
			showEffects: this.#showEffects,
			createEffect: this.#createEffect,
			configureEffect: this.#configureEffect,
			toggleEffect: this.#toggleEffect,
			deleteEffect: this.#deleteEffect,
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
		context.usesCharacterStrength =
			system?.effectiveStrengthMode === EFFECTIVE_STRENGTH_MODE.CHARACTER;
		context.effectiveStrengthModeOptions = selectOptions(
			[
				[EFFECTIVE_STRENGTH_MODE.FIXED, localize("Fixed", "Stała")],
				[EFFECTIVE_STRENGTH_MODE.CHARACTER, localize("Thrower's Strength", "Siła rzucającego")],
			],
			system?.effectiveStrengthMode,
		);
		context.isCustomAmmunition = system?.ammunitionType === AMMUNITION_TYPE.CUSTOM;
		context.ammunitionTypeOptions = selectOptions(
			ammunitionTypeEntries(true),
			system?.ammunitionType,
		);
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
		context.effects = effectPresentation(this.document);

		return context;
	}

	_onRender(context, options) {
		super._onRender(context, options);
		activateWeaponTab(
			this.element,
			normalizedWeaponTab(activeWeaponTabs.get(this)) || "details",
		);
	}

	/** @this {WeaponItemSheet} */
	static #showDetails(_event, target) {
		setTab(this, "details", target);
	}

	/** @this {WeaponItemSheet} */
	static #showEffects(_event, target) {
		setTab(this, "effects", target);
	}

	/** @this {WeaponItemSheet} */
	static async #createEffect() {
		if (!this.isEditable) return;
		const [effect] = await this.document.createEmbeddedDocuments(
			"ActiveEffect",
			[{
				name: localize("New Effect", "Nowy efekt"),
				img: this.document.img || foundry.documents.ActiveEffect.DEFAULT_ICON,
				disabled: false,
				/* Weapon rules describe the attack source. They must not transfer to
				 * the owning Actor merely because the weapon is equipped. */
				transfer: false,
			}],
		);
		if (effect?.sheet) await effect.sheet.render({ force: true });
	}

	/** @this {WeaponItemSheet} */
	static async #configureEffect(_event, target) {
		const effect = effectFromTarget(this, target);
		if (effect?.sheet) await effect.sheet.render({ force: true });
	}

	/** @this {WeaponItemSheet} */
	static async #toggleEffect(_event, target) {
		if (!this.isEditable) return;
		const effect = effectFromTarget(this, target);
		if (effect) await effect.update({ disabled: !effect.disabled });
	}

	/** @this {WeaponItemSheet} */
	static async #deleteEffect(_event, target) {
		if (!this.isEditable) return;
		const effect = effectFromTarget(this, target);
		if (!effect) return;
		const confirmed = await DialogV2.confirm({
			content: localize(
				`Delete effect '${effect.name}'?`,
				`Usunąć efekt „${effect.name}”?`,
			),
			rejectClose: false,
			modal: true,
		});
		if (confirmed) await effect.delete();
	}
}

function handOptionEntries() {
	return [
		[INVENTORY_HAND.MAIN, localize("Main hand", "Główna dłoń")],
		[INVENTORY_HAND.OFF, localize("Off hand", "Druga dłoń")],
		[INVENTORY_HAND.BOTH, localize("Both hands", "Obie dłonie")],
	];
}

function ammunitionTypeEntries(includeNone = false) {
	const entries = [
		[AMMUNITION_TYPE.ARROW, localize("Arrow", "Strzała")],
		[AMMUNITION_TYPE.BOLT, localize("Bolt", "Bełt")],
		[AMMUNITION_TYPE.SLING, localize("Sling ammunition", "Pocisk do procy")],
		[AMMUNITION_TYPE.FIREARM_LOAD, localize("Firearm load", "Ładunek broni palnej")],
		[AMMUNITION_TYPE.CUSTOM, localize("Other / custom", "Inna / własna")],
	];
	if (includeNone) {
		entries.unshift([AMMUNITION_TYPE.NONE, localize("None / self-contained", "Brak / bez osobnej amunicji")]);
	}
	return entries;
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
		availability: localize("Availability", "Dostępność"),
		price: localize("Price", "Cena"),
		priceFormula: localize("Variable / formula price", "Cena zmienna / formuła"),
		priceFormulaHint: localize("Optional, for example 2D8 + 2 GC", "Opcjonalnie, np. 2K8 + 2 ZK"),
		gc: localize("GC", "ZK"),
		ss: "SS",
		bp: "BP",
		parry: localize("Parrying", "Parowanie"),
		parrySuitable: localize("Suitable for parrying", "Nadaje się do parowania"),
		parryBonus: localize("Main-rule parry bonus", "Premia do parowania z zasad podstawowych"),
		rangedDetails: localize("Ranged / thrown weapon", "Broń dystansowa / rzucana"),
		shortRange: localize("Short range", "Krótki zasięg"),
		longRange: localize("Long range", "Daleki zasięg"),
		maximumRange: localize("Extreme range", "Maksymalny zasięg"),
		effectiveStrength: localize("Effective Strength", "Siła efektywna"),
		effectiveStrengthMode: localize("Effective Strength source", "Źródło Siły efektywnej"),
		ammunitionType: localize("Ammunition type", "Typ amunicji"),
		ammunitionCustomId: localize("Custom ammunition ID", "Identyfikator własnej amunicji"),
		firingCycle: localize("Reload / firing cycle", "Przeładowanie / cykl strzału"),
		firingCycleHint: localize(
			"Reload is the number of complete preparation rounds between firing rounds. Use 0 for a weapon which may fire every round, 1 for a Crossbow and 2 for a Pistol. The system will use this as one countdown instead of modelling Draw/Load/Aim separately. Magazine fields apply only to repeating weapons.",
			"Przeładowanie to liczba pełnych rund przygotowania pomiędzy rundami, w których można strzelać. Wpisz 0 dla broni mogącej strzelać co rundę, 1 dla kuszy i 2 dla pistoletu. System będzie używał tej wartości jako jednego licznika zamiast osobno modelować wyciągnięcie/ładowanie/celowanie. Pola magazynka dotyczą tylko broni powtarzalnej.",
		),
		reloadRounds: localize("Reload", "Przeładowanie"),
		shotsPerFireRound: localize("Shots per firing round", "Strzały w rundzie ostrzału"),
		magazineCapacity: localize("Magazine capacity", "Pojemność magazynka"),
		magazineReloadRounds: localize("Magazine reload", "Przeładowanie magazynka"),
		optionalModifiers: localize("Optional Weapon Modifiers", "Opcjonalne modyfikatory broni"),
		optionalHint: localize(
			"Stored from the optional Core melee Weapon Modifiers table. These values are not applied unless that optional melee rule is explicitly enabled.",
			"Wartości z opcjonalnej tabeli modyfikatorów broni do walki wręcz. Nie są stosowane, dopóki ta opcjonalna zasada walki wręcz nie zostanie jawnie włączona.",
		),
		initiative: localize("Initiative", "Inicjatywa"),
		toHit: localize("To Hit", "Trafienie"),
		damage: localize("Damage", "Obrażenia"),
		parryModifier: localize("Parry", "Parowanie"),
		inventory: localize("Inventory", "Ekwipunek"),
		combat: localize("Combat", "Walka"),
		detailsTab: localize("Details", "Dane"),
		effectsTab: localize("Effects", "Efekty"),
		addEffect: localize("Add Effect", "Dodaj efekt"),
		configureEffect: localize("Configure", "Konfiguruj"),
		deleteEffect: localize("Delete", "Usuń"),
		enabled: localize("Enabled", "Aktywny"),
		disabled: localize("Disabled", "Wyłączony"),
		noEffects: localize("No Active Effects.", "Brak Aktywnych Efektów."),
		effectsHint: localize(
			"Mechanical effects stored on this Weapon. Automatic damage rules are snapshotted when an attack is rolled.",
			"Efekty mechaniczne zapisane na tej Broni. Automatyczne reguły obrażeń są zapisywane w chwili rzutu ataku.",
		),
	});
}

function effectPresentation(item) {
	return [...(item.effects ?? [])].map((effect) => ({
		id: String(effect.id ?? ""),
		name: String(effect.name ?? ""),
		img: String(effect.img ?? foundry.documents.ActiveEffect.DEFAULT_ICON),
		disabled: effect.disabled === true,
		stateLabel: effect.disabled === true
			? localize("Disabled", "Wyłączony")
			: localize("Enabled", "Aktywny"),
	}));
}

function effectFromTarget(sheet, target) {
	const card = target?.closest?.("[data-effect-id]");
	const id = String(card?.dataset?.effectId ?? "");
	return id ? sheet.document.effects?.get?.(id) ?? null : null;
}

function setTab(sheet, tab, target) {
	const normalized = normalizedWeaponTab(tab);
	if (!normalized) return;
	activeWeaponTabs.set(sheet, normalized);
	const root = target?.closest?.("form") ?? sheet.element;
	activateWeaponTab(root, normalized);
}

function activateWeaponTab(root, tab) {
	if (!(root instanceof HTMLElement)) return;
	const normalized = normalizedWeaponTab(tab) || "details";
	for (const panel of root.querySelectorAll("[data-weapon-tab-panel]")) {
		const active = panel.dataset.weaponTabPanel === normalized;
		panel.hidden = !active;
		panel.classList.toggle("is-active", active);
	}
	for (const button of root.querySelectorAll("[data-weapon-tab-button]")) {
		const active = button.dataset.weaponTabButton === normalized;
		button.classList.toggle("is-active", active);
		button.setAttribute("aria-selected", active ? "true" : "false");
		button.tabIndex = active ? 0 : -1;
	}
}

function normalizedWeaponTab(value) {
	const normalized = String(value ?? "").trim();
	return WEAPON_TABS.includes(normalized) ? normalized : "";
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
