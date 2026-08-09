export const WFRP_RULE_CHANGE_TYPE = "wfrp1edRule";

export const RULE_EFFECT_APPLICABILITY = Object.freeze({
	AUTOMATIC: "automatic",
	CONTEXTUAL: "contextual",
	MANUAL: "manual",
});

export const RULE_EFFECT_SIDES = Object.freeze({
	SELF: "self",
	TARGET: "target",
	OPPONENT: "opponent",
});

export const RULE_EFFECT_OPERATIONS = Object.freeze({
	ADD: "add",
	SUBTRACT: "subtract",
	MULTIPLY: "multiply",
	OVERRIDE: "override",
	GRANT: "grant",
});

const DEFAULT_PRIORITY = 50;

/**
 * Registry of stable WFRP rule parameters which may be targeted by declarative
 * Active Effect changes.
 *
 * Subsystems register only parameters they actually understand. Item sheets
 * and extension modules can therefore present localized dropdowns without
 * exposing arbitrary Actor data paths or teaching Items about consumer logic.
 */
export class RuleEffectRegistry {
	static #targets = new Map();

	/**
	 * Register one stable rule target.
	 *
	 * @param {Object} definition
	 * @returns {Object}
	 */
	static registerTarget(definition) {
		const target = normalizeTargetDefinition(definition);

		if (this.#targets.has(target.id)) {
			throw new Error(
				`WFRP rule effect target '${target.id}' is already registered.`,
			);
		}

		this.#targets.set(target.id, target);
		return target;
	}

	/** @returns {Object|null} */
	static get(targetId) {
		return this.#targets.get(
			String(targetId ?? "").trim(),
		) ?? null;
	}

	/** @returns {readonly Object[]} */
	static all() {
		return Object.freeze([...this.#targets.values()]);
	}

	/**
	 * Return targets ordered first by category and then localized label.
	 *
	 * @returns {readonly Object[]}
	 */
	static sorted() {
		return Object.freeze(
			[...this.#targets.values()].sort((first, second) => {
				const category = first.category.localeCompare(
					second.category,
					game.i18n.lang,
					{ sensitivity: "base" },
				);

				if (category !== 0) {
					return category;
				}

				return this.label(first).localeCompare(
					this.label(second),
					game.i18n.lang,
					{ sensitivity: "base" },
				);
			}),
		);
	}

	/**
	 * Resolve a target label lazily in the active client language.
	 *
	 * Registered Foundry localization keys take precedence. `labels` provides
	 * a small package-local fallback for targets whose translation keys have not
	 * yet been promoted into the language JSON files. This keeps registration
	 * independent from the language state during the `init` hook.
	 *
	 * @returns {string}
	 */
	static label(targetOrId) {
		const target = typeof targetOrId === "string"
			? this.get(targetOrId)
			: targetOrId;

		if (!target) {
			return String(targetOrId ?? "");
		}

		if (target.labelKey) {
			const localized = game.i18n.localize(target.labelKey);

			if (localized !== target.labelKey) {
				return localized;
			}
		}

		const language = String(game.i18n.lang ?? "").trim();
		const languageLabel = target.labels?.[language];

		return languageLabel || target.label;
	}

	/** @returns {void} */
	static clear() {
		this.#targets.clear();
	}
}

/**
 * Register the non-mutating WFRP rule change type with Foundry v14.
 *
 * These changes are declarative inputs consumed by WFRP subsystems at roll or
 * procedure time. They intentionally do not modify arbitrary Actor/Item fields
 * during Foundry's normal Active Effect application pass.
 */
export function configureWfrpRuleEffectType() {
	CONFIG.ActiveEffect.changeTypes[WFRP_RULE_CHANGE_TYPE] = {
		label: localize(
			"WFRP1ED.ActiveEffect.RuleChange",
			"WFRP Rule",
			"Reguła WFRP",
		),
		defaultPriority: DEFAULT_PRIORITY,
		handler: async () => ({}),
	};
}

/**
 * Build one JSON-safe Foundry ActiveEffect change record.
 *
 * `key` owns the stable consumer parameter id. `value` stores WFRP metadata as
 * JSON because Foundry's ActiveEffect change schema deliberately provides one
 * string value field for package-defined change types.
 *
 * @param {Object} input
 * @returns {Object}
 */
export function encodeRuleEffectChange(input = {}) {
	const targetId = String(input.targetId ?? input.key ?? "").trim();
	const target = RuleEffectRegistry.get(targetId);

	if (!target) {
		throw new Error(
			`Unknown WFRP rule effect target '${targetId}'.`,
		);
	}

	const operation = normalizeAllowed(
		input.operation,
		target.operations,
		RULE_EFFECT_OPERATIONS.ADD,
		"operation",
	);
	const applicability = normalizeAllowed(
		input.applicability,
		Object.values(RULE_EFFECT_APPLICABILITY),
		RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
		"applicability",
	);
	const side = normalizeAllowed(
		input.side,
		target.sides,
		RULE_EFFECT_SIDES.SELF,
		"side",
	);
	const stacking = normalizeStacking(input.stacking);
	const formula = String(
		input.formula ?? input.value ?? "",
	).trim();
	const condition = String(input.condition ?? "").trim();

	if (
		target.valueRequired &&
		!formula
	) {
		throw new Error(
			`WFRP rule effect target '${targetId}' requires a value or formula.`,
		);
	}

	return {
		type: WFRP_RULE_CHANGE_TYPE,
		key: targetId,
		value: JSON.stringify({
			version: 1,
			operation,
			formula,
			applicability,
			side,
			stacking,
			condition,
		}),
		phase: "final",
		priority: DEFAULT_PRIORITY,
	};
}

/**
 * Decode one WFRP rule change without mutating its ActiveEffect source.
 * Invalid or foreign changes return null so consumers can safely coexist with
 * normal Foundry changes and future package-defined change types.
 *
 * @param {Object} change
 * @returns {Object|null}
 */
export function decodeRuleEffectChange(change) {
	if (change?.type !== WFRP_RULE_CHANGE_TYPE) {
		return null;
	}

	const targetId = String(change.key ?? "").trim();
	const target = RuleEffectRegistry.get(targetId);

	if (!target) {
		return null;
	}

	let payload;

	try {
		payload = JSON.parse(String(change.value ?? "{}"));
	}
	catch (_error) {
		return null;
	}

	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload)
	) {
		return null;
	}

	try {
		return Object.freeze({
			targetId,
			target,
			operation: normalizeAllowed(
				payload.operation,
				target.operations,
				RULE_EFFECT_OPERATIONS.ADD,
				"operation",
			),
			formula: String(payload.formula ?? "").trim(),
			applicability: normalizeAllowed(
				payload.applicability,
				Object.values(RULE_EFFECT_APPLICABILITY),
				RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
				"applicability",
			),
			side: normalizeAllowed(
				payload.side,
				target.sides,
				RULE_EFFECT_SIDES.SELF,
				"side",
			),
			stacking: normalizeStacking(payload.stacking),
			condition: String(payload.condition ?? "").trim(),
			priority: Number.isFinite(Number(change.priority))
				? Number(change.priority)
				: DEFAULT_PRIORITY,
		});
	}
	catch (_error) {
		return null;
	}
}

function normalizeTargetDefinition(definition = {}) {
	const id = String(definition.id ?? "").trim();
	const category = String(definition.category ?? "").trim();
	const label = String(definition.label ?? id).trim();
	const labelKey = String(definition.labelKey ?? "").trim();
	const labels = normalizeLabels(definition.labels);

	if (!id || !category || !label) {
		throw new Error(
			"WFRP rule effect targets require id, category, and label.",
		);
	}

	const sides = normalizeList(
		definition.sides,
		Object.values(RULE_EFFECT_SIDES),
		[RULE_EFFECT_SIDES.SELF],
		"side",
	);
	const operations = normalizeList(
		definition.operations,
		Object.values(RULE_EFFECT_OPERATIONS),
		[RULE_EFFECT_OPERATIONS.ADD],
		"operation",
	);

	return Object.freeze({
		id,
		category,
		label,
		labelKey,
		labels,
		sides: Object.freeze(sides),
		operations: Object.freeze(operations),
		valueRequired: definition.valueRequired !== false,
		metadata: Object.freeze({
			...(definition.metadata ?? {}),
		}),
	});
}

function normalizeLabels(value) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return Object.freeze({});
	}

	const labels = {};

	for (const [language, label] of Object.entries(value)) {
		const lang = String(language ?? "").trim();
		const text = String(label ?? "").trim();

		if (lang && text) {
			labels[lang] = text;
		}
	}

	return Object.freeze(labels);
}

function normalizeAllowed(value, allowed, fallback, label) {
	const normalized = String(value ?? fallback).trim();

	if (!allowed.includes(normalized)) {
		throw new Error(
			`Unsupported WFRP rule effect ${label} '${normalized}'.`,
		);
	}

	return normalized;
}

function normalizeList(values, allowed, fallback, label) {
	const source = Array.isArray(values) && values.length > 0
		? values
		: fallback;
	const result = [];

	for (const value of source) {
		const normalized = String(value ?? "").trim();

		if (!allowed.includes(normalized)) {
			throw new Error(
				`Unsupported WFRP rule effect ${label} '${normalized}'.`,
			);
		}

		if (!result.includes(normalized)) {
			result.push(normalized);
		}
	}

	return result;
}

function normalizeStacking(value) {
	const normalized = String(value ?? "once").trim();
	const allowed = ["once", "stack", "per-acquisition"];

	if (!allowed.includes(normalized)) {
		throw new Error(
			`Unsupported WFRP rule effect stacking '${normalized}'.`,
		);
	}

	return normalized;
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);

	if (localized !== key) {
		return localized;
	}

	return game.i18n.lang === "pl"
		? polishFallback
		: englishFallback;
}
