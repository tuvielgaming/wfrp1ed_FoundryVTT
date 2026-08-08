import { TestModifier } from "./TestModifier.mjs";

export class TestContext {
	/**
	 * Runtime context for one test execution.
	 *
	 * @param {Actor} actor
	 * @param {Test} test
	 * @param {Object} options
	 */
	constructor(actor, test, options = {}) {
		if (!actor) {
			throw new Error("TestContext requires an Actor.");
		}

		if (!test) {
			throw new Error("TestContext requires a Test definition.");
		}

		this.actor = actor;
		this.test = test;

		/*
		 * `target` is the canonical runtime Actor property.
		 * `targetActor` is accepted as an input because existing callers may
		 * still use that option name during the current migration.
		 */
		this.target = options.target ?? options.targetActor ?? null;

		/*
		 * Some Standard Tests require only one characteristic from another
		 * creature rather than a persistent target Actor. `targetValues` lets a
		 * GM provide those audited formula inputs directly without manufacturing
		 * a Token or Actor. FormulaResolver owns how these values become
		 * `target.<characteristic>` variables.
		 */
		this.targetValues = Object.freeze(
			this._normalizeTargetValues(options.targetValues),
		);

		this.movement = options.movement ?? null;
		this.noise = options.noise ?? null;
		this.lockDifficulty = options.lockDifficulty ?? null;

		this.options = {
			...options,
			targetValues: this.targetValues,
		};
		this.modifiers = [];

		if (Number(test.defaultModifier) !== 0) {
			this.add(
				test.defaultModifier,
				"WFRP1ed.TestModifier.Default",
				"default",
			);
		}

		if (Array.isArray(options.modifiers)) {
			for (const modifier of options.modifiers) {
				this.addModifier(modifier);
			}
		}
	}

	/**
	 * Add a modifier to this test context.
	 *
	 * Plain modifier data is normalized into a TestModifier instance.
	 *
	 * @param {TestModifier|Object} modifier
	 * @returns {TestModifier}
	 */
	addModifier(modifier) {
		const normalized =
			modifier instanceof TestModifier
				? modifier
				: new TestModifier(modifier);

		normalized.value = this._finiteNumber(
			normalized.value,
			"modifier.value",
		);

		this.modifiers.push(normalized);

		return normalized;
	}

	/**
	 * Create and add a modifier.
	 *
	 * @param {number} value
	 * @param {string} source
	 * @param {string} type
	 * @param {boolean} enabled
	 * @returns {TestModifier}
	 */
	add(value, source, type = "untyped", enabled = true) {
		return this.addModifier({
			value,
			source,
			type,
			enabled,
		});
	}

	/**
	 * Sum all enabled modifiers.
	 *
	 * @returns {number}
	 */
	get totalModifier() {
		return this.modifiers
			.filter((modifier) => modifier.enabled)
			.reduce(
				(total, modifier) =>
					total +
					this._finiteNumber(
						modifier.value,
						"modifier.value",
					),
				0,
			);
	}

	/**
	 * Normalize optional manually supplied target-characteristic values.
	 *
	 * Keys remain mechanics identifiers such as `i` or `wp`; presentation
	 * labels are deliberately not stored in TestContext.
	 *
	 * @param {Object|null|undefined} values
	 * @returns {Record<string, number>}
	 * @protected
	 */
	_normalizeTargetValues(values) {
		if (values === undefined || values === null) {
			return {};
		}

		if (
			typeof values !== "object" ||
			Array.isArray(values)
		) {
			throw new Error(
				"TestContext targetValues must be an object.",
			);
		}

		const normalized = {};

		for (const [rawKey, rawValue] of Object.entries(values)) {
			const key = String(rawKey ?? "")
				.trim()
				.toLowerCase();

			if (!/^[a-z][a-z0-9]*$/.test(key)) {
				throw new Error(
					`TestContext targetValues key is invalid: ${String(rawKey)}.`,
				);
			}

			normalized[key] = this._finiteNumber(
				rawValue,
				`targetValues.${key}`,
			);
		}

		return normalized;
	}

	/**
	 * Convert a value to a finite number.
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
				`TestContext '${label}' must be a finite number: ${String(value)}`,
			);
		}

		return number;
	}
}
