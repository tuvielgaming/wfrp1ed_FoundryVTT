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
 * roll and modifier contributions. A later GM edit changes only the general
 * adjudication modifier and re-evaluates target/success/margin against that
 * original snapshot; Actor data and formula inputs are never re-read.
 */
export class TestResultChat {
	/**
	 * Publish one TestResult with an editable-GM chat snapshot.
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
	 * Attach GM-only editing behavior to one rendered result card.
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
		const input = card?.querySelector?.(
			"[data-wfrp-test-general-modifier]",
		);

		if (!input) {
			return;
		}

		if (!game.user?.isGM) {
			input.readOnly = true;
			input.tabIndex = -1;
			input.classList.add("is-readonly");
			input.title = this._localize(
				"WFRP1ED.TestResult.GMModifierReadOnly",
				"The GM can adjust this modifier.",
				"Ten modyfikator może zmienić MG.",
			);
			return;
		}

		input.readOnly = false;
		input.classList.add("is-editable");
		input.title = this._localize(
			"WFRP1ED.TestResult.GMModifierEdit",
			"GM: edit the modifier, then press Enter or leave the field.",
			"MG: zmień modyfikator, a następnie naciśnij Enter lub opuść pole.",
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

	/**
	 * Persist a GM edit and replace the card content with the re-evaluated view.
	 *
	 * @param {ChatMessage} message
	 * @param {HTMLInputElement} input
	 * @returns {Promise<void>}
	 * @protected
	 */
	static async _updateGeneralModifier(message, input) {
		try {
			if (!game.user?.isGM) {
				throw new Error(
					"Only a GM can change a resolved test modifier.",
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

		return {
			version: 1,
			testName: String(result.test.name ?? result.test.id ?? "Test"),
			roll: this._finiteNumber(result.roll, "roll"),
			baseTarget: this._finiteNumber(
				breakdown?.baseTarget,
				"baseTarget",
			),
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
			source: String(modifier?.source ?? ""),
			type: String(modifier?.type ?? "untyped"),
			value,
			signed: this._signed(value),
			enabled: modifier?.enabled !== false,
		};
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
