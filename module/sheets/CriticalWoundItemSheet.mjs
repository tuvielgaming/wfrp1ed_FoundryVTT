const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } =
	foundry.applications.api;

/**
 * Native Foundry v14 sheet for persistent Critical Wound Items.
 *
 * The sheet intentionally distinguishes three concerns:
 * - editable injury identity/content in Item.system;
 * - read-only resolution provenance used for audit/debugging;
 * - native embedded ActiveEffects which own ongoing mechanical consequences.
 *
 * Exact WFRP injury mechanics are not authored by this sheet. A future audited
 * detailed-critical resolver will create the Item and its effects from verified
 * Core table data.
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
			width: 620,
			height: 720,
		},
		tag: "form",
		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},
		actions: {
			createEffect: this.#createEffect,
			configureEffect: this.#configureEffect,
			toggleEffect: this.#toggleEffect,
			deleteEffect: this.#deleteEffect,
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

		context.item = this.document;
		context.system = this.document.system;
		context.editable = this.isEditable;
		context.effects = buildEffectPresentation(this.document);
		context.provenanceRows = buildProvenancePresentation(
			this.document.system?.resolution,
		);
		context.ui = sheetLabels();

		return context;
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

	if (key === "roll" && Number(value) <= 0) return "";
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
		effects: localize("Active Effects", "Aktywne efekty"),
		effectsHint: localize(
			"Ongoing mechanical consequences belong to native Foundry ActiveEffects embedded in this wound Item.",
			"Trwałe konsekwencje mechaniczne należą do natywnych Aktywnych Efektów Foundry osadzonych w tym przedmiocie rany.",
		),
		addEffect: localize("Add Effect", "Dodaj efekt"),
		configureEffect: localize(
			"Open Foundry effect settings",
			"Otwórz ustawienia efektu Foundry",
		),
		deleteEffect: localize("Delete effect", "Usuń efekt"),
		noEffects: localize(
			"No Active Effects are attached to this wound.",
			"Do tej rany nie przypisano Aktywnych Efektów.",
		),
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
