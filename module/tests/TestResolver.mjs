import { FormulaResolver } from "./FormulaResolver.mjs";

const CHARACTERISTIC_ALIASES = Object.freeze({
	sp: "m",
});

export class TestResolver {
	/**
	 * Resolve the final target number for a test.
	 *
	 * The base target is taken either from an Actor characteristic or from a
	 * registered formula. Enabled context modifiers are applied exactly once
	 * after the base target has been resolved.
	 *
	 * This method deliberately does not clamp the result. Any WFRP 1e limits
	 * must be implemented only after verification against the core rulebooks.
	 *
	 * @param {Actor} actor
	 * @param {Test} test
	 * @param {TestContext|Object} context
	 * @returns {number}
	 */
	static resolve(actor, test, context = {}) {
		this._assertActor(actor);
		this._assertTest(test);

		const baseTarget = this._resolveBaseTarget(
			actor,
			test,
			context,
		);

		const modifier = this._resolveModifier(context);

		return this._finiteNumber(
			baseTarget + modifier,
			`test.${test.id}.target`,
		);
	}

	/**
	 * Resolve the unmodified target number.
	 *
	 * @param {Actor} actor
	 * @param {Test} test
	 * @param {TestContext|Object} context
	 * @returns {number}
	 * @protected
	 */
	static _resolveBaseTarget(actor, test, context) {
		if (test.characteristic) {
			return this._resolveCharacteristicTarget(
				actor,
				test,
			);
		}

		if (test.formula) {
			return this._finiteNumber(
				FormulaResolver.resolve(
					actor,
					test.formula,
					context,
				),
				`test.${test.id}.formula`,
			);
		}

		throw new Error(
			`Test '${test.id}' defines neither a ` +
				"characteristic nor a formula.",
		);
	}

	/**
	 * Resolve a characteristic-based target through the Actor contract.
	 *
	 * Canonical Movement uses `m`. The legacy `sp` identifier remains accepted
	 * while existing test definitions and stored Actors complete migration.
	 * Direct system access is retained only as a compatibility fallback for
	 * Actor-like objects used by isolated tests.
	 *
	 * @param {Actor} actor
	 * @param {Test} test
	 * @returns {number}
	 * @protected
	 */
	static _resolveCharacteristicTarget(actor, test) {
		const requestedId = String(
			test.characteristic ?? "",
		)
			.trim()
			.toLowerCase();

		if (!requestedId) {
			throw new Error(
				`Test '${test.id}' has an empty characteristic id.`,
			);
		}

		const canonicalId =
			CHARACTERISTIC_ALIASES[requestedId] ??
			requestedId;

		if (
			typeof actor.getCharacteristicValue ===
			"function"
		) {
			return this._finiteNumber(
				actor.getCharacteristicValue(
					canonicalId,
				),
				`${actor.name ?? actor.id}.characteristics.` +
					`${canonicalId}.current`,
			);
		}

		const characteristics =
			actor.system?.characteristics;

		const characteristic =
			characteristics?.[canonicalId] ??
			characteristics?.[requestedId] ??
			(
				canonicalId === "m"
					? characteristics?.sp
					: undefined
			);

		if (!characteristic) {
			throw new Error(
				`Test '${test.id}' references unknown ` +
					`characteristic '${requestedId}' on Actor ` +
					`'${actor.name ?? actor.id}'.`,
			);
		}

		return this._finiteNumber(
			characteristic.current,
			`${actor.name ?? actor.id}.characteristics.` +
				`${canonicalId}.current`,
		);
	}

	/**
	 * Read the combined enabled modifier from the test context.
	 *
	 * @param {TestContext|Object} context
	 * @returns {number}
	 * @protected
	 */
	static _resolveModifier(context) {
		if (
			context?.totalModifier === undefined ||
			context?.totalModifier === null
		) {
			return 0;
		}

		return this._finiteNumber(
			context.totalModifier,
			"context.totalModifier",
		);
	}

	/**
	 * Ensure test resolution received an Actor-like object.
	 *
	 * @param {*} actor
	 * @returns {void}
	 * @protected
	 */
	static _assertActor(actor) {
		if (
			!actor ||
			(
				typeof actor.getCharacteristicValue !==
					"function" &&
				!actor.system?.characteristics
			)
		) {
			throw new Error(
				"Test resolution requires an Actor with " +
					"characteristics.",
			);
		}
	}

	/**
	 * Ensure test resolution received a usable Test definition.
	 *
	 * @param {*} test
	 * @returns {void}
	 * @protected
	 */
	static _assertTest(test) {
		if (!test || typeof test !== "object") {
			throw new Error(
				"Test resolution requires a Test definition.",
			);
		}

		if (!String(test.id ?? "").trim()) {
			throw new Error(
				"Test resolution requires a Test with an id.",
			);
		}
	}

	/**
	 * Convert a value into a finite number.
	 *
	 * @param {*} value
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	static _finiteNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`Resolved value '${label}' is not a finite ` +
					`number: ${String(value)}`,
			);
		}

		return number;
	}
}