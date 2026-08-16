import {
	detailedCriticalEffectText,
	isCoreDetailedEffectProvider,
} from "../criticals/CoreDetailedCriticalTables.mjs";
import { consequenceSystemSource } from "../criticals/CriticalConsequenceDefinition.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } =
	foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const TABLE_RESULT_FLAG_KEY = "detailedCriticalEffect";

/**
 * Native Foundry v14 sheet for persistent Critical Wound Items.
 *
 * Critical automation is authored as data on the Item. Core Rulebook wounds use
 * the same editor/contract as custom wounds, so adding a new wound does not
 * require a JavaScript case keyed to a Critical result number.
 */
export class CriticalWoundItemSheet extends HandlebarsApplicationMixin(
	ItemSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"critical-wound-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 680,
			height: 790,
		},
		tag: "form",
		form: {
			handler: this.#handleFormSubmit,
			submitOnChange: true,
			closeOnSubmit: false,
		},
		actions: {
			createEffect: this.#createEffect,
			configureEffect: this.#configureEffect,
			toggleEffect: this.#toggleEffect,
			deleteEffect: this.#deleteEffect,
			addConsequenceCharacteristic: this.#addConsequenceCharacteristic,
			removeConsequenceCharacteristic: this.#removeConsequenceCharacteristic,
		},
	};

	static PARTS = {
		form: {
			template:
				"systems/wfrp1ed/templates/item/critical-wound-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const description = buildDescriptionPresentation(this.document);

		context.item = this.document;
		context.system = this.document.system;
		context.editable = this.isEditable;
		context.description = description.text;
		context.descriptionManagedByCore = description.managedByCore;
		context.effects = buildEffectPresentation(this.document);
		context.provenanceRows = buildProvenancePresentation(
			this.document.system?.resolution,
		);
		context.consequence = consequenceSystemSource(this.document.system?.consequence);
		context.ui = sheetLabels();

		return context;
	}

	_onRender(context, options) {
		super._onRender(context, options);
		if (!this.isEditable) return;
		for (const input of this.element?.querySelectorAll?.("[data-consequence-characteristic-field]") ?? []) {
			input.addEventListener("change", (event) => {
				void updateConsequenceCharacteristic(this.document, event.currentTarget);
			});
		}
	}

	/**
	 * Persist only the form control which actually changed.
	 *
	 * Foundry ApplicationV2 expands the entire submitted form into an update
	 * object. The characteristic editor deliberately uses an array which is
	 * updated transactionally by its own handlers; submitting the rest of the
	 * form at the same time can therefore replace `system.consequence` with a
	 * partial object and erase sibling fields. A per-control update avoids that
	 * destructive race and also keeps Add/Remove Change actions independent.
	 *
	 * @this {CriticalWoundItemSheet}
	 */
	static async #handleFormSubmit(event, _form, _formData) {
		if (!this.isEditable) return;
		const control = event?.target;
		if (!isFormControl(control)) return;

		/* Characteristic rows have an explicit array-aware update handler. Ignore
		 * the same bubbling change event here so the two update paths cannot race. */
		if (control.dataset?.consequenceCharacteristicField) return;

		const name = String(control.name ?? "").trim();
		if (!name) return;
		await this.document.update({
			[name]: formControlValue(control),
		});
	}

	/** @this {CriticalWoundItemSheet} */
	static async #addConsequenceCharacteristic() {
		if (!this.isEditable) return;
		const consequence = consequenceSystemSource(this.document.system?.consequence);
		await this.document.update({
			"system.consequence.enabled": true,
			"system.consequence.characteristics": [
				...consequence.characteristics,
				{
					characteristicId: "i",
					operation: "multiply",
					value: 0.5,
				},
			],
		});
	}

	/** @this {CriticalWoundItemSheet} */
	static async #removeConsequenceCharacteristic(_event, target) {
		if (!this.isEditable) return;
		const index = Number(target?.closest?.("[data-consequence-characteristic-index]")?.dataset?.consequenceCharacteristicIndex);
		if (!Number.isInteger(index) || index < 0) return;
		const consequence = consequenceSystemSource(this.document.system?.consequence);
		consequence.characteristics.splice(index, 1);
		await this.document.update({
			"system.consequence.characteristics": consequence.characteristics,
		});
	}

	/** @this {CriticalWoundItemSheet} */
	static async #createEffect() {
		if (!this.isEditable) return;

		const [effect] = await this.document.createEmbeddedDocuments(
			"ActiveEffect",
			[
				{
					name: localize(
						"New wound effect",
						"Nowy efekt rany",
					),
					img:
						this.document.img ||
						foundry.documents.ActiveEffect.DEFAULT_ICON,
					disabled: false,
					transfer: true,
					system: {
						changes: [],
					},
				},
			],
		);

		if (effect?.sheet) {
			await effect.sheet.render({ force: true });
		}
	}

	/** @this {CriticalWoundItemSheet} */
	static async #configureEffect(_event, target) {
		const effect = effectFromTarget(this, target);
		if (effect?.sheet) {
			await effect.sheet.render({ force: true });
		}
	}

	/** @this {CriticalWoundItemSheet} */
	static async #toggleEffect(_event, target) {
		if (!this.isEditable) return;

		const effect = effectFromTarget(this, target);
		if (effect) {
			await effect.update({ disabled: !effect.disabled });
		}
	}

	/** @this {CriticalWoundItemSheet} */
	static async #deleteEffect(_event, target) {
		if (!this.isEditable) return;

		const effect = effectFromTarget(this, target);
		if (!effect) return;

		const confirmed = await DialogV2.confirm({
			content: localize(
				`Delete wound effect '${effect.name}'?`,
				`Usunąć efekt rany „${effect.name}”?`,
			),
			rejectClose: false,
			modal: true,
		});

		if (confirmed) {
			await effect.delete();
		}
	}
}

async function updateConsequenceCharacteristic(item, input) {
	const row = input?.closest?.("[data-consequence-characteristic-index]");
	const index = Number(row?.dataset?.consequenceCharacteristicIndex);
	const field = String(input?.dataset?.consequenceCharacteristicField ?? "");
	if (!Number.isInteger(index) || index < 0 || !["characteristicId", "operation", "value"].includes(field)) return;

	const consequence = consequenceSystemSource(item.system?.consequence);
	const entry = consequence.characteristics[index];
	if (!entry) return;
	entry[field] = field === "value" ? Number(input.value) : String(input.value);
	await item.update({
		"system.consequence.enabled": true,
		"system.consequence.characteristics": consequence.characteristics,
	});
}

function isFormControl(value) {
	return Boolean(
		value &&
		typeof value === "object" &&
		["INPUT", "SELECT", "TEXTAREA"].includes(String(value.tagName ?? "")),
	);
}

function formControlValue(control) {
	if (String(control.type ?? "").toLowerCase() === "checkbox") {
		return control.checked === true;
	}
	if (String(control.type ?? "").toLowerCase() === "number") {
		const number = Number(control.value);
		return Number.isFinite(number) ? number : 0;
	}
	return String(control.value ?? "");
}

function buildDescriptionPresentation(item) {
	const fallback = String(item?.system?.description ?? "");
	const resolution = item?.system?.resolution;
	if (!isCoreDetailedEffectProvider(resolution?.providerId)) {
		return {
			text: fallback,
			managedByCore: false,
		};
	}

	const location = effectLocation(item?.system?.hitLocation);
	const effectNumber = coreEffectNumber(resolution);
	if (!location || !effectNumber) {
		return {
			text: fallback,
			managedByCore: false,
		};
	}

	const text = detailedCriticalEffectText(
		location,
		effectNumber,
		game.i18n.lang,
	);
	return {
		text: text || fallback,
		managedByCore: Boolean(text),
	};
}

function coreEffectNumber(resolution) {
	const direct = Number(resolution?.effectNumber);
	if (Number.isInteger(direct) && direct > 0) return direct;

	const tableUuid = String(resolution?.tableUuid ?? "").trim();
	const resultId = String(resolution?.tableResultId ?? "").trim();
	if (!tableUuid || !resultId) return 0;

	try {
		const table = foundry.utils.fromUuidSync(tableUuid);
		const result = table?.results?.get?.(resultId) ??
			[...(table?.results ?? [])].find((entry) => String(entry.id) === resultId);
		const flag = result?.getFlag?.(FLAG_SCOPE, TABLE_RESULT_FLAG_KEY);
		const number = Number(flag?.effectNumber);
		return Number.isInteger(number) && number > 0 ? number : 0;
	} catch (_error) {
		return 0;
	}
}

function effectLocation(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "rightLeg":
		case "leftLeg":
		case "leg": return "leg";
		case "rightArm":
		case "leftArm":
		case "arm": return "arm";
		case "head": return "head";
		case "body": return "body";
		default: return "";
	}
}

function buildEffectPresentation(item) {
	return [...(item.effects ?? [])]
		.sort((first, second) =>
			String(first.name ?? "").localeCompare(
				String(second.name ?? ""),
				game.i18n.lang,
				{ sensitivity: "base" },
			),
		)
		.map((effect) => ({
			id: effect.id,
			name: effect.name,
			img:
				effect.img ||
				foundry.documents.ActiveEffect.DEFAULT_ICON,
			disabled: effect.disabled === true,
			transfer: effect.transfer === true,
			stateLabel: effect.disabled
				? localize("Disabled", "Wyłączony")
				: localize("Enabled", "Włączony"),
			toggleLabel: effect.disabled
				? localize("Enable effect", "Włącz efekt")
				: localize("Disable effect", "Wyłącz efekt"),
		}));
}

function buildProvenancePresentation(resolution) {
	const source = resolution?.toObject?.() ?? resolution ?? {};
	const definitions = [
		["damagePacketId", "Damage packet", "Pakiet obrażeń"],
		["sourceMessageId", "Source message", "Wiadomość źródłowa"],
		["resultMessageId", "Result message", "Wiadomość wyniku"],
		["tableRole", "Table role", "Rola tabeli"],
		["tableVariant", "Table variant", "Wariant tabeli"],
		["providerId", "Provider", "Dostawca"],
		["tableUuid", "RollTable UUID", "UUID tabeli"],
		["tableResultId", "Table result", "Wynik tabeli"],
		["effectNumber", "Critical effect", "Efekt krytyczny"],
		["roll", "Resolution roll", "Rzut rozstrzygający"],
		["resolvedByUserId", "Resolved by", "Rozstrzygnął"],
		["resolvedAt", "Resolved at", "Czas rozstrzygnięcia"],
	];

	return definitions
		.map(([key, english, polish]) => ({
			key,
			label: localize(english, polish),
			value: provenanceValue(key, source[key]),
		}))
		.filter((row) => row.value !== "");
}

function provenanceValue(key, value) {
	if (value === undefined || value === null || value === "") {
		return "";
	}

	if (key === "resolvedAt") {
		const timestamp = Number(value);
		if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
		return new Date(timestamp).toLocaleString(game.i18n.lang);
	}

	if ((key === "roll" || key === "effectNumber") && Number(value) <= 0) return "";
	return String(value);
}

function sheetLabels() {
	return {
		criticalValue: localize("Critical value", "Wartość krytyczna"),
		hitLocation: localize("Hit location", "Umiejscowienie"),
		description: localize("Injury description", "Opis obrażenia"),
		provenance: localize("Resolution provenance", "Dane rozstrzygnięcia"),
		provenanceEmpty: localize(
			"This wound has not been linked to a detailed critical resolution yet.",
			"Ta rana nie jest jeszcze powiązana z rozstrzygnięciem trafienia krytycznego.",
		),
		consequences: localize("Automatic consequences", "Automatyczne konsekwencje"),
		consequencesHint: localize(
			"These declarations are executed when the wound is placed on an Actor. They are not tied to a Core Critical number.",
			"Te deklaracje są wykonywane po dodaniu rany do postaci. Nie są powiązane na stałe z numerem efektu z podręcznika.",
		),
		automationEnabled: localize("Enable automation", "Włącz automatykę"),
		durationFormula: localize("Duration formula", "Formuła czasu"),
		durationUnits: localize("Duration units", "Jednostka czasu"),
		until: localize("Until", "Do kiedy"),
		periodicWounds: localize("Wounds each round", "Żywotność na rundę"),
		periodicUntil: localize("Periodic effect until", "Efekt okresowy do"),
		dropHeld: localize("Drop held items", "Upuszczanie trzymanych przedmiotów"),
		characteristics: localize("Characteristic changes", "Zmiany cech"),
		addCharacteristic: localize("Add change", "Dodaj zmianę"),
		removeCharacteristic: localize("Remove change", "Usuń zmianę"),
		durationUnitOptions: {
			"": localize("None", "Brak"),
			rounds: localize("Rounds", "Rundy"),
		},
		untilOptions: {
			"": localize("None", "Brak"),
			"medical-attention": localize("Medical attention", "Pomoc medyczna"),
		},
		dropHeldOptions: {
			"": localize("None", "Brak"),
			"injured-hand": localize("Injured hand", "Zraniona ręka"),
			all: localize("All held items", "Wszystkie trzymane przedmioty"),
		},
		characteristicOptions: {
			m: localize("Movement (M)", "Szybkość (Sz)"), ws: "WW", bs: "US", s: "S", t: "Wt", w: "Żw",
			i: localize("Initiative (I)", "Inicjatywa (I)"), a: "A", dex: "Zr", ld: "CP", int: "Int", cl: "Op", wp: "SW", fel: "Ogd",
		},
		operationOptions: {
			add: localize("Add", "Dodaj"),
			subtract: localize("Subtract", "Odejmij"),
			multiply: localize("Multiply", "Pomnóż"),
			override: localize("Set value", "Ustaw wartość"),
		},
		effects: localize("Active Effects", "Aktywne efekty"),
		effectsHint: localize(
			"Runtime consequences and any additional manual effects are represented by native Foundry ActiveEffects embedded in this wound Item.",
			"Konsekwencje wykonawcze oraz dodatkowe ręczne efekty są reprezentowane przez natywne Aktywne Efekty Foundry osadzone w tej ranie.",
		),
		addEffect: localize("Add Effect", "Dodaj efekt"),
		configureEffect: localize("Open Foundry effect settings", "Otwórz ustawienia efektu Foundry"),
		deleteEffect: localize("Delete effect", "Usuń efekt"),
		noEffects: localize("No Active Effects are attached to this wound.", "Do tej rany nie przypisano Aktywnych Efektów."),
		transfers: localize("Transfers to Actor", "Działa na postać"),
	};
}

function effectFromTarget(application, target) {
	const id = target
		?.closest?.("[data-effect-id]")
		?.dataset?.effectId;

	return id
		? application.document.effects.get(id) ?? null
		: null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
