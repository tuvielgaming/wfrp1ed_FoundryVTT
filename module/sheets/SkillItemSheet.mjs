import { RuleEffectDialog } from "../effects/RuleEffectDialog.mjs";
import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "../effects/RuleEffectRegistry.mjs";
import {
	RULE_EFFECT_FLAG_KEY,
	RULE_EFFECT_FLAG_SCOPE,
	RuleEffectStorage,
} from "../effects/RuleEffectStorage.mjs";
import {
	STANDARD_TEST_SKILL_IDENTITIES,
} from "../tests/standard-test-skill-identities.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } =
	foundry.applications.api;

/**
 * Native Foundry v14 sheet for WFRP 1e Skill Items.
 *
 * Skill content remains in SkillData. Mechanical rules are authored on normal
 * embedded Foundry ActiveEffects. Foundry owns effect lifecycle/state while
 * WFRP-specific rule descriptors are persisted in package-owned effect flags.
 */
export class SkillItemSheet extends HandlebarsApplicationMixin(
	ItemSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"skill-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 620,
			height: 760,
		},
		tag: "form",
		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},
		actions: {
			createEffect: this.#createEffect,
			configureEffect: this.#configureEffect,
			toggleEffect: this.#toggleEffect,
			deleteEffect: this.#deleteEffect,
			addRuleChange: this.#addRuleChange,
			editRuleChange: this.#editRuleChange,
			deleteRuleChange: this.#deleteRuleChange,
		},
	};

	static PARTS = {
		form: {
			template:
				"systems/wfrp1ed/templates/item/skill-sheet.hbs",
		},
		effects: {
			template:
				"systems/wfrp1ed/templates/item/skill-effects.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);

		context.item = this.document;
		context.system = this.document.system;
		context.editable = this.isEditable;
		context.rulesIdOptions = buildRulesIdOptions(
			this.document.system?.rulesId,
		);
		context.ruleEffects = buildEffectPresentation(this.document);
		context.effectUi = effectUiLabels();

		return context;
	}

	/** @this {SkillItemSheet} */
	static async #createEffect() {
		if (!this.isEditable) {
			return;
		}

		const [effect] = await this.document.createEmbeddedDocuments(
			"ActiveEffect",
			[
				{
					name: localize(
						"WFRP1ED.ActiveEffect.NewEffect",
						"New Effect",
						"Nowy efekt",
					),
					img:
						this.document.img ||
						foundry.documents.ActiveEffect.DEFAULT_ICON,
					disabled: false,
					transfer: true,
					flags: {
						[RULE_EFFECT_FLAG_SCOPE]: {
							[RULE_EFFECT_FLAG_KEY]: [],
						},
					},
				},
			],
		);

		if (effect?.sheet) {
			await effect.sheet.render({ force: true });
		}
	}

	/** @this {SkillItemSheet} */
	static async #configureEffect(_event, target) {
		const effect = effectFromTarget(this, target);

		if (effect?.sheet) {
			await effect.sheet.render({ force: true });
		}
	}

	/** @this {SkillItemSheet} */
	static async #toggleEffect(_event, target) {
		if (!this.isEditable) {
			return;
		}

		const effect = effectFromTarget(this, target);

		if (effect) {
			await effect.update({ disabled: !effect.disabled });
		}
	}

	/** @this {SkillItemSheet} */
	static async #deleteEffect(_event, target) {
		if (!this.isEditable) {
			return;
		}

		const effect = effectFromTarget(this, target);

		if (!effect) {
			return;
		}

		const confirmed = await DialogV2.confirm({
			content: localize(
				"WFRP1ED.ActiveEffect.DeleteEffectConfirm",
				`Delete effect '${effect.name}'?`,
				`Usunąć efekt „${effect.name}”?`,
			),
			rejectClose: false,
			modal: true,
		});

		if (confirmed) {
			await effect.delete();
		}
	}

	/** @this {SkillItemSheet} */
	static async #addRuleChange(_event, target) {
		if (!this.isEditable) {
			return;
		}

		const effect = effectFromTarget(this, target);

		if (!effect) {
			return;
		}

		const change = await RuleEffectDialog.configure();

		if (!change) {
			return;
		}

		const changes = RuleEffectStorage.rules(effect);
		changes.push(change);

		await persistEffectRules(
			this,
			effect,
			changes,
			change,
			changes.length - 1,
		);
	}

	/** @this {SkillItemSheet} */
	static async #editRuleChange(_event, target) {
		if (!this.isEditable) {
			return;
		}

		const effect = effectFromTarget(this, target);
		const index = changeIndexFromTarget(target);

		if (!effect || index < 0) {
			return;
		}

		const changes = RuleEffectStorage.rules(effect);
		const existing = changes[index];

		if (!decodeRuleEffectChange(existing)) {
			return;
		}

		const updated = await RuleEffectDialog.configure(existing);

		if (!updated) {
			return;
		}

		changes[index] = updated;

		await persistEffectRules(
			this,
			effect,
			changes,
			updated,
			index,
		);
	}

	/** @this {SkillItemSheet} */
	static async #deleteRuleChange(_event, target) {
		if (!this.isEditable) {
			return;
		}

		const effect = effectFromTarget(this, target);
		const index = changeIndexFromTarget(target);

		if (!effect || index < 0) {
			return;
		}

		const changes = RuleEffectStorage.rules(effect);

		if (!decodeRuleEffectChange(changes[index])) {
			return;
		}

		const confirmed = await DialogV2.confirm({
			content: localize(
				"WFRP1ED.ActiveEffect.DeleteRuleConfirm",
				"Delete this WFRP rule change?",
				"Usunąć tę zmianę reguły WFRP?",
			),
			rejectClose: false,
			modal: true,
		});

		if (!confirmed) {
			return;
		}

		changes.splice(index, 1);
		await persistEffectRules(this, effect, changes);
	}
}

function buildEffectPresentation(item) {
	return [...(item.effects ?? [])]
		.sort((first, second) =>
			first.name.localeCompare(
				second.name,
				game.i18n.lang,
				{ sensitivity: "base" },
			),
		)
		.map((effect) => {
			const changes = RuleEffectStorage.rules(effect);
			const rules = [];

			for (let index = 0; index < changes.length; index += 1) {
				const decoded = decodeRuleEffectChange(changes[index]);

				if (!decoded) {
					continue;
				}

				rules.push({
					changeIndex: index,
					targetLabel: RuleEffectRegistry.label(decoded.target),
					valueLabel: ruleValueLabel(decoded),
					applicabilityLabel: applicabilityLabel(
						decoded.applicability,
					),
					sideLabel: sideLabel(decoded.side),
					stackingLabel: stackingLabel(decoded.stacking),
					condition: decoded.condition,
				});
			}

			return {
				id: effect.id,
				name: effect.name,
				img:
					effect.img ||
					foundry.documents.ActiveEffect.DEFAULT_ICON,
				disabled: effect.disabled,
				stateLabel: effect.disabled
					? localize(
						"WFRP1ED.ActiveEffect.Disabled",
						"Disabled",
						"Wyłączony",
					)
					: localize(
						"WFRP1ED.ActiveEffect.Enabled",
						"Enabled",
						"Włączony",
					),
				toggleLabel: effect.disabled
					? localize(
						"WFRP1ED.ActiveEffect.Enable",
						"Enable effect",
						"Włącz efekt",
					)
					: localize(
						"WFRP1ED.ActiveEffect.Disable",
						"Disable effect",
						"Wyłącz efekt",
					),
				rules,
				otherChangeCount:
					RuleEffectStorage.nativeChanges(effect).length,
			};
		});
}

function effectUiLabels() {
	return {
		title: localize(
			"WFRP1ED.ActiveEffect.Title",
			"Active Effects",
			"Aktywne efekty",
		),
		hint: localize(
			"WFRP1ED.ActiveEffect.Hint",
			"Effects are native Foundry documents. WFRP rule changes can affect tests and procedures without hardcoding this Skill in their executors.",
			"Efekty są natywnymi dokumentami Foundry. Zmiany reguł WFRP mogą wpływać na testy i procedury bez kodowania tej Umiejętności na stałe w ich mechanice.",
		),
		addEffect: localize(
			"WFRP1ED.ActiveEffect.AddEffect",
			"Add Effect",
			"Dodaj efekt",
		),
		configureEffect: localize(
			"WFRP1ED.ActiveEffect.ConfigureEffect",
			"Foundry effect settings",
			"Ustawienia efektu Foundry",
		),
		deleteEffect: localize(
			"WFRP1ED.ActiveEffect.DeleteEffect",
			"Delete effect",
			"Usuń efekt",
		),
		addRule: localize(
			"WFRP1ED.ActiveEffect.AddRule",
			"Add WFRP rule",
			"Dodaj regułę WFRP",
		),
		editRule: localize(
			"WFRP1ED.ActiveEffect.EditRule",
			"Edit WFRP rule",
			"Edytuj regułę WFRP",
		),
		deleteRule: localize(
			"WFRP1ED.ActiveEffect.DeleteRule",
			"Delete WFRP rule",
			"Usuń regułę WFRP",
		),
		noRules: localize(
			"WFRP1ED.ActiveEffect.NoRules",
			"No WFRP rule changes in this effect.",
			"Ten efekt nie zawiera zmian reguł WFRP.",
		),
		noEffects: localize(
			"WFRP1ED.ActiveEffect.NoEffects",
			"No Active Effects. Add one to author mechanical rules for this Skill.",
			"Brak aktywnych efektów. Dodaj efekt, aby zdefiniować mechaniczne reguły tej Umiejętności.",
		),
		otherChanges: localize(
			"WFRP1ED.ActiveEffect.OtherChanges",
			"other Foundry change(s)",
			"innych zmian Foundry",
		),
	};
}

function effectFromTarget(application, target) {
	const id = target?.closest?.("[data-effect-id]")?.dataset?.effectId;

	return id
		? application.document.effects.get(id) ?? null
		: null;
}

function changeIndexFromTarget(target) {
	const value = target
		?.closest?.("[data-change-index]")
		?.dataset?.changeIndex;
	const index = Number(value);

	return Number.isInteger(index) && index >= 0
		? index
		: -1;
}

/**
 * Persist package-owned WFRP rules in ActiveEffect flags and verify the actual
 * flag payload returned by Foundry. Verification deliberately does not use the
 * legacy system.changes fallback, otherwise a failed flag write could be
 * hidden by the previous in-memory representation.
 */
async function persistEffectRules(
	application,
	effect,
	changes,
	expectedChange = null,
	expectedIndex = null,
) {
	const item = application?.document;
	const stored = await RuleEffectStorage.persist(
		item,
		effect,
		changes,
	);

	if (expectedChange) {
		const flagged = stored.getFlag?.(
			RULE_EFFECT_FLAG_SCOPE,
			RULE_EFFECT_FLAG_KEY,
		);
		const storedChanges = Array.isArray(flagged)
			? foundry.utils.deepClone(flagged)
			: [];
		const index = Number.isInteger(expectedIndex)
			? expectedIndex
			: storedChanges.length - 1;
		const actual = storedChanges[index];

		if (!sameRuleChange(actual, expectedChange)) {
			console.error(
				"WFRP1ED | ActiveEffect flag rule persistence mismatch.",
				{
					item: item?.uuid,
					effect: stored.uuid,
					expected: expectedChange,
					actual,
					storedChanges,
				},
			);

			throw new Error(
				localize(
					"WFRP1ED.ActiveEffect.PersistenceMismatch",
					"The WFRP rule was not persisted correctly. Check the console for details.",
					"Reguła WFRP nie została poprawnie zapisana. Szczegóły znajdują się w konsoli.",
				),
			);
		}
	}

	await application.render({ force: true });
	return stored;
}

function sameRuleChange(actual, expected) {
	const decodedActual = decodeRuleEffectChange(actual);
	const decodedExpected = decodeRuleEffectChange(expected);

	if (!decodedActual || !decodedExpected) {
		return false;
	}

	return (
		decodedActual.targetId === decodedExpected.targetId &&
		decodedActual.operation === decodedExpected.operation &&
		decodedActual.formula === decodedExpected.formula &&
		decodedActual.applicability === decodedExpected.applicability &&
		decodedActual.side === decodedExpected.side &&
		decodedActual.stacking === decodedExpected.stacking &&
		decodedActual.condition === decodedExpected.condition
	);
}

function ruleValueLabel(rule) {
	const value = rule.formula || "—";

	switch (rule.operation) {
		case RULE_EFFECT_OPERATIONS.ADD:
			return numericPrefix(value, "+");
		case RULE_EFFECT_OPERATIONS.SUBTRACT:
			return numericPrefix(value, "-");
		case RULE_EFFECT_OPERATIONS.MULTIPLY:
			return `× ${value}`;
		case RULE_EFFECT_OPERATIONS.OVERRIDE:
			return `= ${value}`;
		case RULE_EFFECT_OPERATIONS.GRANT:
			return value === "—"
				? localize(
					"WFRP1ED.ActiveEffect.Granted",
					"Granted",
					"Przyznane",
				)
				: value;
		default:
			return value;
	}
}

function numericPrefix(value, prefix) {
	const number = Number(value);

	if (Number.isFinite(number)) {
		return `${prefix}${Math.abs(number)}`;
	}

	return `${prefix} ${value}`;
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

function sideLabel(value) {
	switch (value) {
		case RULE_EFFECT_SIDES.TARGET:
			return localize(
				"WFRP1ED.ActiveEffect.TargetSide",
				"Target",
				"Cel",
			);
		case RULE_EFFECT_SIDES.OPPONENT:
			return localize(
				"WFRP1ED.ActiveEffect.Opponent",
				"Opponent",
				"Przeciwnik",
			);
		case RULE_EFFECT_SIDES.SELF:
		default:
			return localize(
				"WFRP1ED.ActiveEffect.Self",
				"Self",
				"Właściciel",
			);
	}
}

function stackingLabel(value) {
	switch (value) {
		case "stack":
			return localize(
				"WFRP1ED.ActiveEffect.Stack",
				"Stack",
				"Kumuluj",
			);
		case "per-acquisition":
			return localize(
				"WFRP1ED.ActiveEffect.PerAcquisition",
				"Per acquisition",
				"Za każde nabycie",
			);
		case "once":
		default:
			return localize(
				"WFRP1ED.ActiveEffect.Once",
				"Once",
				"Jednorazowo",
			);
	}
}

function buildRulesIdOptions(currentRulesId) {
	const currentId = String(currentRulesId ?? "").trim();
	const options = Object.entries(STANDARD_TEST_SKILL_IDENTITIES)
		.map(([value, identity]) => ({
			value,
			label: localizeWithFallback(
				identity.labelKey,
				identity.label,
			),
			selected: value === currentId,
		}))
		.sort((first, second) =>
			first.label.localeCompare(
				second.label,
				game.i18n.lang,
				{ sensitivity: "base" },
			),
		);

	const result = [
		{
			value: "",
			label: game.i18n.localize(
				"WFRP1ED.SkillSheet.RulesIdUnlinked",
			),
			selected: currentId.length === 0,
		},
		...options,
	];

	if (
		currentId &&
		!STANDARD_TEST_SKILL_IDENTITIES[currentId]
	) {
		result.splice(1, 0, {
			value: currentId,
			label: game.i18n.format(
				"WFRP1ED.SkillSheet.RulesIdUnknown",
				{ id: currentId },
			),
			selected: true,
		});
	}

	return Object.freeze(
		result.map((option) => Object.freeze(option)),
	);
}

function localizeWithFallback(key, fallback) {
	const localized = game.i18n.localize(key);
	return localized === key ? fallback : localized;
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
