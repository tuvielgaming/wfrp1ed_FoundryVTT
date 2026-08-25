import {
	AMMUNITION_TYPE,
	CONTAINER_KIND,
	EQUIPMENT_KIND,
} from "../data-models/item/AmmunitionTypes.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const EQUIPMENT_TABS = Object.freeze(["details", "effects"]);
const activeEquipmentTabs = new WeakMap();

/*
 * Equipment has two mutually-exclusive authored roles in the ammunition layer:
 * - an Ammunition stack; or
 * - a Container (which may itself be a Quick Access Ammunition container).
 *
 * A quiver is therefore a Standard Equipment container whose container subtype
 * declares Arrow compatibility. It is not also an Ammunition Item. Normalize
 * edits at the document boundary so hidden stale fields cannot make one Item
 * act as both roles after a sheet change.
 *
 * World/Compendium Equipment also acts as an authored definition. Its visible
 * `Ilość` field is the reference package quantity from the Core tables, so keep
 * the hidden default current quantity synchronized with it. Once an Item is
 * embedded in an Actor, current quantity belongs to that character and must no
 * longer follow reference-quantity edits.
 */
Hooks.on("preUpdateItem", (item, changes) => {
	if (item?.type !== "equipment") return;

	normalizeEquipmentRoleUpdate(item, changes);

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
		context.isContainer = system?.isContainer === true;
		context.isAmmunition = !context.isContainer &&
			system?.equipmentKind === EQUIPMENT_KIND.AMMUNITION;
		context.isQuickAmmunitionContainer = context.isContainer &&
			system?.containerKind === CONTAINER_KIND.QUICK_AMMUNITION;
		context.isCustomAmmunition = context.isAmmunition &&
			system?.ammunitionType === AMMUNITION_TYPE.CUSTOM;
		context.isCustomContainerAmmunition = context.isQuickAmmunitionContainer &&
			system?.containerAmmunitionType === AMMUNITION_TYPE.CUSTOM;
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

	_onRender(context, options) {
		super._onRender(context, options);
		activateEquipmentTab(
			this.element,
			normalizedEquipmentTab(activeEquipmentTabs.get(this)) || "details",
		);
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

function normalizeEquipmentRoleUpdate(item, changes) {
	if (!changes || typeof changes !== "object") return;

	const current = item.system ?? {};
	const isContainerChanged = hasSystemChange(changes, "isContainer");
	const equipmentKindChanged = hasSystemChange(changes, "equipmentKind");
	const nextIsContainer = isContainerChanged
		? systemChange(changes, "isContainer") === true ||
			String(systemChange(changes, "isContainer")).toLowerCase() === "true"
		: current.isContainer === true;
	const nextEquipmentKind = equipmentKindChanged
		? String(systemChange(changes, "equipmentKind") ?? "")
		: String(current.equipmentKind ?? EQUIPMENT_KIND.STANDARD);

	/* Explicitly choosing Ammunition converts the Item out of container role. */
	if (equipmentKindChanged && nextEquipmentKind === EQUIPMENT_KIND.AMMUNITION) {
		setSystemChange(changes, "isContainer", false);
		resetContainerRole(changes);
		return;
	}

	/* Checking Container wins over any stale Ammunition subtype. Also repair
	 * previously-authored contradictory Items on their next edit. */
	if (nextIsContainer) {
		setSystemChange(changes, "equipmentKind", EQUIPMENT_KIND.STANDARD);
		setSystemChange(changes, "ammunitionType", AMMUNITION_TYPE.NONE);
		setSystemChange(changes, "ammunitionCustomId", "");
		return;
	}

	/* When a container is explicitly removed, its container-only authored facts
	 * no longer describe the Item and should not remain hidden stale state. */
	if (isContainerChanged && !nextIsContainer) {
		resetContainerRole(changes);
	}

	if (equipmentKindChanged && nextEquipmentKind !== EQUIPMENT_KIND.AMMUNITION) {
		setSystemChange(changes, "ammunitionType", AMMUNITION_TYPE.NONE);
		setSystemChange(changes, "ammunitionCustomId", "");
	}
}

function resetContainerRole(changes) {
	setSystemChange(changes, "containerKind", CONTAINER_KIND.STANDARD);
	setSystemChange(changes, "containerAmmunitionType", AMMUNITION_TYPE.NONE);
	setSystemChange(changes, "containerAmmunitionCustomId", "");
	setSystemChange(changes, "containerCapacity", 0);
}

function hasSystemChange(changes, key) {
	const path = `system.${key}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

function systemChange(changes, key) {
	const path = `system.${key}`;
	return Object.hasOwn(changes, path)
		? changes[path]
		: foundry.utils.getProperty(changes, path);
}

function setSystemChange(changes, key, value) {
	const path = `system.${key}`;
	const flat = Object.keys(changes).some((entry) => entry.startsWith("system."));
	if (flat) changes[path] = value;
	else foundry.utils.setProperty(changes, path, value);
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
	const normalized = normalizedEquipmentTab(tab);
	if (!normalized) return;
	activeEquipmentTabs.set(sheet, normalized);
	const root = target?.closest?.("form") ?? sheet.element;
	activateEquipmentTab(root, normalized);
}

function activateEquipmentTab(root, tab) {
	if (!(root instanceof HTMLElement)) return;
	const normalized = normalizedEquipmentTab(tab) || "details";
	for (const panel of root.querySelectorAll("[data-equipment-tab-panel]")) {
		const active = panel.dataset.equipmentTabPanel === normalized;
		panel.hidden = !active;
		panel.classList.toggle("is-active", active);
	}
	for (const button of root.querySelectorAll("[data-equipment-tab-button]")) {
		const active = button.dataset.equipmentTabButton === normalized;
		button.classList.toggle("is-active", active);
		button.setAttribute("aria-selected", active ? "true" : "false");
		button.tabIndex = active ? 0 : -1;
	}
}

function normalizedEquipmentTab(value) {
	const normalized = String(value ?? "").trim();
	return EQUIPMENT_TABS.includes(normalized) ? normalized : "";
}

function positiveInteger(value, fallback = 1) {
	const number = Number(value);
	if (!Number.isFinite(number)) return Math.max(1, Math.trunc(fallback));
	return Math.max(1, Math.trunc(number));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
