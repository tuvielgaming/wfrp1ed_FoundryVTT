import { TestResolver } from "./TestResolver.mjs";
import { TestResult } from "./TestResult.mjs";
import { TestContext } from "./TestContext.mjs";

export class Test {
	/**
	 * Create a reusable test definition.
	 *
	 * @param {Object} data
	 */
	constructor(data = {}) {
		if (!data.id) {
			throw new Error("A Test definition requires an id.");
		}

		if (!data.label) {
			throw new Error(`Test '${data.id}' requires a label.`);
		}

		if (!data.characteristic && !data.formula) {
			throw new Error(
				`Test '${data.id}' must define either a characteristic or a formula.`,
			);
		}

		if (data.characteristic && data.formula) {
			throw new Error(
				`Test '${data.id}' cannot define both a characteristic and a formula.`,
			);
		}

		this.id = data.id;
		this.label = data.label;
		this.labelKey = data.labelKey ?? null;
		this.characteristic = data.characteristic ?? null;
		this.formula = data.formula ?? null;
		this.skills = Array.isArray(data.skills) ? [...data.skills] : [];
		this.description = data.description ?? "";
		this.defaultModifier = this._finiteNumber(
			data.defaultModifier ?? 0,
			"defaultModifier",
		);
		this.tags = Array.isArray(data.tags) ? [...data.tags] : [];
	}

	/**
	 * Localized display name with the audited English label as fallback.
	 *
	 * Localization is resolved lazily because Test definitions can be created
	 * before Foundry has finished initializing the active language.
	 *
	 * @returns {string}
	 */
	get name() {
		if (this.labelKey) {
			const localized =
				globalThis.game?.i18n?.localize?.(this.labelKey);

			if (localized && localized !== this.labelKey) {
				return localized;
			}
		}

		return this.label;
	}

	/**
	 * Resolve the final target number for an Actor and test context.
	 *
	 * @param {Actor} actor
	 * @param {TestContext|Object} context
	 * @returns {number}
	 */
	getTarget(actor, context = {}) {
		return TestResolver.resolve(actor, this, context);
	}

	/**
	 * Execute this test using an existing TestContext.
	 *
	 * The same context configured by TestDialog is used throughout the complete
	 * execution lifecycle. This prevents dialog modifiers, targets and
	 * situational values from being lost by constructing a second context.
	 *
	 * @param {TestContext} context
	 * @returns {Promise<TestResult>}
	 */
	async roll(context) {
		if (!(context instanceof TestContext)) {
			throw new Error(
				`Test '${this.id}' requires an existing TestContext.`,
			);
		}

		if (context.test !== this) {
			throw new Error(
				`TestContext belongs to '${context.test?.id ?? "unknown"}', ` +
					`but '${this.id}' was asked to execute it.`,
			);
		}

		if (!context.actor) {
			throw new Error(
				`TestContext for '${this.id}' does not contain an Actor.`,
			);
		}

		/*
		 * Extensions may add, remove or disable modifiers and provide other
		 * situational context before the target is resolved.
		 */
		Hooks.callAll("wfrp1edPrepareTest", context);

		const target = this.getTarget(context.actor, context);
		const roll = await new Roll("1d100").evaluate();

		return new TestResult({
			actor: context.actor,
			test: this,
			target,
			roll,
			context,
		});
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
				`Test '${this.id}' property '${label}' must be a finite number: ` +
					String(value),
			);
		}

		return number;
	}
}