import { DisplayBuilder } from "../display/DisplayBuilder.mjs";
import { LayoutManager } from "./LayoutManager.mjs";
import { ThemeManager } from "./ThemeManager.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class ClassicActorSheet extends HandlebarsApplicationMixin(
	ActorSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"actor",
			"classic-actor-sheet",
		],

		position: {
			width: 1100,
			height: 900,
		},

		tag: "form",

		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},

		actions: {
			rollCharacteristic:
				ClassicActorSheet.#onCharacteristicRoll,

			advanceCharacteristic:
				ClassicActorSheet.#onCharacteristicAdvance,

			addCareerHistoryEntry:
				ClassicActorSheet.#onAddCareerHistoryEntry,

			removeCareerHistoryEntry:
				ClassicActorSheet.#onRemoveCareerHistoryEntry,

			addCareerExit:
				ClassicActorSheet.#onAddCareerExit,

			removeCareerExit:
				ClassicActorSheet.#onRemoveCareerExit,
		},
	};

	static PARTS = {
		form: {
			template:
				"systems/wfrp1ed/templates/actors/classic/" +
				"character-sheet.hbs",
		},
	};

	/**
	 * Prepare the complete Classic-sheet rendering context.
	 *
	 * ThemeManager resolves localized visual assets.
	 * LayoutManager resolves matching localized geometry.
	 * DisplayBuilder prepares immutable Actor presentation data.
	 *
	 * @param {Object} options
	 * @returns {Promise<Object>}
	 */
	async _prepareContext(options) {
		const context = await super._prepareContext(options);

		const theme = ThemeManager.getTheme("classic");

		const layout = LayoutManager.getLayout("classic", {
			theme,
		});

		const pages = ClassicActorSheet.#preparePages(
			theme,
			layout,
		);

		context.system = this.document.system;
		context.config = CONFIG.WFRP1ED;
		context.display =
			ClassicActorSheet.#prepareDisplay(this.document);

		context.theme = theme;
		context.layout = layout;
		context.pages = pages;
		context.editable = this.isEditable;

		/*
		 * Temporary compatibility for templates that still read the former
		 * single-page background property. The canonical rendering model is
		 * the two-page `pages` collection.
		 */
		context.sheetBackground =
			pages.find((page) => page.number === 1)?.background ??
			null;

		return context;
	}

	/**
	 * Preserve blank editable list entries which DisplayBuilder normally omits
	 * from read-only presentation collections.
	 *
	 * This lets a newly added career-history or career-exit entry render as an
	 * empty input without mutating the immutable DisplayBuilder result.
	 *
	 * @param {Actor} document
	 * @returns {Readonly<Object>}
	 * @protected
	 */
	static #prepareDisplay(document) {
		const display = DisplayBuilder.build(document);
		const details = document.system?.details ?? {};

		return Object.freeze({
			...display,

			details: Object.freeze({
				...display.details,

				careerHistory: Object.freeze(
					ClassicActorSheet.#normalizeCareerHistory(
						details.careerHistory ??
							details.careerTrack,
						{
							freeze: true,
						},
					),
				),

				careerExits: Object.freeze(
					ClassicActorSheet.#normalizeCareerExits(
						details.careerExits,
					),
				),
			}),
		});
	}

	/**
	 * Combine visual assets and geometry into page rendering models.
	 *
	 * @param {Object} theme
	 * @param {Object} layout
	 * @returns {readonly Object[]}
	 * @protected
	 */
	static #preparePages(theme, layout) {
		const themePages = new Map(
			theme.pages.map((page) => [page.number, page]),
		);

		const pages = layout.pages.map((layoutPage) => {
			const themePage = themePages.get(layoutPage.number);

			if (!themePage) {
				throw new Error(
					`Classic theme has no visual asset for layout ` +
						`page ${layoutPage.number}.`,
				);
			}

			return Object.freeze({
				number: layoutPage.number,
				background: themePage.path,

				source: Object.freeze({
					width: themePage.nativeWidth,
					height: themePage.nativeHeight,
				}),

				canvas: layoutPage.canvas,

				sections:
					ClassicActorSheet.#prepareSections(
						layoutPage.sections,
					),

				cssVariables:
					ClassicActorSheet.#pageCssVariables(
						themePage,
						layoutPage,
					),
			});
		});

		return Object.freeze(pages);
	}

	/**
	 * Prepare immutable section models with CSS positioning variables.
	 *
	 * @param {Object} sections
	 * @returns {Object}
	 * @protected
	 */
	static #prepareSections(sections) {
		const preparedSections = Object.entries(sections).map(
			([id, geometry]) => {
				const section = Object.freeze({
					id,
					x: geometry.x,
					y: geometry.y,
					width: geometry.width,
					height: geometry.height,

					cssVariables: [
						`--section-x: ${geometry.x}px`,
						`--section-y: ${geometry.y}px`,
						`--section-width: ${geometry.width}px`,
						`--section-height: ${geometry.height}px`,
					].join("; "),
				});

				return [id, section];
			},
		);

		return Object.freeze(
			Object.fromEntries(preparedSections),
		);
	}

	/**
	 * Prepare trusted CSS variables for one page canvas.
	 *
	 * @param {Object} themePage
	 * @param {Object} layoutPage
	 * @returns {string}
	 * @protected
	 */
	static #pageCssVariables(themePage, layoutPage) {
		return [
			`--page-width: ${layoutPage.canvas.width}px`,
			`--page-height: ${layoutPage.canvas.height}px`,
			`--page-background: url(${themePage.path})`,
		].join("; ");
	}

	/**
	 * Execute a registered characteristic test.
	 *
	 * @this {ClassicActorSheet}
	 * @param {PointerEvent} event
	 * @param {HTMLElement} target
	 * @returns {Promise<void>}
	 */
	static async #onCharacteristicRoll(event, target) {
		event.preventDefault();

		const characteristicId = String(
			target.dataset.characteristic ?? "",
		).trim();

		if (!characteristicId) {
			ui.notifications.error(
				"Characteristic roll action has no characteristic id.",
			);

			return;
		}

		try {
			await this.document.rollCharacteristic(
				characteristicId,
			);
		} catch (error) {
			console.error(
				`WFRP1ED | Unable to roll characteristic ` +
					`'${characteristicId}'.`,
				error,
			);

			ui.notifications.error(
				error.message ??
					"Unable to roll the characteristic.",
			);
		}
	}

	/**
	 * Interpret one advancement-row click.
	 *
	 * Ctrl/Cmd + click purchases one advance.
	 * Shift + click undoes the latest eligible purchase.
	 * An ordinary click deliberately performs no persistent action.
	 *
	 * @this {ClassicActorSheet}
	 * @param {PointerEvent} event
	 * @param {HTMLElement} target
	 * @returns {Promise<void>}
	 */
	static async #onCharacteristicAdvance(event, target) {
		event.preventDefault();

		const primaryModifier =
			event.ctrlKey || event.metaKey;

		const undoModifier = event.shiftKey;

		if (!primaryModifier && !undoModifier) {
			return;
		}

		if (primaryModifier && undoModifier) {
			ui.notifications.warn(
				"Use Ctrl/Cmd + click to buy or Shift + click to undo, " +
					"not both at the same time.",
			);

			return;
		}

		if (!this.isEditable) {
			ui.notifications.warn(
				"You do not have permission to edit this Actor.",
			);

			return;
		}

		const characteristicId = String(
			target.dataset.characteristic ?? "",
		).trim();

		if (!characteristicId) {
			ui.notifications.error(
				"Characteristic advancement action has no " +
					"characteristic id.",
			);

			return;
		}

		try {
			if (primaryModifier) {
				const transaction =
					await this.document
						.purchaseCharacteristicAdvance(
							characteristicId,
						);

				ui.notifications.info(
					`Purchased one '${characteristicId}' advance for ` +
						`${transaction.cost} Experience Points.`,
				);

				return;
			}

			const transaction =
				await this.document
					.undoLastCharacteristicAdvance(
						characteristicId,
					);

			ui.notifications.info(
				`Undid the latest '${characteristicId}' advance and ` +
					`refunded ${transaction.cost} Experience Points.`,
			);
		} catch (error) {
			const operation = primaryModifier
				? "purchase"
				: "undo";

			console.error(
				`WFRP1ED | Unable to ${operation} characteristic ` +
					`advance '${characteristicId}'.`,
				error,
			);

			ui.notifications.error(
				error.message ??
					`Unable to ${operation} the characteristic advance.`,
			);
		}
	}

	/**
	 * Add one blank career-history row.
	 *
	 * @this {ClassicActorSheet}
	 * @param {PointerEvent} event
	 * @returns {Promise<void>}
	 */
	static async #onAddCareerHistoryEntry(event) {
		event.preventDefault();

		await ClassicActorSheet.#runEditableAction(
			this,
			"add a career-history entry",
			async () => {
				const entries =
					ClassicActorSheet.#readCareerHistory(
						this.document,
					);

				entries.push({
					name: "",
					uuid: "",
					completed: false,
				});

				await this.document.update({
					"system.details.careerHistory": entries,
				});
			},
		);
	}

	/**
	 * Remove one career-history row by its rendered array index.
	 *
	 * @this {ClassicActorSheet}
	 * @param {PointerEvent} event
	 * @param {HTMLElement} target
	 * @returns {Promise<void>}
	 */
	static async #onRemoveCareerHistoryEntry(event, target) {
		event.preventDefault();

		await ClassicActorSheet.#runEditableAction(
			this,
			"remove a career-history entry",
			async () => {
				const entries =
					ClassicActorSheet.#readCareerHistory(
						this.document,
					);

				const index =
					ClassicActorSheet.#arrayIndex(
						target.dataset.index,
						entries.length,
						"Career-history entry",
					);

				entries.splice(index, 1);

				await this.document.update({
					"system.details.careerHistory": entries,
				});
			},
		);
	}

	/**
	 * Add one blank career-exit row.
	 *
	 * @this {ClassicActorSheet}
	 * @param {PointerEvent} event
	 * @returns {Promise<void>}
	 */
	static async #onAddCareerExit(event) {
		event.preventDefault();

		await ClassicActorSheet.#runEditableAction(
			this,
			"add a career exit",
			async () => {
				const entries =
					ClassicActorSheet.#readCareerExits(
						this.document,
					);

				entries.push("");

				await this.document.update({
					"system.details.careerExits": entries,
				});
			},
		);
	}

	/**
	 * Remove one career-exit row by its rendered array index.
	 *
	 * @this {ClassicActorSheet}
	 * @param {PointerEvent} event
	 * @param {HTMLElement} target
	 * @returns {Promise<void>}
	 */
	static async #onRemoveCareerExit(event, target) {
		event.preventDefault();

		await ClassicActorSheet.#runEditableAction(
			this,
			"remove a career exit",
			async () => {
				const entries =
					ClassicActorSheet.#readCareerExits(
						this.document,
					);

				const index =
					ClassicActorSheet.#arrayIndex(
						target.dataset.index,
						entries.length,
						"Career-exit entry",
					);

				entries.splice(index, 1);

				await this.document.update({
					"system.details.careerExits": entries,
				});
			},
		);
	}

	/**
	 * Execute one editable sheet action with consistent permission and error
	 * handling.
	 *
	 * @param {ClassicActorSheet} sheet
	 * @param {string} operation
	 * @param {Function} action
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async #runEditableAction(
		sheet,
		operation,
		action,
	) {
		if (!sheet.isEditable) {
			ui.notifications.warn(
				"You do not have permission to edit this Actor.",
			);

			return;
		}

		try {
			await action();
		} catch (error) {
			console.error(
				`WFRP1ED | Unable to ${operation}.`,
				error,
			);

			ui.notifications.error(
				error.message ??
					`Unable to ${operation}.`,
			);
		}
	}

	/**
	 * Read a mutable copy of persisted career-history entries.
	 *
	 * @param {Actor} document
	 * @returns {Object[]}
	 * @protected
	 */
	static #readCareerHistory(document) {
		const details = document.system?.details ?? {};

		return ClassicActorSheet.#normalizeCareerHistory(
			details.careerHistory ?? details.careerTrack,
		);
	}

	/**
	 * Read a mutable copy of persisted career exits.
	 *
	 * @param {Actor} document
	 * @returns {string[]}
	 * @protected
	 */
	static #readCareerExits(document) {
		return ClassicActorSheet.#normalizeCareerExits(
			document.system?.details?.careerExits,
		);
	}

	/**
	 * Normalize native or temporary legacy career-history data.
	 * Blank array rows are deliberately preserved for editing.
	 *
	 * @param {*} value
	 * @param {Object} options
	 * @param {boolean} [options.freeze=false]
	 * @returns {Object[]}
	 * @protected
	 */
	static #normalizeCareerHistory(
		value,
		{
			freeze = false,
		} = {},
	) {
		const entries = Array.isArray(value)
			? value
			: value === undefined ||
				value === null ||
				value === ""
				? []
				: [value];

		return entries.map((entry) => {
			let normalized;

			if (typeof entry === "string") {
				normalized = {
					name: entry,
					uuid: "",
					completed: false,
				};
			} else if (
				entry &&
				typeof entry === "object"
			) {
				normalized = {
					name: String(
						entry.name ??
							entry.label ??
							"",
					),

					uuid: String(
						entry.uuid ??
							entry.id ??
							"",
					),

					completed: Boolean(
						entry.completed,
					),
				};
			} else {
				normalized = {
					name: "",
					uuid: "",
					completed: false,
				};
			}

			return freeze
				? Object.freeze(normalized)
				: normalized;
		});
	}

	/**
	 * Normalize native or temporary legacy career-exit data.
	 * Blank array rows are deliberately preserved for editing.
	 *
	 * @param {*} value
	 * @returns {string[]}
	 * @protected
	 */
	static #normalizeCareerExits(value) {
		const entries = Array.isArray(value)
			? value
			: value === undefined ||
				value === null ||
				value === ""
				? []
				: [value];

		return entries.map((entry) => {
			if (
				entry &&
				typeof entry === "object"
			) {
				return String(
					entry.name ??
						entry.label ??
						entry.value ??
						"",
				);
			}

			return String(entry ?? "");
		});
	}

	/**
	 * Parse and validate one rendered list index.
	 *
	 * @param {*} value
	 * @param {number} length
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	static #arrayIndex(value, length, label) {
		const index = Number(value);

		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= length
		) {
			throw new Error(
				`${label} index is invalid: ${String(value)}.`,
			);
		}

		return index;
	}
}