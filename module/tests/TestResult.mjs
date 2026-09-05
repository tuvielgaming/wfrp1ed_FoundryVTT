import { FormulaResolver } from "./FormulaResolver.mjs";

const CHARACTERISTIC_LABEL_ALIASES = Object.freeze({
	m: "sp",
});

export class TestResult {
	/**
	 * Result of one generic WFRP 1e test.
	 *
	 * Combat-specific information such as hit location and damage does not
	 * belong to a generic test result. It must be added by the combat subsystem
	 * after the attack procedure has been verified and implemented.
	 *
	 * @param {Object} data
	 * @param {Actor} data.actor
	 * @param {Test} data.test
	 * @param {number} data.target
	 * @param {Roll|number} data.roll
	 * @param {TestContext} data.context
	 */
	constructor({
		actor,
		test,
		target,
		roll,
		context,
	} = {}) {
		if (!actor) {
			throw new Error("TestResult requires an Actor.");
		}

		if (!test) {
			throw new Error("TestResult requires a Test definition.");
		}

		this.actor = actor;
		this.test = test;
		this.target = this._finiteNumber(target, "target");
		this.rollObject = roll instanceof Roll ? roll : null;
		this.roll = this._d100Result(
			this.rollObject?.total ?? roll,
		);
		this.context = context ?? null;
	}

	/**
	 * Calculate the signed amount by which a test succeeded or failed.
	 *
	 * Positive:
	 * The roll was below the target by this amount.
	 *
	 * Zero:
	 * The roll exactly matched the target and succeeded.
	 *
	 * Negative:
	 * The roll exceeded the target by this amount.
	 *
	 * @param {number} target
	 * @param {number} roll
	 * @returns {number}
	 */
	static calculateMargin(target, roll) {
		const numericTarget = Number(target);
		const numericRoll = Number(roll);

		if (!Number.isFinite(numericTarget)) {
			throw new Error(
				`Test target must be a finite number: ${String(target)}`,
			);
		}

		if (!Number.isInteger(numericRoll)) {
			throw new Error(
				`Test roll must be an integer: ${String(roll)}`,
			);
		}

		return numericTarget - numericRoll;
	}

	/**
	 * A basic WFRP 1e test succeeds when the D100 roll is less than or equal
	 * to the final target number.
	 *
	 * @returns {boolean}
	 */
	get success() {
		return this.roll <= this.target;
	}

	/**
	 * @returns {boolean}
	 */
	get failure() {
		return !this.success;
	}

	/**
	 * Signed numerical amount by which the test succeeded or failed.
	 *
	 * @returns {number}
	 */
	get margin() {
		return TestResult.calculateMargin(this.target, this.roll);
	}

	/**
	 * Absolute numerical distance between the target and roll.
	 *
	 * @returns {number}
	 */
	get degree() {
		return Math.abs(this.margin);
	}

	/**
	 * Read-only presentation model explaining how the final target was built.
	 *
	 * The final target has already been resolved by TestResolver. The base value
	 * is therefore reconstructed from the invariant used by that resolver:
	 *
	 * base target + enabled context modifiers = final target.
	 *
	 * Formula variables are presentation-only diagnostics taken from the same
	 * FormulaResolver variable table used during resolution. No roll mechanics
	 * are recalculated or changed here.
	 *
	 * @returns {Object}
	 */
	get targetBreakdown() {
		const totalModifier = this._finiteNumber(
			this.context?.totalModifier ?? 0,
			"context.totalModifier",
		);
		const baseTarget = this._finiteNumber(
			this.target - totalModifier,
			"baseTarget",
		);
		const modifiers = Array.isArray(this.context?.modifiers)
			? this.context.modifiers.map((modifier) => {
				const value = this._finiteNumber(
					modifier?.value ?? 0,
					"modifier.value",
				);

				return {
					id: String(modifier?.id ?? ""),
					source: this._modifierSource(modifier?.source),
					type: String(modifier?.type ?? "untyped"),
					value,
					signed: this._signed(value),
					enabled: modifier?.enabled !== false,
				};
			})
			: [];

		const rawFormula = this.test.formula
			? String(this.test.formula)
			: null;
		const variables = rawFormula
			? this._formulaVariables(rawFormula)
			: [];
		const formula = rawFormula
			? this._displayFormula(rawFormula, variables)
			: null;
		const characteristic = this.test.characteristic
			? {
				id: String(this.test.characteristic),
				label: this._characteristicLabel(
					this.test.characteristic,
				),
				value: baseTarget,
			}
			: null;

		return {
			baseTarget,
			characteristic,
			formula,
			variables,
			modifiers,
			totalModifier,
			totalModifierSigned: this._signed(totalModifier),
			finalTarget: this.target,

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
		};
	}

	/**
	 * Render the generic test-result chat card.
	 *
	 * @returns {Promise<string>}
	 */
	async render() {
		return foundry.applications.handlebars.renderTemplate(
			"systems/wfrp1ed/templates/chat/test-result.hbs",
			{
				result: this,
				breakdown: this.targetBreakdown,
			},
		);
	}

	/**
	 * Publish the result to Foundry chat.
	 *
	 * The evaluated Roll is attached to the ChatMessage when available. This
	 * keeps the native roll data accessible to Foundry and lets compatible
	 * dice-visualization modules observe the real roll rather than only a
	 * pre-rendered HTML result card.
	 *
	 * @returns {Promise<ChatMessage>}
	 */
	async toChat() {
		const content = await this.render();
		const messageData = {
			speaker: ChatMessage.getSpeaker({
				actor: this.actor,
			}),
			content,
		};

		if (this.rollObject) {
			messageData.rolls = [this.rollObject];
		}

		return ChatMessage.create(messageData);
	}

	/**
	 * Return only variables actually referenced by a formula, in formula order.
	 *
	 * @param {string} formula
	 * @returns {Array<{key:string,label:string,value:number}>}
	 * @protected
	 */
	_formulaVariables(formula) {
		const variables = FormulaResolver.variables(
			this.actor,
			this.context ?? {},
		);

		return Object.entries(variables)
			.map(([key, value]) => ({
				key,
				value: this._finiteNumber(value, `formula.${key}`),
				index: this._formulaVariableIndex(formula, key),
			}))
			.filter((entry) => entry.index >= 0)
			.sort((first, second) => first.index - second.index)
			.map((entry) => ({
				key: entry.key,
				label: this._variableLabel(entry.key),
				value: entry.value,
			}));
	}

	/**
	 * Find one complete variable reference without matching `wp` inside
	 * `target.wp`.
	 *
	 * @param {string} formula
	 * @param {string} key
	 * @returns {number}
	 * @protected
	 */
	_formulaVariableIndex(formula, key) {
		const escapedKey = String(key).replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		const pattern = new RegExp(
			`(^|[^A-Za-z0-9_.])(${escapedKey})` +
				`(?=$|[^A-Za-z0-9_.])`,
		);
		const match = pattern.exec(formula);

		if (!match) {
			return -1;
		}

		return match.index + String(match[1] ?? "").length;
	}

	/**
	 * Render a formula with localized characteristic abbreviations while
	 * preserving the original mechanics expression on the Test definition.
	 *
	 * Example (Polish): `i + cl - target.i` -> `I + Op - Cel.I`.
	 *
	 * @param {string} formula
	 * @param {Array<{key:string}>} variables
	 * @returns {string}
	 * @protected
	 */
	_displayFormula(formula, variables = []) {
		let display = String(formula ?? "");
		const keys = [...new Set(
			variables.map((entry) => String(entry?.key ?? "").trim()),
		)]
			.filter(Boolean)
			.sort((first, second) => second.length - first.length);

		for (const key of keys) {
			display = this._replaceFormulaVariable(
				display,
				key,
				this._formulaVariableDisplayToken(key),
			);
		}

		return display;
	}

	/**
	 * Replace one complete mechanics variable in a presentation formula.
	 *
	 * @param {string} formula
	 * @param {string} key
	 * @param {string} replacement
	 * @returns {string}
	 * @protected
	 */
	_replaceFormulaVariable(formula, key, replacement) {
		const escapedKey = String(key).replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		const pattern = new RegExp(
			`(^|[^A-Za-z0-9_.])${escapedKey}` +
				`(?=$|[^A-Za-z0-9_.])`,
			"g",
		);

		return String(formula).replace(
			pattern,
			(_match, prefix) => `${prefix}${replacement}`,
		);
	}

	/**
	 * Localized compact token used inside a displayed formula.
	 *
	 * @param {string} key
	 * @returns {string}
	 * @protected
	 */
	_formulaVariableDisplayToken(key) {
		const normalized = String(key ?? "").trim();

		if (normalized.startsWith("target.")) {
			const characteristicId = normalized.slice("target.".length);
			const targetLabel = this._localize(
				"WFRP1ED.StandardTest.Target",
				"Target",
				"Cel",
			);

			return `${targetLabel}.${this._characteristicAbbreviation(characteristicId)}`;
		}

		if (normalized === "noise") {
			return this._localize(
				"WFRP1ED.StandardTest.NoiseChance",
				"Base Listen chance",
				"Bazowa szansa Słuchania",
			);
		}

		if (normalized === "lockDifficulty") {
			return this._localize(
				"WFRP1ED.StandardTest.LockDifficulty",
				"Lock rating",
				"Stopień trudności zamka",
			);
		}

		if (normalized === "movement") {
			return this._characteristicAbbreviation("m");
		}

		return this._characteristicAbbreviation(normalized);
	}

	/**
	 * Human-readable formula variable label.
	 *
	 * @param {string} key
	 * @returns {string}
	 * @protected
	 */
	_variableLabel(key) {
		const normalized = String(key ?? "").trim();

		if (normalized.startsWith("target.")) {
			const characteristicId = normalized.slice("target.".length);
			const targetName = String(this.context?.target?.name ?? "").trim();
			const targetLabel = targetName
				? `${this._localize(
					"WFRP1ED.StandardTest.Target",
					"Target",
					"Cel",
				)} (${targetName})`
				: this._localize(
					"WFRP1ED.StandardTest.Target",
					"Target",
					"Cel",
				);

			return `${targetLabel} — ${this._characteristicLabel(characteristicId)}`;
		}

		if (normalized === "noise") {
			return this._localize(
				"WFRP1ED.StandardTest.NoiseChance",
				"Base Listen chance",
				"Bazowa szansa Słuchania",
			);
		}

		if (normalized === "lockDifficulty") {
			return this._localize(
				"WFRP1ED.StandardTest.LockDifficulty",
				"Lock rating",
				"Stopień trudności zamka",
			);
		}

		if (normalized === "movement") {
			return this._characteristicLabel("m");
		}

		return this._characteristicLabel(normalized);
	}

	/**
	 * Localized full characteristic label with id fallback.
	 *
	 * @param {string} id
	 * @returns {string}
	 * @protected
	 */
	_characteristicLabel(id) {
		const normalized = String(id ?? "").trim().toLowerCase();
		const localizationId =
			CHARACTERISTIC_LABEL_ALIASES[normalized] ?? normalized;
		const key = `WFRP1ed.CHAR.${localizationId}`;
		const localized = game.i18n.localize(key);

		return localized !== key
			? localized
			: normalized.toUpperCase();
	}

	/**
	 * Localized characteristic abbreviation matching the Actor sheet header.
	 *
	 * @param {string} id
	 * @returns {string}
	 * @protected
	 */
	_characteristicAbbreviation(id) {
		const normalized = String(id ?? "").trim().toLowerCase();
		const localizationId =
			CHARACTERISTIC_LABEL_ALIASES[normalized] ?? normalized;
		const key = `WFRP1ed.CHARAbbrev.${localizationId}`;
		const localized = game.i18n.localize(key);

		return localized !== key
			? localized
			: normalized.toUpperCase();
	}

	/**
	 * Resolve a modifier source which may itself be a localization key.
	 *
	 * @param {*} source
	 * @returns {string}
	 * @protected
	 */
	_modifierSource(source) {
		const text = String(source ?? "").trim();

		if (!text) {
			return this._localize(
				"WFRP1ED.TestResult.Modifier",
				"Modifier",
				"Modyfikator",
			);
		}

		const localized = game.i18n.localize(text);
		return localized !== text ? localized : text;
	}

	/**
	 * @param {number} value
	 * @returns {string}
	 * @protected
	 */
	_signed(value) {
		return value >= 0 ? `+${value}` : String(value);
	}

	/**
	 * Convert a value into a finite number.
	 *
	 * @param {*} value
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	_finiteNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`TestResult '${label}' must be a finite number: ` +
					String(value),
			);
		}

		return number;
	}

	/**
	 * Validate a D100 result.
	 *
	 * Foundry's 1d100 roll produces values from 1 through 100.
	 *
	 * @param {*} value
	 * @returns {number}
	 * @protected
	 */
	_d100Result(value) {
		const roll = Number(value);

		if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
			throw new Error(
				`TestResult roll must be an integer from 1 to 100: ` +
					String(value),
			);
		}

		return roll;
	}

	/**
	 * Localize a label while providing language-aware fallbacks until the
	 * corresponding localization files are audited.
	 *
	 * @param {string} key
	 * @param {string} englishFallback
	 * @param {string} polishFallback
	 * @returns {string}
	 * @protected
	 */
	_localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);

		if (localized !== key) {
			return localized;
		}

		return game.i18n.lang === "pl"
			? polishFallback
			: englishFallback;
	}
}
