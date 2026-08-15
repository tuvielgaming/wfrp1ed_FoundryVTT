import {
	detailedCriticalEffectText,
	isCoreDetailedEffectProvider,
} from "../criticals/CoreDetailedCriticalTables.mjs";

const {
	ApplicationV2,
	DialogV2,
	HandlebarsApplicationMixin,
} = foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const TABLE_RESULT_FLAG_KEY = "detailedCriticalEffect";

/**
 * Dedicated Actor-side browser for persistent Critical Wound Items.
 *
 * The Classic sheet only exposes a compact category launcher. The wound window
 * owns the richer list UI and wound-specific actions so future health categories
 * (diseases, mutations, etc.) can use their own purpose-built windows instead of
 * forcing unrelated documents into one generic inventory panel.
 */
export class CriticalWoundsWindow extends HandlebarsApplicationMixin(
	ApplicationV2,
) {
	static #instances = new Map();

	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"critical-wounds-window",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 620,
			height: 520,
		},
		window: {
			icon: "fas fa-heart-crack",
			resizable: true,
		},
		actions: {
			addWound: this.#addWound,
			openWound: this.#openWound,
			removeWound: this.#removeWound,
		},
	};

	static PARTS = {
		body: {
			template:
				"systems/wfrp1ed/templates/apps/critical-wounds-window.hbs",
		},
	};

	constructor(actor, options = {}) {
		if (!isActor(actor)) {
			throw new Error(
				"Critical Wounds window requires an Actor document.",
			);
		}

		const id =
			options.id ??
			`wfrp1ed-critical-wounds-${safeApplicationId(actor.uuid)}`;

		super({
			...options,
			id,
		});

		this.actor = actor;
	}

	get title() {
		return `${localize("Critical Wounds", "Rany krytyczne")} — ${this.actor.name}`;
	}

	get canEdit() {
		return Boolean(
			game.user?.isGM ||
			this.actor.testUserPermission(
				game.user,
				CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
			),
		);
	}

	/**
	 * Open one reusable window per Actor.
	 *
	 * @param {Actor} actor
	 * @returns {Promise<CriticalWoundsWindow>}
	 */
	static async open(actor) {
		if (!isActor(actor)) {
			throw new Error(
				"Critical Wounds window requires an Actor document.",
			);
		}

		const key = actor.uuid;
		let application = this.#instances.get(key);

		if (!application) {
			application = new CriticalWoundsWindow(actor);
			this.#instances.set(key, application);
		}

		await application.render({ force: true });
		application.bringToFront();
		return application;
	}

	/**
	 * Refresh an already-open wound window after embedded Item changes.
	 *
	 * @param {Actor} actor
	 * @returns {Promise<void>}
	 */
	static async refresh(actor) {
		if (!isActor(actor)) return;

		const application = this.#instances.get(actor.uuid);
		if (!application?.rendered) return;

		await application.render({ force: true });
	}

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const wounds = criticalWounds(this.actor);

		context.actor = {
			id: this.actor.id,
			uuid: this.actor.uuid,
			name: this.actor.name,
		};
		context.editable = this.canEdit;
		context.wounds = wounds.map(woundPresentation);
		context.woundCount = wounds.length;
		context.ui = {
			title: localize("Critical Wounds", "Rany krytyczne"),
			hint: localize(
				"Persistent injuries carried by this character. Open a wound to inspect its description, resolution provenance, and Active Effects.",
				"Trwałe obrażenia tej postaci. Otwórz ranę, aby sprawdzić jej opis, dane rozstrzygnięcia i Aktywne Efekty.",
			),
			add: localize("Add Critical Wound", "Dodaj ranę krytyczną"),
			open: localize("Open wound", "Otwórz ranę"),
			remove: localize("Remove wound", "Usuń ranę"),
			empty: localize(
				"This character has no Critical Wounds.",
				"Ta postać nie ma ran krytycznych.",
			),
			criticalValue: localize("Critical value", "Wartość krytyczna"),
			location: localize("Location", "Umiejscowienie"),
			effects: localize("Effects", "Efekty"),
		};

		return context;
	}

	_onClose(options) {
		super._onClose(options);

		if (
			CriticalWoundsWindow.#instances.get(this.actor.uuid) === this
		) {
			CriticalWoundsWindow.#instances.delete(this.actor.uuid);
		}
	}

	/** @this {CriticalWoundsWindow} */
	static async #addWound(event) {
		event.preventDefault();

		if (!this.canEdit) {
			ui.notifications.warn(
				localize(
					"You do not have permission to edit this Actor.",
					"Nie masz uprawnień do edycji tej postaci.",
				),
			);
			return;
		}

		const created = await this.actor.createEmbeddedDocuments(
			"Item",
			[
				{
					name: localize(
						"New Critical Wound",
						"Nowa rana krytyczna",
					),
					type: "criticalWound",
				},
			],
		);

		const wound = created[0];
		await this.render({ force: true });

		if (wound?.sheet) {
			await wound.sheet.render({ force: true });
		}
	}

	/** @this {CriticalWoundsWindow} */
	static async #openWound(event, target) {
		event.preventDefault();

		const wound = woundFromTarget(this.actor, target);
		await wound.sheet.render({ force: true });
	}

	/** @this {CriticalWoundsWindow} */
	static async #removeWound(event, target) {
		event.preventDefault();

		if (!this.canEdit) {
			ui.notifications.warn(
				localize(
					"You do not have permission to edit this Actor.",
					"Nie masz uprawnień do edycji tej postaci.",
				),
			);
			return;
		}

		const wound = woundFromTarget(this.actor, target);
		const confirmed = await DialogV2.confirm({
			window: {
				title: localize(
					"Remove Critical Wound",
					"Usuń ranę krytyczną",
				),
			},
			content: localize(
				"Remove this Critical Wound and its embedded Active Effects from the character?",
				"Usunąć tę ranę krytyczną wraz z jej osadzonymi Aktywnymi Efektami z postaci?",
			),
			rejectClose: false,
			modal: true,
		});

		if (!confirmed) return;

		await this.actor.deleteEmbeddedDocuments("Item", [wound.id]);
		await this.render({ force: true });
	}
}

function criticalWounds(actor) {
	return [...(actor.items ?? [])]
		.filter((item) => item.type === "criticalWound")
		.sort((first, second) => {
			const sortDifference =
				Number(first.sort ?? 0) - Number(second.sort ?? 0);

			if (sortDifference !== 0) return sortDifference;

			return String(first.name ?? "").localeCompare(
				String(second.name ?? ""),
				game.i18n.lang,
				{ sensitivity: "base" },
			);
		});
}

function woundPresentation(item) {
	const description = coreDescription(item) ||
		String(item.system?.description ?? "").trim();
	const hitLocation = String(item.system?.hitLocation ?? "").trim();
	const criticalValue = Math.max(
		0,
		Math.trunc(Number(item.system?.criticalValue) || 0),
	);
	const effectCount = Number(
		item.effects?.size ?? item.effects?.contents?.length ?? 0,
	);

	return {
		id: item.id,
		uuid: item.uuid,
		name: item.name ?? "",
		img:
			item.img ||
			foundry.documents.Item.DEFAULT_ICON,
		description: preview(description, 150),
		hitLocation,
		criticalValue,
		effectCount: Number.isFinite(effectCount) ? effectCount : 0,
	};
}

function coreDescription(item) {
	const resolution = item?.system?.resolution;
	if (!isCoreDetailedEffectProvider(resolution?.providerId)) return "";

	const location = effectLocation(item.system?.hitLocation);
	const effectNumber = coreEffectNumber(resolution);
	if (!location || !effectNumber) return "";

	return detailedCriticalEffectText(
		location,
		effectNumber,
		game.i18n.lang,
	);
}

function coreEffectNumber(resolution) {
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
		case "leftLeg": return "leg";
		case "rightArm":
		case "leftArm": return "arm";
		case "head": return "head";
		case "body": return "body";
		default: return "";
	}
}

function woundFromTarget(actor, target) {
	const itemId = String(
		target?.closest?.("[data-item-id]")?.dataset?.itemId ?? "",
	).trim();

	const wound = itemId ? actor.items.get(itemId) : null;

	if (!wound || wound.type !== "criticalWound") {
		throw new Error(
			`Embedded Critical Wound Item '${itemId}' was not found.`,
		);
	}

	return wound;
}

function preview(value, limit) {
	if (!value || value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function safeApplicationId(value) {
	return String(value ?? "actor")
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "actor";
}

function isActor(document) {
	return Boolean(
		document &&
		document.documentName === "Actor",
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
