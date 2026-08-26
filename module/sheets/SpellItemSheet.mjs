import {
	SPELL_COST_INTERVAL,
	SPELL_TRADITION,
} from "../data-models/item/SpellData.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SPELL_TABS = Object.freeze(["details", "effects"]);
const activeSpellTabs = new WeakMap();

/** Native Foundry v14 authoring sheet for WFRP 1e Spell Items. */
export class SpellItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"combat-item-sheet",
			"spell-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: { width: 660, height: 720 },
		window: { resizable: true },
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
			template: "systems/wfrp1ed/templates/item/spell-item-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const system = this.document.system;

		context.item = this.document;
		context.system = system;
		context.editable = this.isEditable;
		context.ui = spellUi();
		context.traditionOptions = selectOptions(
			spellTraditionEntries(),
			system?.tradition,
		);
		context.levelOptions = selectOptions(
			spellLevelEntries(),
			system?.spellLevel,
		);
		context.costIntervalOptions = selectOptions(
			costIntervalEntries(),
			system?.magicPointCost?.interval,
		);
		context.effects = effectPresentation(this.document);

		return context;
	}

	_onRender(context, options) {
		super._onRender(context, options);
		activateSpellTab(
			this.element,
			normalizedSpellTab(activeSpellTabs.get(this)) || "details",
		);
	}

	/** @this {SpellItemSheet} */
	static #showDetails(_event, target) {
		setTab(this, "details", target);
	}

	/** @this {SpellItemSheet} */
	static #showEffects(_event, target) {
		setTab(this, "effects", target);
	}

	/** @this {SpellItemSheet} */
	static async #createEffect() {
		if (!this.isEditable) return;
		const [effect] = await this.document.createEmbeddedDocuments(
			"ActiveEffect",
			[{
				name: localize("New Effect", "Nowy efekt"),
				img: this.document.img || foundry.documents.ActiveEffect.DEFAULT_ICON,
				disabled: false,
				/* Knowing a Spell must not continuously apply its cast outcome. */
				transfer: false,
			}],
		);
		if (effect?.sheet) await effect.sheet.render({ force: true });
	}

	/** @this {SpellItemSheet} */
	static async #configureEffect(_event, target) {
		const effect = effectFromTarget(this, target);
		if (effect?.sheet) await effect.sheet.render({ force: true });
	}

	/** @this {SpellItemSheet} */
	static async #toggleEffect(_event, target) {
		if (!this.isEditable) return;
		const effect = effectFromTarget(this, target);
		if (effect) await effect.update({ disabled: !effect.disabled });
	}

	/** @this {SpellItemSheet} */
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

function spellTraditionEntries() {
	return [
		[SPELL_TRADITION.PETTY, localize("Petty Magic", "Magia prosta")],
		[SPELL_TRADITION.BATTLE, localize("Battle Magic", "Magia wojenna")],
		[SPELL_TRADITION.DEMONIC, localize("Demonic Magic", "Magia demoniczna")],
		[SPELL_TRADITION.DRUIDIC, localize("Druidic Magic", "Magia druidyczna")],
		[SPELL_TRADITION.ELEMENTAL, localize("Elemental Magic", "Magia elementarna")],
		[SPELL_TRADITION.ILLUSION, localize("Illusion Magic", "Magia iluzji")],
		[SPELL_TRADITION.NECROMANTIC, localize("Necromantic Magic", "Magia nekromancka")],
		[SPELL_TRADITION.CLERIC, localize("Clerical Magic", "Magia kapłańska")],
	];
}

function spellLevelEntries() {
	return [
		[0, localize("P — Petty Magic", "P — Magia prosta")],
		[1, localize("Level 1", "Poziom 1")],
		[2, localize("Level 2", "Poziom 2")],
		[3, localize("Level 3", "Poziom 3")],
		[4, localize("Level 4", "Poziom 4")],
	];
}

function costIntervalEntries() {
	return [
		[SPELL_COST_INTERVAL.CAST, localize("Once when cast", "Jednorazowo przy rzuceniu")],
		[SPELL_COST_INTERVAL.MISSILE, localize("Per missile", "Za pocisk")],
		[SPELL_COST_INTERVAL.ROUND, localize("Per round", "Za rundę")],
		[SPELL_COST_INTERVAL.TURN, localize("Per turn", "Za turę")],
		[SPELL_COST_INTERVAL.MINUTE, localize("Per minute", "Za minutę")],
		[SPELL_COST_INTERVAL.HOUR, localize("Per hour", "Za godzinę")],
		[SPELL_COST_INTERVAL.DAY, localize("Per day", "Za dzień")],
		[SPELL_COST_INTERVAL.WEEK, localize("Per week", "Za tydzień")],
		[SPELL_COST_INTERVAL.MONTH, localize("Per month", "Za miesiąc")],
		[SPELL_COST_INTERVAL.YEAR, localize("Per year", "Za rok")],
	];
}

function spellUi() {
	return Object.freeze({
		name: localize("Name", "Nazwa"),
		detailsTab: localize("Details", "Dane"),
		effectsTab: localize("Effects", "Efekty"),
		classification: localize("Spell", "Czar"),
		tradition: localize("Type of magic", "Typ magii"),
		spellLevel: localize("Spell level", "Poziom czaru"),
		casting: localize("Casting data", "Dane rzucania czaru"),
		magicPointAmount: localize("Magic Points", "Punkty magii"),
		magicPointInterval: localize("Cost interval", "Naliczanie kosztu"),
		range: localize("Range", "Zasięg"),
		duration: localize("Duration", "Czas trwania"),
		ingredients: localize("Ingredients", "Składniki"),
		description: localize("Description", "Opis"),
		addEffect: localize("Add Effect", "Dodaj efekt"),
		noEffects: localize("No Active Effects.", "Brak Aktywnych Efektów."),
		enabled: localize("Enabled", "Aktywny"),
		disabled: localize("Disabled", "Wyłączony"),
		effectsHint: localize(
			"Mechanical outcomes authored for this Spell. They do not transfer merely because a character knows the Spell.",
			"Efekty mechaniczne zapisane na tym Czarze. Nie przenoszą się tylko dlatego, że postać zna Czar.",
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
	const normalized = normalizedSpellTab(tab);
	if (!normalized) return;
	activeSpellTabs.set(sheet, normalized);
	const root = target?.closest?.("form") ?? sheet.element;
	activateSpellTab(root, normalized);
}

function activateSpellTab(root, tab) {
	if (!(root instanceof HTMLElement)) return;
	const normalized = normalizedSpellTab(tab) || "details";
	for (const panel of root.querySelectorAll("[data-spell-tab-panel]")) {
		const active = panel.dataset.spellTabPanel === normalized;
		panel.hidden = !active;
		panel.classList.toggle("is-active", active);
	}
	for (const button of root.querySelectorAll("[data-spell-tab-button]")) {
		const active = button.dataset.spellTabButton === normalized;
		button.classList.toggle("is-active", active);
		button.setAttribute("aria-selected", active ? "true" : "false");
		button.tabIndex = active ? 0 : -1;
	}
}

function normalizedSpellTab(value) {
	const normalized = String(value ?? "").trim();
	return SPELL_TABS.includes(normalized) ? normalized : "";
}

function selectOptions(entries, selectedValue) {
	const selected = String(selectedValue ?? "");
	return Object.freeze(entries.map(([value, label]) => Object.freeze({
		value,
		label,
		selected: String(value) === selected,
	})));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
