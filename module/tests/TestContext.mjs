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
		 * `target` is the canonical runtime property.
		 * `targetActor` is accepted as an input because existing callers may
		 * still use that option name during the current migration.
		 */
		this.target = options.target ?? options.targetActor ?? null;

		this.movement = options.movement ?? null;
		this.noise = options.noise ?? null;
		this.lockDifficulty = options.lockDifficulty ?? null;

		this.options = { ...options };
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