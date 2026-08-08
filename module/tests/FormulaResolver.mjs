const CHARACTERISTIC_IDS = Object.freeze([
	"m",
	"ws",
	"bs",
	"s",
	"t",
	"w",
	"i",
	"a",
	"dex",
	"ld",
	"int",
	"cl",
	"wp",
	"fel",
]);

const CHARACTERISTIC_ALIASES = Object.freeze({
	sp: "m",
});

export class FormulaResolver {
	/**
	 * Build the variable table used when resolving a test formula.
	 *
	 * Canonical characteristic variables use their derived `current` values.
	 * The legacy `sp` Movement identifier is exposed as an alias of canonical
	 * `m` while stored Actors and existing formulas complete their migration.
	 *
	 * Target-dependent and situational variables are included only when the
	 * required context is available. A complete target Actor supplies its full
	 * profile; an audited manually supplied target value may supply one required
	 * `target.<characteristic>` variable instead. Missing data therefore still
	 * causes formula resolution to fail instead of silently becoming zero.
	 *
	 * @param {Actor} actor
	 * @param {TestContext|Object} context
	 * @returns {Record<string, number>}
	 */
	static variables(actor, context = {}) {
		this._assertActor(actor, "Formula resolution");

		const variables = this._actorVariables(actor);
		const target = context?.target ?? null;

		if (target) {
			this._assertActor(
				target,
				"Target formula resolution",
			);

			for (
				const [key, value]
				of Object.entries(
					this._actorVariables(target),
				)
			) {
				variables[`target.${key}`] = value;
			}
		}

		this._applyTargetValues(
			variables,
			context?.targetValues ??
				context?.options?.targetValues,
		);

		variables.movement = this._hasValue(
			context?.movement,
		)
			? this._finiteNumber(
					context.movement,
					"context.movement",
				)
			: variables.m;

		if (this._hasValue(context?.noise)) {
			variables.noise = this._finiteNumber(
				context.noise,
				"context.noise",
			);
		}

		if (
			this._hasValue(
				context?.lockDifficulty,
			)
		) {
			variables.lockDifficulty =
				this._finiteNumber(
					context.lockDifficulty,
					"context.lockDifficulty",
				);
		}

		return variables;
	}

	/**
	 * Resolve a formula into a finite numeric value.
	 *
	 * Invalid formulas and unavailable variables are allowed to propagate as
	 * errors. Returning zero here would turn a configuration problem into a
	 * valid but incorrect test target.
	 *
	 * @param {Actor} actor
	 * @param {string} formula
	 * @param {TestContext|Object} context
	 * @returns {number}
	 */
	static resolve(actor, formula, context = {}) {
		if (
			typeof formula !== "string" ||
			formula.trim().length === 0
		) {
			throw new Error(
				"Formula resolution requires a non-empty " +
					"formula string.",
			);
		}

		const variables = this.variables(
			actor,
			context,
		);

		const keys = Object.keys(variables).sort(
			(first, second) =>
				second.length - first.length,
		);

		let expression = formula.trim();

		for (const key of keys) {
			expression = this._replaceVariable(
				expression,
				key,
				variables[key],
			);
		}

		try {
			return this.evaluate(expression);
		} catch (error) {
			throw new Error(
				`Unable to resolve test formula '${formula}' ` +
					`as '${expression}'.`,
				{ cause: error },
			);
		}
	}

	/**
	 * Evaluate a fully substituted arithmetic expression.
	 *
	 * @param {string} expression
	 * @returns {number}
	 */
	static evaluate(expression) {
		if (
			typeof expression !== "string" ||
			expression.trim().length === 0
		) {
			throw new Error(
				"Formula evaluation requires a non-empty " +
					"expression.",
			);
		}

		const result = Number(
			Roll.safeEval(expression),
		);

		if (!Number.isFinite(result)) {
			throw new Error(
				`Formula result is not a finite number: ` +
					`${String(result)}.`,
			);
		}

		return result;
	}

	/**
	 * Build canonical and temporary legacy variables for one Actor.
	 *
	 * @param {Actor} actor
	 * @returns {Record<string, number>}
	 * @protected
	 */
	static _actorVariables(actor) {
		const variables = {};

		for (const id of CHARACTERISTIC_IDS) {
			variables[id] =
				this._characteristicValue(
					actor,
					id,
				);
		}

		for (
			const [alias, canonicalId]
			of Object.entries(
				CHARACTERISTIC_ALIASES,
			)
		) {
			variables[alias] =
				variables[canonicalId];
		}

		return variables;
	}

	/**
	 * Add manually supplied target-characteristic values to the variable table.
	 *
	 * Manual input is restricted to known profile characteristics. It can
	 * override the equivalent value from a target Actor deliberately, although
	 * current callers provide either an Actor or manual values, not both.
	 *
	 * @param {Record<string, number>} variables
	 * @param {Object|null|undefined} targetValues
	 * @returns {void}
	 * @protected
	 */
	static _applyTargetValues(variables, targetValues) {
		if (targetValues === undefined || targetValues === null) {
			return;
		}

		if (
			typeof targetValues !== "object" ||
			Array.isArray(targetValues)
		) {
			throw new Error(
				"Formula targetValues must be an object.",
			);
		}

		for (const [rawKey, rawValue] of Object.entries(targetValues)) {
			const requestedId = String(rawKey ?? "")
				.trim()
				.toLowerCase();
			const canonicalId =
				CHARACTERISTIC_ALIASES[requestedId] ??
				requestedId;

			if (!CHARACTERISTIC_IDS.includes(canonicalId)) {
				throw new Error(
					`Unknown target characteristic '${requestedId}'.`,
				);
			}

			const value = this._finiteNumber(
				rawValue,
				`context.targetValues.${requestedId}`,
			);

			variables[`target.${canonicalId}`] = value;

			for (
				const [alias, aliasCanonicalId]
				of Object.entries(CHARACTERISTIC_ALIASES)
			) {
				if (aliasCanonicalId === canonicalId) {
					variables[`target.${alias}`] = value;
				}
			}
		}
	}

	/**
	 * Read one derived characteristic value.
	 *
	 * Wfrp1edActor owns the canonical lookup contract. Direct system access is
	 * retained as a compatibility fallback for tests using an Actor-like object.
	 *
	 * @param {Actor} actor
	 * @param {string} id
	 * @returns {number}
	 * @protected
	 */
	static _characteristicValue(actor, id) {
		const requestedId = String(id ?? "")
			.trim()
			.toLowerCase();

		const canonicalId =
			CHARACTERISTIC_ALIASES[
				requestedId
			] ?? requestedId;

		if (
			typeof actor.getCharacteristicValue ===
			"function"
		) {
			return this._finiteNumber(
				actor.getCharacteristicValue(
					canonicalId,
				),
				`${actor.name ?? actor.id}.` +
					`characteristics.${canonicalId}.current`,
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
				`Actor '${actor.name ?? actor.id}' has no ` +
					`'${requestedId}' characteristic.`,
			);
		}

		return this._finiteNumber(
			characteristic.current,
			`${actor.name ?? actor.id}.` +
				`characteristics.${canonicalId}.current`,
		);
	}

	/**
	 * Replace one complete variable name without replacing shorter names inside
	 * dotted variables such as `wp` inside `target.wp`.
	 *
	 * @param {string} expression
	 * @param {string} key
	 * @param {number} value
	 * @returns {string}
	 * @protected
	 */
	static _replaceVariable(
		expression,
		key,
		value,
	) {
		const escapedKey = key.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);

		const pattern = new RegExp(
			`(^|[^A-Za-z0-9_.])${escapedKey}` +
				`(?=$|[^A-Za-z0-9_.])`,
			"g",
		);

		return expression.replace(
			pattern,
			(_match, prefix) =>
				`${prefix}(${value})`,
		);
	}

	/**
	 * Ensure formula resolution received an Actor-like object.
	 *
	 * @param {*} actor
	 * @param {string} label
	 * @returns {void}
	 * @protected
	 */
	static _assertActor(actor, label) {
		if (
			!actor?.system?.characteristics
		) {
			throw new Error(
				`${label} requires an Actor with ` +
					"characteristics.",
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
				`Formula variable '${label}' is not a ` +
					`finite number: ${String(value)}`,
			);
		}

		return number;
	}

	/**
	 * Determine whether an optional context value was supplied.
	 *
	 * @param {*} value
	 * @returns {boolean}
	 * @protected
	 */
	static _hasValue(value) {
		return (
			value !== undefined &&
			value !== null &&
			value !== ""
		);
	}
}
