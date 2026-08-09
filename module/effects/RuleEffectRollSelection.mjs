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
 * RuleEffectResolver. This class never changes that state. It snapshots which
 * currently available effects apply to one execution and preserves disabled
 * candidates so a GM can adjudicate them later without rereading live Actor or
 * Item data.
 */
export class RuleEffectRollSelection {
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

	static candidates(actor, targetIds) {
		const ids = normalizeTargetIds(targetIds);
		const candidates = [];

		for (const targetId of ids) {
			for (const candidate of RuleEffectResolver.candidates(actor, targetId)) {
				if (this.#isExecutableCandidate(candidate)) {
					candidates.push(candidate);
				}
			}
		}

		return Object.freeze(candidates);
	}

	static snapshotFromForm(actor, targetIds, form) {
		const candidates = this.candidates(actor, targetIds);
		const checked = new Set(
			Array.from(
				form?.querySelectorAll?.(
					`input[name="${FORM_FIELD_NAME}"]:checked`,
				) ?? [],
			).map((input) => String(input.value ?? "")),
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

	static buildSection(actor, targetIds) {
		const section = document.createElement("section");
		section.classList.add("wfrp-rule-effect-selection");
		section.dataset.wfrpRuleEffects = "";
		this.renderSection(section, actor, targetIds);
		return section;
	}

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
	 * Resolve every executable candidate once and attach it to the TestContext.
	 *
	 * Selected effects are enabled. Unselected effects are stored as disabled
	 * modifiers so the completed chat result can later enable them against the
	 * exact same roll and resolved numeric value. The underlying ActiveEffect is
	 * never changed by this per-roll decision.
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
			if (!rule || rule.targetId !== targetId) {
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

			let resolved;

			try {
				resolved = FormulaResolver.resolve(
					context.actor,
					String(rule.formula ?? ""),
					context,
				);
			}
			catch (error) {
				/*
				 * A selected effect must remain strict: if its formula cannot be
				 * resolved, the roll cannot truthfully continue. An unselected
				 * optional effect may be omitted from post-roll adjudication instead
				 * of breaking a roll which did not use it.
				 */
				if (rule.selected) {
					throw error;
				}

				console.warn(
					"WFRP1ED | Skipping unresolved disabled rule effect.",
					{
						rule,
						error,
					},
				);
				continue;
			}

			const value = rule.operation === RULE_EFFECT_OPERATIONS.SUBTRACT
				? -resolved
				: resolved;

			context.addModifier({
				id: `${TEST_MODIFIER_PREFIX}${rule.id}`,
				value,
				source: sourceLabel(rule),
				type: "active-effect",
				enabled: rule.selected === true,
			});
		}

		return context;
	}

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

		const source = document.createElement("span");
		source.classList.add("wfrp-rule-effect-selection__source");
		source.textContent = sourceLabel(candidate);

		const value = document.createElement("strong");
		value.classList.add("wfrp-rule-effect-selection__value");
		value.textContent = valueLabel(candidate);

		const meta = document.createElement("small");
		meta.classList.add("wfrp-rule-effect-selection__meta");
		meta.textContent = applicabilityLabel(candidate.applicability);

		body.append(source, value, meta);
		row.append(input, body);

		const tooltip = candidateTooltip(candidate);
		if (tooltip) {
			row.title = tooltip;
		}

		return row;
	}
}

function normalizeTargetIds(targetIds) {
	const source = Array.isArray(targetIds)
		? targetIds
		: [targetIds];
	const result = [];

	for (const raw of source) {
		const id = String(raw ?? "").trim();

		if (id && RuleEffectRegistry.get(id) && !result.includes(id)) {
			result.push(id);
		}
	}

	return result;
}

/**
 * Keep the visible roll/chat source compact. For Item-sourced rules the Item
 * name is the meaningful rule source; the ActiveEffect name remains available
 * as tooltip/metadata. Actor-level effects fall back to the effect name.
 */
function sourceLabel(candidate) {
	const item = String(
		candidate?.source?.itemName ?? candidate?.itemName ?? "",
	).trim();
	const effect = String(
		candidate?.source?.effectName ?? candidate?.effectName ?? "",
	).trim();

	return item || effect || localize(
		"WFRP1ED.ActiveEffect.RuleChange",
		"WFRP Rule",
		"Reguła WFRP",
	);
}

function candidateTooltip(candidate) {
	const item = String(candidate?.itemName ?? "").trim();
	const effect = String(candidate?.effectName ?? "").trim();
	const condition = String(candidate?.condition ?? "").trim();
	const parts = [];

	if (effect && effect !== item) {
		parts.push(effect);
	}

	if (condition) {
		parts.push(condition);
	}

	return parts.join(" — ");
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
				"automatic",
				"automatyczny",
			);
		case RULE_EFFECT_APPLICABILITY.MANUAL:
			return localize(
				"WFRP1ED.ActiveEffect.Manual",
				"manual",
				"ręczny",
			);
		case RULE_EFFECT_APPLICABILITY.CONTEXTUAL:
		default:
			return localize(
				"WFRP1ED.ActiveEffect.Contextual",
				"contextual",
				"sytuacyjny",
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
