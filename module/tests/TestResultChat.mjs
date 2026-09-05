import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import {
	TEST_RESULT_VISIBILITY,
	normalizeTestResultVisibility,
} from "./TestResultVisibility.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/test-result.hbs";
const GENERAL_MODIFIER_ID = "general";

/**
 * Publish and maintain interactive generic TestResult chat cards.
 *
 * Mechanical test resolution happens before this controller receives a result.
 * The persisted chat snapshot stores the resolved base target, original d100
 * roll and modifier contributions. A later adjudication edit changes only the
 * stored modifier state and re-evaluates target/success/margin against that
 * original snapshot; Actor data and formula inputs are never re-read.
 *
 * Mechanical adjudication belongs to the GM or an OWNER of the Actor whose roll
 * this is. Result-detail visibility remains a separate GM-only presentation
 * decision.
 */
export class TestResultChat {
	/**
	 * Publish one TestResult with an editable persistent chat snapshot.
	 *
	 * @param {TestResult} result
	 * @returns {Promise<ChatMessage>}
	 */
	static async publish(result) {
		if (!result?.actor || !result?.test) {
			throw new Error(
				"TestResultChat requires a complete TestResult.",
			);
		}

		const state = this._snapshot(result);
		const content = await this._render(state);
		const messageData = {
			speaker: ChatMessage.getSpeaker({
				actor: result.actor,
			}),
			content,
			flags: {
				[FLAG_SCOPE]: {
					[FLAG_KEY]: state,
				},
			},
		};

		if (result.rollObject) {
			messageData.rolls = [result.rollObject];
		}

		return ChatMessage.create(messageData);
	}

	/**
	 * Attach GM-or-Actor-OWNER adjudication behavior to one result card.
	 *
	 * The general numeric modifier remains editable exactly as before. Skill
	 * modifiers additionally expose their persisted enabled state as checkboxes;
	 * changing one re-renders the result against the original physical d100 roll.
	 *
	 * @param {ChatMessage} message
	 * @param {HTMLElement|Object} html
	 * @returns {void}
	 */
	static activateListeners(message, html) {
		const state = message?.getFlag?.(
			FLAG_SCOPE,
			FLAG_KEY,
		);

		if (!state) {
			return;
		}

		const rendered = this._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");

		if (!card) {
			return;
		}

		const canAdjudicate = this._canAdjudicate(state);
		const input = card.querySelector(
			"[data-wfrp-test-general-modifier]",
		);

		if (input) {
			if (!canAdjudicate) {
				input.readOnly = true;
				input.tabIndex = -1;
				input.classList.add("is-readonly");
				input.title = this._localize(
					"WFRP1ED.TestResult.GMModifierReadOnly",
					"The GM or an OWNER of this Actor can adjust this modifier.",
					"Ten modyfikator może zmienić MG albo Właściciel tego Aktora.",
				);
			} else {
				input.readOnly = false;
				input.classList.add("is-editable");
				input.title = this._localize(
					"WFRP1ED.TestResult.GMModifierEdit",
					"Edit the modifier, then press Enter or leave the field.",
					"Zmień modyfikator, a następnie naciśnij Enter lub opuść pole.",
				);

				input.addEventListener("keydown", (event) => {
					if (event.key !== "Enter") {
						return;
					}

					event.preventDefault();
					input.blur();
				});

				input.addEventListener("change", () => {
					void this._updateGeneralModifier(
						message,
						input,
					);
				});
			}
		}

		const skillToggles = card.querySelectorAll(
			'input[data-wfrp-test-modifier-toggle][data-modifier-type="skill"]',
		);

		for (const toggle of skillToggles) {
			if (!canAdjudicate) {
				toggle.disabled = true;
				continue;
			}

			toggle.disabled = false;
			toggle.title = this._localize(
				"WFRP1ED.TestResult.SkillModifierToggle",
				"Enable or disable this Skill modifier for this resolved test.",
				"Włącz lub wyłącz ten modyfikator umiejętności dla tego rozstrzygniętego testu.",
			);

			toggle.addEventListener("change", () => {
				const index = Number(toggle.dataset.modifierIndex);
				void this._updateModifierEnabled(
					message,
					index,
					toggle.checked,
					"skill",
				);
			});
		}
	}

	/**
	 * Apply the persisted result-detail visibility for the current client.
	 *
	 * GMs always retain the complete diagnostic card. A public result remains
	 * fully expandable for players. A GM-only result keeps only the compact
	 * resolved summary for players and removes the detailed calculation from
	 * their rendered DOM so base values cannot be used to infer NPC statistics.
	 *
	 * @param {ChatMessage} message
	 * @param {HTMLElement|Object} html
	 * @returns {void}
	 */
	static applyClientVisibility(message, html) {
		if (game.user?.isGM) {
			return;
		}

		const state = message?.getFlag?.(
			FLAG_SCOPE,
			FLAG_KEY,
		);

		if (!state) {
			return;
		}

		if (
			normalizeTestResultVisibility(state.resultVisibility) ===
			TEST_RESULT_VISIBILITY.PUBLIC
		) {
			return;
		}

		const rendered = this._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		const details = card?.querySelector?.(
			".wfrp1e-test-card__target",
		);

		if (!(details instanceof HTMLDetailsElement)) {
			return;
		}

		details.open = false;
		details.classList.add("is-player-locked");

		details.querySelector(
			".wfrp1e-test-card__breakdown",
		)?.remove();
		details.querySelector(
			".wfrp1e-test-card__target-toggle",
		)?.remove();

		const summary = details.querySelector(":scope > summary");

		if (summary) {
			summary.removeAttribute("title");
			summary.tabIndex = -1;
			summary.setAttribute("aria-expanded", "false");
			summary.addEventListener("click", (event) => {
				event.preventDefault();
			});
			summary.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
				}
			});
		}

		details.addEventListener("toggle", () => {
			if (details.open) {
				details.open = false;
			}
		});
	}

	/**
	 * Add GM-only right-click ChatLog actions for changing result details.
	 *
	 * Foundry's ChatLog context hook passes the prepared menu entries by
	 * reference. The two entries are mutually exclusive, so the GM sees only
	 * the action which changes the current result state.
	 *
	 * @param {Array<Object>} menuItems
	 * @returns {void}
	 */
	static addContextMenuOptions(menuItems) {
		if (!game.user?.isGM || !Array.isArray(menuItems)) {
			return;
		}

		menuItems.push(
			{
				name: this._localize(
					"WFRP1ED.TestResult.Visibility.MakePublic",
					"Test details: make public",
					"Szczegóły testu: udostępnij graczom",
				),
				icon: '<i class="fa-solid fa-eye"></i>',
				condition: (target) => {
					const message = this._messageFromContextTarget(target);
					const state = message?.getFlag?.(
						FLAG_SCOPE,
						FLAG_KEY,
					);

					return Boolean(state) &&
						normalizeTestResultVisibility(
							state.resultVisibility,
						) !== TEST_RESULT_VISIBILITY.PUBLIC;
				},
				callback: (target) => {
					const message = this._messageFromContextTarget(target);

					if (message) {
						void this.setResultVisibility(
							message,
							TEST_RESULT_VISIBILITY.PUBLIC,
						);
					}
				},
			},
			{
				name: this._localize(
					"WFRP1ED.TestResult.Visibility.MakeGMOnly",
					"Test details: GM only",
					"Szczegóły testu: tylko MG",
				),
				icon: '<i class="fa-solid fa-eye-slash"></i>',
				condition: (target) => {
					const message = this._messageFromContextTarget(target);
					const state = message?.getFlag?.(
						FLAG_SCOPE,
						FLAG_KEY,
					);

					return Boolean(state) &&
						normalizeTestResultVisibility(
							state.resultVisibility,
						) === TEST_RESULT_VISIBILITY.PUBLIC;
				},
				callback: (target) => {
					const message = this._messageFromContextTarget(target);

					if (message) {
						void this.setResultVisibility(
							message,
							TEST_RESULT_VISIBILITY.GM_ONLY,
						);
					}
				},
			},
		);
	}

	/**
	 * Persist one GM result-detail visibility change.
	 *
	 * This updates only presentation metadata and regenerated card content. The
	 * original roll, base target, modifiers and adjudicated result stay intact.
	 *
	 * @param {ChatMessage} message
	 * @param {string} visibility
	 * @returns {Promise<void>}
	 */
	static async setResultVisibility(message, visibility) {
		try {
			if (!game.user?.isGM) {
				throw new Error(
					"Only a GM can change test-result detail visibility.",
				);
			}

			const state = message?.getFlag?.(
				FLAG_SCOPE,
				FLAG_KEY,
			);

			if (!state) {
				throw new Error(
					"This chat message has no editable test snapshot.",
				);
			}

			const updated = this._copyState(state);
			updated.resultVisibility =
				normalizeTestResultVisibility(visibility);
			updated.updatedBy = game.user?.id ?? "";
			updated.updatedAt = Date.now();

			const content = await this._render(updated);

			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
			});
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to update test-result visibility.",
				error,
			);

			ui.notifications.error(
				error?.message ??
					"Unable to update test-result visibility.",
			);
		}
	}

	/**
	 * Persist an adjudication modifier edit and replace the card content with the
	 * re-evaluated view.
	 *
	 * @param {ChatMessage} message
	 * @param {HTMLInputElement} input
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async _updateGeneralModifier(message, input) {
		try {
			const state = message?.getFlag?.(
				FLAG_SCOPE,
				FLAG_KEY,
			);

			if (!state) {
				throw new Error(
					"This chat message has no editable test snapshot.",
				);
			}

			if (!this._canAdjudicate(state)) {
				throw new Error(
					"Only the GM or an OWNER of the rolling Actor can change a resolved test modifier.",
				);
			}

			const raw = String(input?.value ?? "").trim();
			const value = Number(raw);

			if (!raw || !Number.isFinite(value)) {
				throw new Error(
					this._localize(
						"WFRP1ED.TestResult.GMModifierInvalid",
						"Enter a finite test modifier.",
						"Wprowadź prawidłowy modyfikator testu.",
					),
				);
			}

			const updated = this._copyState(state);
			updated.generalModifier.value = value;
			updated.updatedBy = game.user?.id ?? "";
			updated.updatedAt = Date.now();

			const content = await this._render(updated);

			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
			});
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to update test-result modifier.",
				error,
			);

			ui.notifications.error(
				error?.message ??
					"Unable to update the test modifier.",
			);
		}
	}

	/**
	 * Enable or disable one persisted non-general modifier and re-evaluate the
	 * card against its immutable base target and physical d100 roll.
	 *
	 * `expectedType` is checked against the stored snapshot rather than trusting
	 * DOM data, so this entry point cannot be used to toggle unrelated modifier
	 * kinds which do not support post-roll adjudication.
	 *
	 * @param {ChatMessage} message
	 * @param {number} index
	 * @param {boolean} enabled
	 * @param {string} expectedType
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async _updateModifierEnabled(
		message,
		index,
		enabled,
		expectedType,
	) {
		try {
			const state = message?.getFlag?.(
				FLAG_SCOPE,
				FLAG_KEY,
			);

			if (!state) {
				throw new Error(
					"This chat message has no editable test snapshot.",
				);
			}

			if (!this._canAdjudicate(state)) {
				throw new Error(
					"Only the GM or an OWNER of the rolling Actor can change a resolved test modifier.",
				);
			}

			const modifierIndex = Number(index);
			const modifiers = Array.isArray(state.otherModifiers)
				? state.otherModifiers
				: [];

			if (
				!Number.isInteger(modifierIndex) ||
				modifierIndex < 0 ||
				modifierIndex >= modifiers.length
			) {
				throw new Error("Select a valid resolved test modifier.");
			}

			const requiredType = String(expectedType ?? "").trim();
			const storedType = String(
				modifiers[modifierIndex]?.type ?? "",
			).trim();

			if (!requiredType || storedType !== requiredType) {
				throw new Error(
					"This resolved test modifier cannot be toggled here.",
				);
			}

			const updated = this._copyState(state);
			updated.otherModifiers[modifierIndex].enabled =
				enabled === true;
			updated.updatedBy = game.user?.id ?? "";
			updated.updatedAt = Date.now();

			const content = await this._render(updated);

			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
			});
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to toggle resolved test modifier.",
				error,
			);

			ui.notifications.error(
				error?.message ??
					"Unable to toggle the resolved test modifier.",
			);
		}
	}

	/**
	 * Build a JSON-safe, mutable snapshot from the resolved result.
	 *
	 * @param {TestResult} result
	 * @returns {Object}
	 * @protected
	 */
	static _snapshot(result) {
		const breakdown = result.targetBreakdown;
		const contextModifiers = Array.isArray(
			result.context?.modifiers,
		)
			? result.context.modifiers
			: [];
		const renderedModifiers = Array.isArray(
			breakdown?.modifiers,
		)
			? breakdown.modifiers
			: [];
		const generalIndex = contextModifiers.findIndex(
			(modifier) => modifier?.id === GENERAL_MODIFIER_ID,
		);
		const generalView = generalIndex >= 0
			? renderedModifiers[generalIndex]
			: null;
		const otherModifiers = renderedModifiers
			.filter((_modifier, index) => index !== generalIndex)
			.map((modifier) => this._copyModifier(modifier));
		const requestedVisibility = normalizeTestResultVisibility(
			result.context?.options?.resultVisibility,
		);

		return {
			version: 3,
			actorUuid: String(result.actor?.uuid ?? ""),
			testId: String(result.test.id ?? ""),
			testName: String(result.test.name ?? result.test.id ?? "Test"),
			roll: this._finiteNumber(result.roll, "roll"),
			baseTarget: this._finiteNumber(
				breakdown?.baseTarget,
				"baseTarget",
			),
			resultVisibility: game.user?.isGM
				? requestedVisibility
				: TEST_RESULT_VISIBILITY.GM_ONLY,
			characteristic: breakdown?.characteristic
				? {
					id: String(breakdown.characteristic.id ?? ""),
					label: String(breakdown.characteristic.label ?? ""),
					value: this._finiteNumber(
						breakdown.characteristic.value,
						"characteristic.value",
					),
				}
				: null,
			formula: breakdown?.formula
				? String(breakdown.formula)
				: null,
			variables: Array.isArray(breakdown?.variables)
				? breakdown.variables.map((entry) => ({
					key: String(entry?.key ?? ""),
					label: String(entry?.label ?? ""),
					value: this._finiteNumber(
						entry?.value,
						"formula variable",
					),
				}))
				: [],
			otherModifiers,
			generalModifier: {
				source: String(
					generalView?.source ??
						this._localize(
							"WFRP1ed.TestModifier.Dialog",
							"Dialog modifier",
							"Modyfikator testu",
						),
				),
				value: this._finiteNumber(
					generalView?.value ?? 0,
					"general modifier",
				),
				enabled: generalView?.enabled !== false,
			},
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};
	}

	/**
	 * Render one stored snapshot into the shared test-result template.
	 *
	 * @param {Object} state
	 * @returns {Promise<string>}
	 * @protected
	 */
	static async _render(state) {
		return foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			this._templateContext(state),
		);
	}

	/**
	 * Re-evaluate presentation values from the immutable roll/base snapshot.
	 *
	 * @param {Object} state
	 * @returns {Object}
	 * @protected
	 */
	static _templateContext(state) {
		const baseTarget = this._finiteNumber(
			state?.baseTarget,
			"baseTarget",
		);
		const roll = this._finiteNumber(state?.roll, "roll");
		const modifiers = Array.isArray(state?.otherModifiers)
			? state.otherModifiers.map((modifier) =>
				this._copyModifier(modifier),
			)
			: [];
		const generalModifier = this._copyModifier({
			source: state?.generalModifier?.source ??
				this._localize(
					"WFRP1ed.TestModifier.Dialog",
					"Dialog modifier",
					"Modyfikator testu",
				),
			value: state?.generalModifier?.value ?? 0,
			enabled: state?.generalModifier?.enabled !== false,
		});
		const otherModifierTotal = modifiers
			.filter((modifier) => modifier.enabled)
			.reduce(
				(total, modifier) => total + modifier.value,
				0,
			);
		const totalModifier =
			otherModifierTotal +
			(generalModifier.enabled ? generalModifier.value : 0);
		const target = this._finiteNumber(
			baseTarget + totalModifier,
			"finalTarget",
		);
		const margin = target - roll;
		const success = roll <= target;

		return {
			result: {
				test: {
					name: String(state?.testName ?? "Test"),
				},
				target,
				roll,
				margin,
				success,
				failure: !success,
			},
			breakdown: {
				baseTarget,
				characteristic: state?.characteristic ?? null,
				formula: state?.formula ?? null,
				variables: Array.isArray(state?.variables)
					? state.variables
					: [],
				modifiers,
				generalModifier,
				totalModifier,
				totalModifierSigned: this._signed(totalModifier),
				finalTarget: target,
				expandHint: this._localize(
					"WFRP1ED.TestResult.TargetBreakdownHint",
					"Click to show target calculation",
					"Kliknij, aby pokazać obliczenie progu",
				),
				baseTargetLabel: this._localize(
					"WFRP1ED.TestResult.BaseTarget",
					"Base target",
					"Próg bazowy",
				),
				formulaLabel: this._localize(
					"WFRP1ED.TestResult.Formula",
					"Formula",
					"Wzór",
				),
				inputsLabel: this._localize(
					"WFRP1ED.TestResult.Inputs",
					"Inputs",
					"Dane wejściowe",
				),
				modifiersLabel: this._localize(
					"WFRP1ED.TestResult.Modifiers",
					"Modifiers",
					"Modyfikatory",
				),
				totalModifierLabel: this._localize(
					"WFRP1ED.TestResult.TotalModifier",
					"Total modifier",
					"Łączny modyfikator",
				),
				finalTargetLabel: this._localize(
					"WFRP1ED.TestResult.FinalTarget",
					"Final target",
					"Próg końcowy",
				),
				disabledLabel: this._localize(
					"WFRP1ED.TestResult.DisabledModifier",
					"disabled",
					"wyłączony",
				),
			},
		};
	}

	/**
	 * Resolve a ChatMessage from Foundry's ChatLog context-menu target.
	 *
	 * Foundry v14 uses native HTMLElements, while compatibility layers may
	 * still pass a jQuery-like wrapper. Both forms are accepted here.
	 *
	 * @param {*} target
	 * @returns {ChatMessage|null}
	 * @protected
	 */
	static _messageFromContextTarget(target) {
		const element = target instanceof HTMLElement
			? target
			: target?.[0] instanceof HTMLElement
				? target[0]
				: null;
		const entry = element?.closest?.("[data-message-id]") ?? element;
		const messageId = String(
			entry?.dataset?.messageId ??
				target?.attr?.("data-message-id") ??
				target?.data?.("message-id") ??
				"",
		).trim();

		return messageId
			? game.messages?.get(messageId) ?? null
			: null;
	}

	/**
	 * Deep-enough mutable copy of one stored chat state.
	 *
	 * @param {Object} state
	 * @returns {Object}
	 * @protected
	 */
	static _copyState(state) {
		return {
			...state,
			characteristic: state?.characteristic
				? { ...state.characteristic }
				: null,
			variables: Array.isArray(state?.variables)
				? state.variables.map((entry) => ({ ...entry }))
				: [],
			otherModifiers: Array.isArray(state?.otherModifiers)
				? state.otherModifiers.map((modifier) => ({ ...modifier }))
				: [],
			generalModifier: {
				...(state?.generalModifier ?? {}),
			},
		};
	}

	/**
	 * Normalize one modifier presentation record.
	 *
	 * @param {Object} modifier
	 * @returns {Object}
	 * @protected
	 */
	static _copyModifier(modifier = {}) {
		const value = this._finiteNumber(
			modifier?.value ?? 0,
			"modifier.value",
		);

		return {
			id: String(modifier?.id ?? ""),
			source: String(modifier?.source ?? ""),
			type: String(modifier?.type ?? "untyped"),
			value,
			signed: this._signed(value),
			enabled: modifier?.enabled !== false,
		};
	}

	/** Resolve whether the current user may adjudicate this Actor-owned roll. */
	static _canAdjudicate(state) {
		if (game.user?.isGM) return true;
		const actor = ActorRollPolicy.actorFromUuidSync(state?.actorUuid);
		return ActorRollPolicy.canAdjudicate(actor, game.user);
	}

	/**
	 * Normalize Foundry's render hook HTML argument.
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

	static _signed(value) {
		return value >= 0 ? `+${value}` : String(value);
	}

	static _finiteNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`TestResultChat '${label}' must be finite: ${String(value)}`,
			);
		}

		return number;
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
