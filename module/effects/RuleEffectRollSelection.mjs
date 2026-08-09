import { FormulaResolver } from "../tests/FormulaResolver.mjs";
import {
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "./RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "./RuleEffectResolver.mjs";

const FORM_FIELD_NAME = "wfrpRuleEffect";
const TEST_MODIFIER_PREFIX = "rule-effect:";

/**
 * Shared per-roll selection/presentation contract for declarative WFRP rule
 * effects.
 *
 * Persistent ActiveEffect enabled/disabled state is handled by Foundry and the
 * RuleEffectResolver. This class never changes that state. It only snapshots
 * which currently available effects apply to one execution.
 */
export class RuleEffectRollSelection {
	/**
	 * Return the stable effect target id for one percentile Test.
	 *
	 * @param {Test} test
	 * @returns {string|null}
	 */
	static targetIdForTest(test) {
		if (!test?.id) {
			return null;
		}

		if (test.tags?.includes("characteristic")) {
			return `test.characteristic.${test.id}.target`;
		}

		if (test.tags?.includes("standard")) {
			return `test.standard.${test.id}.target`;
		}

		return null;
	}

	/**
	 * Return currently executable candidates for one or more rule parameters.
	 *
	 * The first integration consumes self-side additive/subtractive numeric
	 * changes. Other sides/operations remain valid authoring vocabulary but are
	 * intentionally not surfaced until their consumer semantics are implemented.
	 *
	 * @param {Actor} actor
	 * @param {string|string[]} targetIds
	 * @returns {readonly Object[]}
	 */
	static candidates(actor, targetIds) {
		const ids = normalizeTargetIds(targetIds);
		const candidates = [];

		for (const targetId of ids) {
			for (const candidate of RuleEffectResolver.candidates(actor, targetId)) {
				if (!this.#isExecutableCandidate(candidate)) {
					continue;
				}

				candidates.push(candidate);
			}
		}

		return Object.freeze(candidates);
	}

	/**
	 * Create a serializable effect-selection snapshot from a rendered roll form.
	 *
	 * Players cannot suppress automatic effects. GMs may override them for one
	 * roll as part of adjudication. Contextual/manual effects are opt-in.
	 *
	 * @param {Actor} actor
	 * @param {string|string[]} targetIds
	 * @param {HTMLFormElement|null|undefined} form
	 * @returns {readonly Object[]}
	 */
	static snapshotFromForm(actor, targetIds, form) {
		const candidates = this.candidates(actor, targetIds);
		const checked = new Set(
			Array.from(form?.elements?.[FORM_FIELD_NAME] ?? [])
				.filter((input) => input?.checked)
				.map((input) => String(input.value ?? "")),
		);
		const selections = {};

		for (const candidate of candidates) {
			const automatic = candidate.applicability ===
				RULE_EFFECT_APPLICABILITY.AUTOMATIC;

			selections[candidate.id] = automatic && !game.user?.isGM
				? true
				: checked.has(candidate.id);
		}

		return RuleEffectResolver.snapshot(candidates, selections);
	}

	/**
	 * Build a roll-window section showing only effects relevant to the selected
	 * rule parameter(s).
	 *
	 * @param {Actor} actor
	 * @param {string|string[]} targetIds
	 * @returns {HTMLElement}
	 */
	static buildSection(actor, targetIds) {
		const section = document.createElement("section");
		section.classList.add("wfrp-rule-effect-selection");
		section.dataset.wfrpRuleEffects = "";
		this.renderSection(section, actor, targetIds);
		return section;
	}

	/**
	 * Refresh an existing effect section when a composed dialog changes its
	 * selected test/procedure.
	 *
	 * @param {HTMLElement} section
	 * @param {Actor} actor
	 * @param {string|string[]} targetIds
	 * @returns {void}
	 */
	static renderSection(section, actor, targetIds) {
		if (!section) {
			return;
		}

		section.replaceChildren();
		const candidates = this.candidates(actor, targetIds);
		section.hidden = candidates.length === 0;

		if (candidates.length === 0) {
			return;
		}

		const heading = document.createElement("div");
		heading.classList.add("wfrp-rule-effect-selection__heading");
		heading.textContent = localize(
			"WFRP1ED.ActiveEffect.ApplicableEffects",
			"Applicable effects",
			"Efekty dla tego testu",
		);
		section.append(heading);

		for (const candidate of candidates) {
			section.append(this.#candidateRow(candidate));
		}
	}

	/**
	 * Apply a previously captured effect selection to a percentile TestContext.
	 *
	 * If no UI snapshot exists, automatic effects are still discovered/applied
	 * while contextual/manual effects remain off. This keeps macros and other
	 * callers consistent with the declared automatic semantics.
	 *
	 * @param {TestContext} context
	 * @returns {TestContext}
	 */
	static applyToTestContext(context) {
		if (!context?.actor || !context?.test) {
			throw new Error(
				"Rule effect application requires a valid TestContext.",
			);
		}

		const targetId = this.targetIdForTest(context.test);

		if (!targetId) {
			return context;
		}

		const existingSnapshot = Array.isArray(context.options?.ruleEffects)
			? context.options.ruleEffects
			: null;
		const snapshot = existingSnapshot ?? RuleEffectResolver.snapshot(
			this.candidates(context.actor, targetId),
		);

		context.options.ruleEffects = mutableSnapshot(snapshot);

		if (Array.isArray(context.modifiers)) {
			context.modifiers = context.modifiers.filter(
				(modifier) => !String(modifier?.id ?? "")
					.startsWith(TEST_MODIFIER_PREFIX),
			);
		}

		for (const rule of snapshot) {
			if (!rule?.selected || rule.targetId !== targetId) {
				continue;
			}

			if (
				rule.side !== RULE_EFFECT_SIDES.SELF ||
				![
					RULE_EFFECT_OPERATIONS.ADD,
					RULE_EFFECT_OPERATIONS.SUBTRACT,
				].includes(rule.operation)
			) {
				continue;
			}

			const resolved = FormulaResolver.resolve(
				context.actor,
				String(rule.formula ?? ""),
				context,
			);
			const value = rule.operation === RULE_EFFECT_OPERATIONS.SUBTRACT
				? -resolved
				: resolved;

			context.addModifier({
				id: `${TEST_MODIFIER_PREFIX}${rule.id}`,
				value,
				source: sourceLabel(rule),
				type: "active-effect",
				enabled: true,
			});
		}

		return context;
	}

	/**
	 * Resolve selected numeric changes for a non-d100 procedure parameter.
	 *
	 * @param {Actor} actor
	 * @param {string} targetId
	 * @param {readonly Object[]|null|undefined} snapshot
	 * @param {Object} formulaContext
	 * @returns {{total:number, entries:readonly Object[]}}
	 */
	static resolveNumeric(actor, targetId, snapshot, formulaContext = {}) {
		const rules = Array.isArray(snapshot)
			? snapshot
			: RuleEffectResolver.snapshot(this.candidates(actor, targetId));
		const entries = [];
		let total = 0;

		for (const rule of rules) {
			if (!rule?.selected || rule.targetId !== targetId) {
				continue;
			}

			if (
				rule.side !== RULE_EFFECT_SIDES.SELF ||
				![
					RULE_EFFECT_OPERATIONS.ADD,
					RULE_EFFECT_OPERATIONS.SUBTRACT,
				].includes(rule.operation)
			) {
				continue;
			}

			const resolved = FormulaResolver.resolve(
				actor,
				String(rule.formula ?? ""),
				formulaContext,
			);
			const value = rule.operation === RULE_EFFECT_OPERATIONS.SUBTRACT
				? -resolved
				: resolved;

			total += value;
			entries.push(Object.freeze({
				id: rule.id,
				value,
				source: sourceLabel(rule),
				condition: String(rule.condition ?? ""),
			}));
		}

		return {
			total,
			entries: Object.freeze(entries),
		};
	}

	static #isExecutableCandidate(candidate) {
		return candidate?.side === RULE_EFFECT_SIDES.SELF &&
			[
				RULE_EFFECT_OPERATIONS.ADD,
				RULE_EFFECT_OPERATIONS.SUBTRACT,
			].includes(candidate.operation);
	}

	static #candidateRow(candidate) {
		const row = document.createElement("label");
		row.classList.add("wfrp-rule-effect-selection__row");

		const input = document.createElement("input");
		input.type = "checkbox";
		input.name = FORM_FIELD_NAME;
		input.value = candidate.id;
		input.checked = candidate.defaultSelected === true;

		if (
			candidate.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC &&
			!game.user?.isGM
		) {
			input.disabled = true;
		}

		const body = document.createElement("span");
		body.classList.add("wfrp-rule-effect-selection__body");

		const main = document.createElement("span");
		main.classList.add("wfrp-rule-effect-selection__main");

		const source = document.createElement("span");
		source.classList.add("wfrp-rule-effect-selection__source");
		source.textContent = sourceLabel(candidate);

		const value = document.createElement("strong");
		value.classList.add("wfrp-rule-effect-selection__value");
		value.textContent = valueLabel(candidate);

		main.append(source, value);
		body.append(main);

		const meta = document.createElement("small");
		meta.classList.add("wfrp-rule-effect-selection__meta");
		meta.textContent = [
			applicabilityLabel(candidate.applicability),
			candidate.condition,
		].filter(Boolean).join(" • ");
		body.append(meta);

		row.append(input, body);
		return row;
	}
}

function normalizeTargetIds(targetIds) {
	const source = Array.isArray(targetIds) ? targetIds : [targetIds];
	const result = [];

	for (const raw of source) {
		const id = String(raw ?? "").trim();

		if (id && RuleEffectRegistry.get(id) && !result.includes(id)) {
			result.push(id);
		}
	}

	return result;
}

function sourceLabel(candidate) {
	const item = String(
		candidate?.source?.itemName ?? candidate?.itemName ?? "",
	).trim();
	const effect = String(
		candidate?.source?.effectName ?? candidate?.effectName ?? "",
	).trim();

	if (item && effect && item !== effect) {
		return `${item}: ${effect}`;
	}

	return item || effect || localize(
		"WFRP1ED.ActiveEffect.RuleChange",
		"WFRP Rule",
		"Reguła WFRP",
	);
}

function valueLabel(candidate) {
	const formula = String(candidate?.formula ?? "").trim() || "0";

	return candidate?.operation === RULE_EFFECT_OPERATIONS.SUBTRACT
		? `−${formula}`
		: `+${formula}`;
}

function applicabilityLabel(value) {
	switch (value) {
		case RULE_EFFECT_APPLICABILITY.AUTOMATIC:
			return localize(
				"WFRP1ED.ActiveEffect.Automatic",
				"Automatic",
				"Automatyczny",
			);
		case RULE_EFFECT_APPLICABILITY.MANUAL:
			return localize(
				"WFRP1ED.ActiveEffect.Manual",
				"Manual",
				"Ręczny",
			);
		case RULE_EFFECT_APPLICABILITY.CONTEXTUAL:
		default:
			return localize(
				"WFRP1ED.ActiveEffect.Contextual",
				"Contextual",
				"Sytuacyjny",
			);
	}
}

function mutableSnapshot(snapshot) {
	return (snapshot ?? []).map((entry) => ({
		...entry,
		source: {
			...(entry?.source ?? {}),
		},
	}));
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
