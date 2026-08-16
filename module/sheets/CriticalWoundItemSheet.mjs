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
const CONSEQUENCE_PREFIX = "system.consequence.";

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
			/*
			 * Do not let ApplicationV2 expand and submit this entire form on every
			 * field change. `system.consequence` contains an array plus nested schema
			 * fields; partial expanded submissions can replace sibling data. We bind
			 * explicit per-control persistence in _onRender instead.
			 */
			submitOnChange: false,
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
				void updateConsequenceCharacteristic(this.document, event.currentTarget)
					.catch(reportAuthoringError);
			});
		}

		for (const input of this.element?.querySelectorAll?.("[name]") ?? []) {
			if (input.dataset?.consequenceCharacteristicField) continue;
			input.addEventListener("change", (event) => {
				void updateNamedControl(this.document, event.currentTarget)
					.catch(reportAuthoringError);
			});
		}
	}

	/**
	 * Safe fallback for an explicit/programmatic form submit.
	 *
	 * Normal editing never reaches this handler because submitOnChange is false.
	 * If the form is explicitly submitted, persist a complete consequence object
	 * plus the ordinary Item fields rather than trusting FormDataExtended's partial
	 * nested-object expansion.
	 *
	 * @this {CriticalWoundItemSheet}
	 */
	static async #handleFormSubmit(event, form, _formData) {
		if (!this.isEditable) return;
		event?.preventDefault?.();
		await persistFormSnapshot(this.document, form);
	}

	/** @this {CriticalWoundItemSheet} */
	static async #addConsequenceCharacteristic() {
		if (!this.isEditable) return;
		const consequence = consequenceSystemSource(this.document.system?.consequence);
		consequence.enabled = true;
		consequence.characteristics.push({
			characteristicId: "i",
			operation: "multiply",
			value: 0.5,
		});
		await this.document.update({ "system.consequence": consequence });
	}

	/** @this {CriticalWoundItemSheet} */
	static async #removeConsequenceCharacteristic(_event, target) {
		if (!this.isEditable) return;
		const index = Number(target?.closest?.("[data-consequence-characteristic-index]")?.dataset?.consequenceCharacteristicIndex);
		if (!Number.isInteger(index) || index < 0) return;
		const consequence = consequenceSystemSource(this.document.system?.consequence);
		consequence.characteristics.splice(index, 1);
		await this.document.update({ "system.consequence": consequence });
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
	entry[field] = field === "value" ? parseNumberControl(input) : String(input.value);
	consequence.enabled = true;
	await item.update({ "system.consequence": consequence });
}

async function updateNamedControl(item, control) {
	if (!isFormControl(control)) return;
	const name = String(control.name ?? "").trim();
	if (!name) return;

	if (name.startsWith(CONSEQUENCE_PREFIX)) {
		const consequence = consequenceSystemSource(item.system?.consequence);
		const relativePath = name.slice(CONSEQUENCE_PREFIX.length);
		setObjectPath(consequence, relativePath, formControlValue(control));
		await item.update({ "system.consequence": consequence });
		return;
	}

	await item.update({ [name]: formControlValue(control) });
}

async function persistFormSnapshot(item, form) {
	if (!form?.querySelectorAll) return;
	const update = {};
	const consequence = consequenceSystemSource(item.system?.consequence);
	let consequenceTouched = false;

	for (const control of form.querySelectorAll("[name]")) {
		if (!isFormControl(control) || control.disabled) continue;
		if (control.dataset?.consequenceCharacteristicField) continue;
		const name = String(control.name ?? "").trim();
		if (!name) continue;

		if (name.startsWith(CONSEQUENCE_PREFIX)) {
			setObjectPath(
				consequence,
				name.slice(CONSEQUENCE_PREFIX.length),
				formControlValue(control),
			);
			consequenceTouched = true;
		} else {
			update[name] = formControlValue(control);
		}
	}

	/* Characteristic rows are intentionally reconstructed as a complete array so
	 * an explicit submit cannot drop edits that have not blurred yet. */
	const rows = [...form.querySelectorAll("[data-consequence-characteristic-index]")];
	if (rows.length) {
		consequence.characteristics = rows.map(characteristicFromRow).filter(Boolean);
		consequenceTouched = true;
	}

	if (consequenceTouched) update["system.consequence"] = consequence;
	if (Object.keys(update).length) await item.update(update);
}

function characteristicFromRow(row) {
	const characteristicId = row.querySelector('[data-consequence-characteristic-field="characteristicId"]')?.value;
	const operation = row.querySelector('[data-consequence-characteristic-field="operation"]')?.value;
	const valueControl = row.querySelector('[data-consequence-characteristic-field="value"]');
	if (!characteristicId || !operation || !valueControl) return null;
	return {
		characteristicId: String(characteristicId),
		operation: String(operation),
		value: parseNumberControl(valueControl),
	};
}

function setObjectPath(target, path, value) {
	const parts = String(path ?? "").split(".").filter(Boolean);
	if (!parts.length) return;
	let cursor = target;
	for (let index = 0; index < parts.length - 1; index += 1) {
		const key = parts[index];
		if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
			cursor[key] = {};
		}
		cursor = cursor[key];
	}
	cursor[parts.at(-1)] = value;
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
		return parseNumberControl(control);
	}
	return String(control.value ?? "");
}

function parseNumberControl(control) {
	const raw = String(control?.value ?? "").trim().replace(",", ".");
	const number = Number(raw);
	return Number.isFinite(number) ? number : 0;
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
		periodicWoundsHeading: localize("Periodic Wound loss", "Okresowa utrata żywotności"),
		periodicWounds: localize("Loss", "Utrata"),
		periodicDurationFormula: localize("Duration", "Czas trwania"),
		periodicDurationUnits: localize("Periodic duration unit", "Jednostka czasu efektu"),
		periodicUntil: localize("Ending condition", "Warunek kończący"),
		dropHeld: localize("Drop held items", "Upuszczanie trzymanych przedmiotów"),
		characteristics: localize("Characteristic changes", "Zmiany cech"),
		addCharacteristic: localize("Add change", "Dodaj zmianę"),
		removeCharacteristic: localize("Remove change", "Usuń zmianę"),
		durationUnitOptions: {
			"": localize("None", "Brak"),
			rounds: localize("Rounds", "Rundy"),
		},
		periodicDurationUnitOptions: {
			"": localize("None", "Brak"),
			rounds: localize("Rounds", "Rundy"),
			minutes: localize("Minutes", "Minuty"),
			hours: localize("Hours", "Godziny"),
			days: localize("Days", "Dni"),
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

function reportAuthoringError(error) {
	console.error("WFRP1ED | Unable to update Critical Wound authoring data.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to save the Critical Wound change.",
		"Nie udało się zapisać zmiany rany krytycznej.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
