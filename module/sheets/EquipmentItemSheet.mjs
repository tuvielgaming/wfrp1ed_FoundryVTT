import {
	AMMUNITION_TYPE,
	CONTAINER_KIND,
	EQUIPMENT_KIND,
} from "../data-models/item/AmmunitionTypes.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

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

	foundry.utils.setProperty(changes, "system.referenceQuantity", referenceQuantity);
	foundry.utils.setProperty(changes, "system.quantity", referenceQuantity);
});

/** Native Foundry v14 authoring sheet for ordinary WFRP 1e Equipment Items. */
export class EquipmentItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"combat-item-sheet",
			"equipment-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: { width: 660, height: 720 },
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
			template: "systems/wfrp1ed/templates/item/equipment-item-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const system = this.document.system;

		context.item = this.document;
		context.system = system;
		context.editable = this.isEditable;
		context.ui = equipmentUi();
		context.isAmmunition = system?.equipmentKind === EQUIPMENT_KIND.AMMUNITION;
		context.isContainer = system?.isContainer === true;
		context.isQuickAmmunitionContainer = context.isContainer &&
			system?.containerKind === CONTAINER_KIND.QUICK_AMMUNITION;
		context.isCustomAmmunition = system?.ammunitionType === AMMUNITION_TYPE.CUSTOM;
		context.isCustomContainerAmmunition = system?.containerAmmunitionType === AMMUNITION_TYPE.CUSTOM;
		context.equipmentKindOptions = selectOptions([
			[EQUIPMENT_KIND.STANDARD, localize("Standard", "Standard")],
			[EQUIPMENT_KIND.AMMUNITION, localize("Ammunition", "Amunicja")],
		], system?.equipmentKind);
		context.ammunitionTypeOptions = selectOptions(ammunitionTypeEntries(), system?.ammunitionType);
		context.containerKindOptions = selectOptions([
			[CONTAINER_KIND.STANDARD, localize("Standard", "Standard")],
			[CONTAINER_KIND.QUICK_AMMUNITION, localize("Quick Access Ammunition", "Łatwy dostęp do amunicji")],
		], system?.containerKind);
		context.containerAmmunitionTypeOptions = selectOptions(
			ammunitionTypeEntries(),
			system?.containerAmmunitionType,
		);
		context.effects = effectPresentation(this.document);

		return context;
	}

	/** @this {EquipmentItemSheet} */
	static #showDetails(_event, target) {
		setTab(this, "details", target);
	}

	/** @this {EquipmentItemSheet} */
	static #showEffects(_event, target) {
		setTab(this, "effects", target);
	}

	/** @this {EquipmentItemSheet} */
	static async #createEffect() {
		if (!this.isEditable) return;
		const [effect] = await this.document.createEmbeddedDocuments("ActiveEffect", [{
			name: localize("New Effect", "Nowy efekt"),
			img: this.document.img || foundry.documents.ActiveEffect.DEFAULT_ICON,
			disabled: false,
			/* Equipment effects are non-transfer by default. Ammunition in particular
			 * must never affect its owner merely because the stack is carried. */
			transfer: false,
		}]);
		if (effect?.sheet) await effect.sheet.render({ force: true });
	}

	/** @this {EquipmentItemSheet} */
	static async #configureEffect(_event, target) {
		const effect = effectFromTarget(this, target);
		if (effect?.sheet) await effect.sheet.render({ force: true });
	}

	/** @this {EquipmentItemSheet} */
	static async #toggleEffect(_event, target) {
		if (!this.isEditable) return;
		const effect = effectFromTarget(this, target);
		if (effect) await effect.update({ disabled: !effect.disabled });
	}

	/** @this {EquipmentItemSheet} */
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
		detailsTab: localize("Details", "Dane"),
		effectsTab: localize("Effects", "Efekty"),
		equipmentKind: localize("Equipment type", "Typ ekwipunku"),
		ammunitionType: localize("Ammunition type", "Typ amunicji"),
		customAmmunitionId: localize("Custom ammunition ID", "Identyfikator własnej amunicji"),
		containerKind: localize("Container type", "Typ pojemnika"),
		containerCapacity: localize("Capacity", "Pojemność"),
		addEffect: localize("Add Effect", "Dodaj efekt"),
		configureEffect: localize("Configure", "Konfiguruj"),
		deleteEffect: localize("Delete", "Usuń"),
		enabled: localize("Enabled", "Aktywny"),
		disabled: localize("Disabled", "Wyłączony"),
		noEffects: localize("No Active Effects.", "Brak Aktywnych Efektów."),
		effectsHint: localize(
			"Native Foundry ActiveEffects stored on this Equipment Item. Ammunition effects are non-transfer by default and can later be consumed by the ranged attack consequence pipeline.",
			"Natywne Aktywne Efekty Foundry zapisane na tym Ekwipunku. Efekty amunicji domyślnie nie są przenoszone na właściciela i mogą być później wykorzystane przez mechanikę trafienia pociskiem.",
		),
	});
}

function ammunitionTypeEntries() {
	return [
		[AMMUNITION_TYPE.NONE, localize("Not specified", "Nie określono")],
		[AMMUNITION_TYPE.ARROW, localize("Arrow", "Strzała")],
		[AMMUNITION_TYPE.BOLT, localize("Bolt", "Bełt")],
		[AMMUNITION_TYPE.SLING, localize("Sling ammunition", "Pocisk do procy")],
		[AMMUNITION_TYPE.FIREARM_LOAD, localize("Firearm load", "Ładunek broni palnej")],
		[AMMUNITION_TYPE.CUSTOM, localize("Other / custom", "Inna / własna")],
	];
}

function selectOptions(entries, selectedValue) {
	const selected = String(selectedValue ?? "");
	return entries.map(([value, label]) => ({
		value,
		label,
		selected: value === selected,
	}));
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
	const root = target?.closest?.("form") ?? sheet.element;
	if (!(root instanceof HTMLElement)) return;
	for (const panel of root.querySelectorAll("[data-equipment-tab-panel]")) {
		panel.hidden = panel.dataset.equipmentTabPanel !== tab;
	}
	for (const button of root.querySelectorAll("[data-equipment-tab-button]")) {
		button.classList.toggle("is-active", button.dataset.equipmentTabButton === tab);
	}
}

function positiveInteger(value, fallback = 1) {
	const number = Number(value);
	if (!Number.isFinite(number)) return Math.max(1, Math.trunc(fallback));
	return Math.max(1, Math.trunc(number));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
