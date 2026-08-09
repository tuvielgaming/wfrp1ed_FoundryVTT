import { TestManager } from "./TestManager.mjs";
import { normalizeTestResultVisibility } from "./TestResultVisibility.mjs";

const { DialogV2 } = foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "pendingStandardTest";
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/pending-standard-test.hbs";

const SERIALIZED_OPTION_KEYS = Object.freeze([
	"movement",
	"noise",
	"lockDifficulty",
	"modifier",
]);

/**
 * Defer a Standard Test which needs opponent data until a GM can resolve it.
 *
 * This class does not own WFRP mechanics. It stores only the already-selected
 * Test id and safe runtime inputs, then resumes Actor.rollTest once the missing
 * target context has been supplied. The existing TestContext/TestResolver
 * pipeline remains the sole calculation and roll owner.
 */
export class PendingStandardTest {
	/**
	 * Determine whether a configured Standard Test still needs target data.
	 *
	 * @param {string} testId
	 * @param {Object} options
	 * @returns {boolean}
	 */
	static needsResolution(testId, options = {}) {
		const test = TestManager.get(testId);

		if (!test?.tags.includes("requires-target")) {
			return false;
		}

		if (options.target ?? options.targetActor) {
			return false;
		}

		const requirements = this.targetRequirements(test);
		const targetValues = options.targetValues ?? {};

		return !requirements.every((id) =>
			Number.isFinite(Number(targetValues?.[id])),
		);
	}

	/**
	 * Return target-characteristic identifiers referenced by a Test formula.
	 *
	 * Current audited target-dependent Standard Tests reference `target.i` or
	 * `target.wp`. Parsing the registered formula keeps the pending UI derived
	 * from the actual test contract instead of maintaining a second rule table.
	 *
	 * @param {Test|string} testOrId
	 * @returns {readonly string[]}
	 */
	static targetRequirements(testOrId) {
		const test =
			typeof testOrId === "string"
				? TestManager.get(testOrId)
				: testOrId;

		if (!test) {
			throw new Error(
				"Pending Standard Test requires a registered Test.",
			);
		}

		const formula = String(test.formula ?? "");
		const matches = formula.matchAll(
			/\btarget\.([A-Za-z][A-Za-z0-9]*)\b/g,
		);
		const requirements = new Set();

		for (const match of matches) {
			requirements.add(
				String(match[1]).trim().toLowerCase(),
			);
		}

		return Object.freeze([...requirements]);
	}

	/**
	 * Publish one unresolved Standard Test request to chat.
	 *
	 * Foundry Document schemas clean and reconstruct data by assigning cleaned
	 * values back into the supplied object graph. Therefore data passed through
	 * ChatMessage flags must remain mutable even though internal rule contracts
	 * may be immutable.
	 *
	 * @param {Actor} actor
	 * @param {string} testId
	 * @param {Object} options
	 * @returns {Promise<ChatMessage>}
	 */
	static async create(actor, testId, options = {}) {
		if (!actor?.uuid) {
			throw new Error(
				"Pending Standard Test requires an Actor with a UUID.",
			);
		}

		const test = TestManager.get(testId);

		if (!test?.tags.includes("requires-target")) {
			throw new Error(
				`Test '${String(testId)}' does not require deferred target data.`,
			);
		}

		if (!this.needsResolution(testId, options)) {
			throw new Error(
				`Test '${String(testId)}' already has enough target data.`,
			);
		}

		/*
		 * IMPORTANT: do not Object.freeze this payload or anything nested inside
		 * it. ChatMessage's DataModel cleaning contract is allowed to mutate the
		 * supplied flags object while reconstructing ObjectField values.
		 */
		const request = {
			version: 2,
			status: "pending",
			actorUuid: actor.uuid,
			testId: test.id,
			options: this._serializeOptions(options),
			targetRequirements: [
				...this.targetRequirements(test),
			],
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};

		const content =
			await foundry.applications.handlebars.renderTemplate(
				TEMPLATE_PATH,
				this._templateContext(actor, test, request),
			);

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content,
			flags: {
				[FLAG_SCOPE]: {
					[FLAG_KEY]: request,
				},
			},
		});
	}

	/**
	 * Activate GM-only controls on a rendered pending chat card.
	 *
	 * @param {ChatMessage} message
	 * @param {HTMLElement|Object} html
	 * @returns {void}
	 */
	static activateListeners(message, html) {
		const request = message?.getFlag?.(
			FLAG_SCOPE,
			FLAG_KEY,
		);

		if (!request || request.status !== "pending") {
			return;
		}

		const rendered = this._asElement(html);
		const card = rendered?.matches?.(
			"[data-wfrp-pending-standard-test]",
		)
			? rendered
			: rendered?.querySelector?.(
				"[data-wfrp-pending-standard-test]",
			);

		if (!card) {
			return;
		}

		const gmControls = card.querySelector(
			"[data-pending-gm-controls]",
		);
		const waitingStatus = card.querySelector(
			"[data-pending-player-status]",
		);

		if (!game.user?.isGM) {
			if (gmControls) {
				gmControls.hidden = true;
			}

			if (waitingStatus) {
				waitingStatus.hidden = false;
			}

			return;
		}

		if (gmControls) {
			gmControls.hidden = false;
		}

		if (waitingStatus) {
			waitingStatus.hidden = true;
		}

		for (
			const button of card.querySelectorAll(
				"[data-pending-action]",
			)
		) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				void this._handleAction(
					message,
					request,
					card,
					button.dataset.pendingAction,
				);
			});
		}

		const dropZone = card.querySelector(
			"[data-pending-target-drop]",
		);

		if (dropZone) {
			dropZone.addEventListener("dragover", (event) => {
				event.preventDefault();
				dropZone.classList.add("is-dragover");
			});

			dropZone.addEventListener("dragleave", () => {
				dropZone.classList.remove("is-dragover");
			});

			dropZone.addEventListener("drop", (event) => {
				event.preventDefault();
				dropZone.classList.remove("is-dragover");
				void this._handleDrop(
					message,
					request,
					event,
				);
			});
		}
	}

	/**
	 * Resolve one button action from a pending card.
	 *
	 * @param {ChatMessage} message
	 * @param {Object} request
	 * @param {HTMLElement} card
	 * @param {string} action
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async _handleAction(message, request, card, action) {
		try {
			switch (action) {
				case "current-target": {
					const target = this._singleTargetActor();

					if (!target) {
						ui.notifications.warn(
							this._localize(
								"WFRP1ED.StandardTest.TargetOneToken",
								"Target exactly one token on the canvas first.",
								"Najpierw wskaż dokładnie jeden token na mapie.",
							),
						);
						return;
					}

					await this._execute(
						message,
						request,
						{ target },
					);
					return;
				}

				case "choose-actor": {
					const target = await this._chooseActor();

					if (!target) {
						return;
					}

					await this._execute(
						message,
						request,
						{ target },
					);
					return;
				}

				case "manual": {
					await this._executeManualValue(
						message,
						request,
						card,
					);
					return;
				}

				default:
					throw new Error(
						`Unknown pending Standard Test action '${String(action)}'.`,
					);
			}
		} catch (error) {
			this._reportError(error);
		}
	}

	/**
	 * Resolve a dropped Actor or Token and resume the Test.
	 *
	 * @param {ChatMessage} message
	 * @param {Object} request
	 * @param {DragEvent} event
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async _handleDrop(message, request, event) {
		try {
			const textEditor =
				foundry.applications?.ux?.TextEditor ??
				globalThis.TextEditor;

			if (
				typeof textEditor?.getDragEventData !== "function"
			) {
				throw new Error(
					"Foundry TextEditor drag-data API is unavailable.",
				);
			}

			const data = textEditor.getDragEventData(event);
			const target = await this._actorFromDropData(data);

			if (!target) {
				throw new Error(
					this._localize(
						"WFRP1ED.StandardTest.DropActorOnly",
						"Drop an Actor or a Token with an Actor here.",
						"Upuść tutaj Aktora albo token powiązany z Aktorem.",
					),
				);
			}

			await this._execute(
				message,
				request,
				{ target },
			);
		} catch (error) {
			this._reportError(error);
		}
	}

	/**
	 * Read one manual target-characteristic value from the card.
	 *
	 * @param {ChatMessage} message
	 * @param {Object} request
	 * @param {HTMLElement} card
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async _executeManualValue(message, request, card) {
		const requirements = Array.isArray(
			request.targetRequirements,
		)
			? request.targetRequirements
			: [];

		if (requirements.length !== 1) {
			throw new Error(
				"Manual target entry requires exactly one target characteristic.",
			);
		}

		const input = card.querySelector(
			"[data-pending-manual-value]",
		);
		const raw = String(input?.value ?? "").trim();
		const value = Number(raw);

		if (!raw || !Number.isFinite(value)) {
			throw new Error(
				this._localize(
					"WFRP1ED.StandardTest.ManualTargetInvalid",
					"Enter a finite target characteristic value.",
					"Wprowadź prawidłową wartość cechy celu.",
				),
			);
		}

		await this._execute(
			message,
			request,
			{
				targetValues: {
					[requirements[0]]: value,
				},
			},
		);
	}

	/**
	 * Resume the normal Actor.rollTest pipeline with resolved target context.
	 *
	 * A cancelled generic TestDialog returns null; in that case the pending card
	 * intentionally remains so the GM can resume it again later.
	 *
	 * @param {ChatMessage} message
	 * @param {Object} request
	 * @param {Object} resolution
	 * @returns {Promise<*>}
	 * @protected
	 */
	static async _execute(message, request, resolution) {
		const actor = await this._fromUuid(request.actorUuid);

		if (typeof actor?.rollTest !== "function") {
			throw new Error(
				"The Actor which created this pending Test is no longer available.",
			);
		}

		const options = {
			...(request.options ?? {}),
		};

		if (resolution.target) {
			options.target = resolution.target;
		}

		if (resolution.targetValues) {
			options.targetValues = {
				...(options.targetValues ?? {}),
				...resolution.targetValues,
			};
		}

		const result = await actor.rollTest(
			request.testId,
			options,
		);

		if (!result) {
			return null;
		}

		await message.delete();

		return result;
	}

	/**
	 * Open a GM Actor selector using all world Actors with characteristics.
	 * Tokens are not required, so off-scene NPCs remain available.
	 *
	 * @returns {Promise<Actor|null>}
	 * @protected
	 */
	static async _chooseActor() {
		const actors = [...(game.actors?.contents ?? [])]
			.filter((actor) => actor?.system?.characteristics)
			.sort((first, second) =>
				String(first.name ?? "").localeCompare(
					String(second.name ?? ""),
					game.i18n.lang,
					{ sensitivity: "base" },
				),
			);

		if (actors.length === 0) {
			ui.notifications.warn(
				this._localize(
					"WFRP1ED.StandardTest.NoTargetActors",
					"No world Actors with characteristics are available.",
					"Brak dostępnych Aktorów z charakterystyką.",
				),
			);
			return null;
		}

		const content = document.createElement("div");
		const group = document.createElement("div");
		group.classList.add("form-group");
		const label = document.createElement("label");
		label.textContent = this._localize(
			"WFRP1ED.StandardTest.TargetActor",
			"Target Actor",
			"Aktor celu",
		);
		const select = document.createElement("select");
		select.name = "actorId";
		select.autofocus = true;

		for (const actor of actors) {
			const option = document.createElement("option");
			option.value = actor.id;
			option.textContent = actor.name;
			select.append(option);
		}

		group.append(label, select);
		content.append(group);

		const response = await DialogV2.wait({
			classes: [
				"wfrp1ed",
				"wfrp1ed-parchment-window",
				"wfrp1ed-pending-target-dialog",
			],
			window: {
				title: this._localize(
					"WFRP1ED.StandardTest.ChooseTarget",
					"Choose target",
					"Wybierz cel",
				),
			},
			content,
			buttons: [
				{
					action: "choose",
					label: this._localize(
						"WFRP1ED.StandardTest.Choose",
						"Choose",
						"Wybierz",
					),
					default: true,
					callback: (_event, button) => ({
						actorId: String(
							button.form?.elements?.actorId?.value ??
								"",
						).trim(),
					}),
				},
				{
					action: "cancel",
					label: this._localize(
						"WFRP1ed.TestDialog.Cancel",
						"Cancel",
						"Anuluj",
					),
					callback: () => null,
				},
			],
			rejectClose: false,
		});

		if (!response?.actorId) {
			return null;
		}

		return game.actors.get(response.actorId) ?? null;
	}

	/**
	 * Resolve an Actor from standard Foundry drag data.
	 *
	 * @param {Object} data
	 * @returns {Promise<Actor|null>}
	 * @protected
	 */
	static async _actorFromDropData(data) {
		if (!data || typeof data !== "object") {
			return null;
		}

		if (data.uuid) {
			const document = await this._fromUuid(data.uuid);
			const actor = this._actorFromDocument(document);

			if (actor) {
				return actor;
			}
		}

		if (data.type === "Actor" && data.id) {
			return game.actors?.get(data.id) ?? null;
		}

		if (data.actorId) {
			return game.actors?.get(data.actorId) ?? null;
		}

		return null;
	}

	/**
	 * Extract an Actor from an Actor or Token-like Document.
	 *
	 * @param {*} document
	 * @returns {Actor|null}
	 * @protected
	 */
	static _actorFromDocument(document) {
		if (!document) {
			return null;
		}

		if (document.documentName === "Actor") {
			return document;
		}

		if (document.actor?.documentName === "Actor") {
			return document.actor;
		}

		return null;
	}

	/**
	 * Resolve one UUID through Foundry's canonical helper.
	 *
	 * @param {string} uuid
	 * @returns {Promise<*>}
	 * @protected
	 */
	static async _fromUuid(uuid) {
		if (typeof globalThis.fromUuid !== "function") {
			throw new Error(
				"Foundry fromUuid API is unavailable.",
			);
		}

		return globalThis.fromUuid(uuid);
	}

	/**
	 * Resolve exactly one currently targeted Token Actor for the active user.
	 *
	 * @returns {Actor|null}
	 * @protected
	 */
	static _singleTargetActor() {
		const targets = [...(game.user?.targets ?? [])];

		if (targets.length !== 1) {
			return null;
		}

		return targets[0].actor ?? null;
	}

	/**
	 * Store only JSON-safe Standard Test launcher inputs in ChatMessage flags.
	 * Actor Documents are deliberately excluded; deferred target resolution
	 * stores Actor UUIDs only when the GM chooses one.
	 *
	 * The returned object must stay mutable because it is inserted into Foundry
	 * Document source data and will be cleaned by the DataModel schema.
	 *
	 * @param {Object} options
	 * @returns {Object}
	 * @protected
	 */
	static _serializeOptions(options) {
		const serialized = {};

		for (const key of SERIALIZED_OPTION_KEYS) {
			const raw = options?.[key];

			if (
				raw === undefined ||
				raw === null ||
				raw === ""
			) {
				continue;
			}

			const value = Number(raw);

			if (!Number.isFinite(value)) {
				throw new Error(
					`Pending Standard Test option '${key}' must be finite.`,
				);
			}

			serialized[key] = value;
		}

		serialized.resultVisibility = normalizeTestResultVisibility(
			options?.resultVisibility,
		);

		/*
		 * Preserve the exact per-roll Active Effect selection made in the
		 * Standard Test dialog. RuleEffectResolver snapshots are immutable internal
		 * contracts, so clone the array, entries and nested source objects before
		 * placing them in ChatMessage flags. This keeps Foundry's mutable DataModel
		 * cleaning contract safe while retaining checked/unchecked state.
		 */
		if (Array.isArray(options?.ruleEffects)) {
			serialized.ruleEffects = options.ruleEffects.map((entry) => ({
				...entry,
				source: {
					...(entry?.source ?? {}),
				},
			}));
		}

		if (
			options?.targetValues &&
			typeof options.targetValues === "object" &&
			!Array.isArray(options.targetValues)
		) {
			serialized.targetValues = {};

			for (
				const [rawKey, rawValue]
				of Object.entries(options.targetValues)
			) {
				const key = String(rawKey ?? "")
					.trim()
					.toLowerCase();
				const value = Number(rawValue);

				if (!key || !Number.isFinite(value)) {
					continue;
				}

				serialized.targetValues[key] = value;
			}
		}

		return serialized;
	}

	/**
	 * Build language-aware presentation data for the shared chat card.
	 *
	 * @param {Actor} actor
	 * @param {Test} test
	 * @param {Object} request
	 * @returns {Object}
	 * @protected
	 */
	static _templateContext(actor, test, request) {
		const requirements = request.targetRequirements ?? [];
		const manualAllowed = requirements.length === 1;
		const requirementLabel = manualAllowed
			? this._characteristicLabel(requirements[0])
			: "";

		return {
			actorName: actor.name,
			testName: test.name,
			targetLabel: this._localize(
				"WFRP1ED.StandardTest.Target",
				"Target",
				"Cel",
			),
			pendingLabel: this._localize(
				"WFRP1ED.StandardTest.PendingTarget",
				"Waiting for target data",
				"Oczekuje na dane celu",
			),
			dropPrompt: this._localize(
				"WFRP1ED.StandardTest.DropTarget",
				"Drop an Actor or Token here",
				"Upuść tutaj Aktora lub token",
			),
			useCurrentTargetLabel: this._localize(
				"WFRP1ED.StandardTest.UseCurrentTarget",
				"Use current target",
				"Użyj aktualnego celu",
			),
			chooseActorLabel: this._localize(
				"WFRP1ED.StandardTest.ChooseActor",
				"Choose Actor",
				"Wybierz Aktora",
			),
			manualAllowed,
			manualLabel: this._localize(
				"WFRP1ED.StandardTest.ManualValue",
				"Manual value",
				"Wartość ręczna",
			),
			requirementLabel,
			useValueLabel: this._localize(
				"WFRP1ED.StandardTest.UseValue",
				"Use value",
				"Użyj wartości",
			),
			waitingGmLabel: this._localize(
				"WFRP1ED.StandardTest.WaitingForGM",
				"Waiting for the GM to provide target data.",
				"Oczekiwanie na MG, który uzupełni dane celu.",
			),
		};
	}

	/**
	 * Localized full characteristic label with id fallback.
	 *
	 * @param {string} id
	 * @returns {string}
	 * @protected
	 */
	static _characteristicLabel(id) {
		const key = `WFRP1ed.CHAR.${String(id)}`;
		const localized = game.i18n.localize(key);

		return localized !== key
			? localized
			: String(id).toUpperCase();
	}

	/**
	 * Normalize the HTML argument supplied by Foundry's render hook.
	 *
	 * @param {*} html
	 * @returns {HTMLElement|null}
	 * @protected
	 */
	static _asElement(html) {
		if (html instanceof HTMLElement) {
			return html;
		}

		if (html?.[0] instanceof HTMLElement) {
			return html[0];
		}

		return null;
	}

	/**
	 * Report one interactive pending-card failure without producing an
	 * unhandled rejected promise in Foundry's chat UI.
	 *
	 * @param {Error} error
	 * @returns {void}
	 * @protected
	 */
	static _reportError(error) {
		console.error(
			"WFRP1ED | Unable to resolve pending Standard Test.",
			error,
		);

		ui.notifications.error(
			error?.message ??
				"Unable to resolve the pending Standard Test.",
		);
	}

	static _localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);

		if (localized !== key) {
			return localized;
		}

		return game.i18n.lang === "pl"
			? polishFallback
			: englishFallback;
	}
}
