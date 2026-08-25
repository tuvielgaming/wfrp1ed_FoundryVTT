import {
	decodeRuleEffectChange,
	encodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "./RuleEffectRegistry.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * WFRP-facing editor for one declarative ActiveEffect change.
 *
 * The parent ActiveEffect remains a normal Foundry embedded document. This
 * dialog edits only one namespaced WFRP rule change inside its v14
 * `system.changes` array.
 */
export class RuleEffectDialog {
	/**
	 * Create or edit one WFRP rule change.
	 *
	 * @param {Object|null} existingChange
	 * @returns {Promise<Object|null>}
	 */
	static async configure(existingChange = null) {
		const targets = RuleEffectRegistry.sorted();

		if (targets.length === 0) {
			throw new Error(
				"No WFRP Active Effect rule targets are registered.",
			);
		}

		const existing = decodeRuleEffectChange(existingChange);
		const initial = initialState(existing, targets);
		const content = this.#buildContent(targets, initial);

		const response = await DialogV2.wait({
			classes: [
				"wfrp1ed",
				"wfrp1ed-parchment-window",
				"wfrp1ed-rule-effect-dialog",
			],
			window: {
				title: localize(
					"WFRP1ED.ActiveEffect.RuleEditorTitle",
					"WFRP Rule Effect",
					"Efekt reguły WFRP",
				),
			},
			content,
			render: (_event, dialog) =>
				this.#activate(dialog, targets, initial),
			buttons: [
				{
					action: "save",
					label: localize(
						"WFRP1ED.ActiveEffect.Save",
						"Save",
						"Zapisz",
					),
					icon: "fa-solid fa-floppy-disk",
					default: true,
					callback: (_event, _button, dialog) =>
						this.#readDialog(dialog, targets),
				},
				{
					action: "cancel",
					label: localize(
						"WFRP1ED.ActiveEffect.Cancel",
						"Cancel",
						"Anuluj",
					),
					icon: "fa-solid fa-xmark",
					callback: () => null,
				},
			],
			rejectClose: false,
		});

		return response ?? null;
	}

	static #buildContent(targets, initial) {
		/*
		 * Foundry v14 DialogV2 requires an HTMLElement supplied as `content`
		 * to have no attributes on its outermost node. The inner wrapper owns
		 * the WFRP class used for styling and live-DOM lookup.
		 */
		const content = document.createElement("div");
		const root = document.createElement("div");
		root.classList.add("wfrp-rule-effect-editor");

		const target = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.Target",
				"Rule target",
				"Cel reguły",
			),
		);
		const targetSelect = document.createElement("select");
		targetSelect.name = "targetId";
		targetSelect.autofocus = true;
		appendGroupedTargets(targetSelect, targets, initial.targetId);
		target.control.append(targetSelect);

		const operation = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.Operation",
				"Operation",
				"Operacja",
			),
		);
		const operationSelect = document.createElement("select");
		operationSelect.name = "operation";
		appendOptions(
			operationSelect,
			operationOptions(),
			initial.operation,
		);
		operation.control.append(operationSelect);

		const value = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.ValueFormula",
				"Value / formula",
				"Wartość / formuła",
			),
		);
		const formula = document.createElement("input");
		formula.type = "text";
		formula.name = "formula";
		formula.autocomplete = "off";
		formula.value = initial.formula;
		formula.defaultValue = initial.formula;
		formula.placeholder = "10";
		value.control.append(formula);

		const side = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.Side",
				"Applies to",
				"Dotyczy",
			),
		);
		const sideSelect = document.createElement("select");
		sideSelect.name = "side";
		appendOptions(sideSelect, sideOptions(), initial.side);
		side.control.append(sideSelect);

		const applicability = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.Applicability",
				"Applicability",
				"Stosowanie",
			),
		);
		const applicabilitySelect = document.createElement("select");
		applicabilitySelect.name = "applicability";
		appendOptions(
			applicabilitySelect,
			applicabilityOptions(),
			initial.applicability,
		);
		applicability.control.append(applicabilitySelect);

		const stacking = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.Stacking",
				"Stacking",
				"Kumulowanie",
			),
		);
		const stackingSelect = document.createElement("select");
		stackingSelect.name = "stacking";
		appendOptions(
			stackingSelect,
			stackingOptions(),
			initial.stacking,
		);
		stacking.control.append(stackingSelect);

		const condition = formGroup(
			localize(
				"WFRP1ED.ActiveEffect.Condition",
				"Condition / GM note",
				"Warunek / uwaga MG",
			),
		);
		const conditionInput = document.createElement("input");
		conditionInput.type = "text";
		conditionInput.name = "condition";
		conditionInput.autocomplete = "off";
		conditionInput.value = initial.condition;
		conditionInput.defaultValue = initial.condition;
		conditionInput.placeholder = localize(
			"WFRP1ED.ActiveEffect.ConditionPlaceholder",
			"Optional situational condition",
			"Opcjonalny warunek sytuacyjny",
		);
		condition.control.append(conditionInput);

		root.append(
			target.root,
			operation.root,
			value.root,
			side.root,
			applicability.root,
			stacking.root,
			condition.root,
		);

		content.append(root);
		return content;
	}

	/**
	 * Hydrate the live DialogV2 controls after Foundry has rendered content.
	 *
	 * DialogV2 may reconstruct HTMLElement content rather than preserving the
	 * detached node's live form-control properties. Reapplying decoded values
	 * here guarantees that Edit opens with the persisted rule instead of the
	 * first option/placeholder defaults.
	 */
	static #activate(dialog, targets, initial) {
		const root = dialog?.element?.querySelector?.(
			".wfrp-rule-effect-editor",
		);
		const targetSelect = root?.querySelector?.(
			'select[name="targetId"]',
		);

		if (!root || !targetSelect) {
			return;
		}

		setControlValue(root, 'select[name="targetId"]', initial.targetId);
		setControlValue(root, 'select[name="operation"]', initial.operation);
		setControlValue(root, 'input[name="formula"]', initial.formula);
		setControlValue(root, 'select[name="side"]', initial.side);
		setControlValue(
			root,
			'select[name="applicability"]',
			initial.applicability,
		);
		setControlValue(root, 'select[name="stacking"]', initial.stacking);
		setControlValue(root, 'input[name="condition"]', initial.condition);

		const refresh = () => {
			const target = targets.find(
				(entry) => entry.id === targetSelect.value,
			);

			this.#refreshForTarget(root, target);
		};

		targetSelect.addEventListener("change", refresh);
		refresh();
	}

	static #refreshForTarget(root, target) {
		if (!root || !target) {
			return;
		}

		filterSelect(
			root.querySelector('select[name="operation"]'),
			target.operations,
		);
		filterSelect(
			root.querySelector('select[name="side"]'),
			target.sides,
		);
		filterSelect(
			root.querySelector('select[name="applicability"]'),
			target.applicabilities,
		);

		const formula = root.querySelector('input[name="formula"]');

		if (formula) {
			formula.required = target.valueRequired;
		}
	}

	static #readDialog(dialog, targets) {
		const root = dialog?.element?.querySelector?.(
			".wfrp-rule-effect-editor",
		);

		if (!root) {
			throw new Error(
				"WFRP rule effect dialog content is unavailable.",
			);
		}

		const valueOf = (selector) =>
			root.querySelector(selector)?.value;
		const targetId = valueOf('select[name="targetId"]');

		if (!targets.some((target) => target.id === targetId)) {
			throw new Error(
				`Invalid WFRP rule effect target '${String(targetId)}'.`,
			);
		}

		return encodeRuleEffectChange({
			targetId,
			operation: valueOf('select[name="operation"]'),
			formula: valueOf('input[name="formula"]'),
			side: valueOf('select[name="side"]'),
			applicability: valueOf('select[name="applicability"]'),
			stacking: valueOf('select[name="stacking"]'),
			condition: valueOf('input[name="condition"]'),
		});
	}
}

function initialState(existing, targets) {
	return Object.freeze({
		targetId: existing?.targetId ?? targets[0]?.id ?? "",
		operation: existing?.operation ?? RULE_EFFECT_OPERATIONS.ADD,
		formula: existing?.formula ?? "",
		side: existing?.side ?? RULE_EFFECT_SIDES.SELF,
		applicability:
			existing?.applicability ??
			RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
		stacking: existing?.stacking ?? "once",
		condition: existing?.condition ?? "",
	});
}

function setControlValue(root, selector, value) {
	const control = root.querySelector(selector);

	if (control) {
		control.value = String(value ?? "");
	}
}

function formGroup(labelText) {
	const root = document.createElement("div");
	root.classList.add("form-group", "wfrp-rule-effect-field");

	const label = document.createElement("label");
	label.textContent = labelText;

	const control = document.createElement("div");
	control.classList.add("form-fields");
	root.append(label, control);

	return { root, control };
}

function appendGroupedTargets(select, targets, selectedValue) {
	const groups = new Map();

	for (const target of targets) {
		let group = groups.get(target.category);

		if (!group) {
			group = [];
			groups.set(target.category, group);
		}

		group.push(target);
	}

	for (const [category, entries] of groups) {
		const optgroup = document.createElement("optgroup");
		optgroup.label = categoryLabel(category);

		for (const target of entries) {
			const option = document.createElement("option");
			option.value = target.id;
			option.textContent = RuleEffectRegistry.label(target);
			const selected = target.id === selectedValue;
			option.selected = selected;
			option.defaultSelected = selected;
			optgroup.append(option);
		}

		select.append(optgroup);
	}
}

function appendOptions(select, entries, selectedValue) {
	for (const entry of entries) {
		const option = document.createElement("option");
		option.value = entry.value;
		option.textContent = entry.label;
		const selected = entry.value === selectedValue;
		option.selected = selected;
		option.defaultSelected = selected;
		select.append(option);
	}
}

function filterSelect(select, allowed) {
	if (!select) {
		return;
	}

	let selectedAllowed = false;
	let firstAllowed = null;

	for (const option of select.options) {
		const enabled = allowed.includes(option.value);
		option.hidden = !enabled;
		option.disabled = !enabled;

		if (enabled && !firstAllowed) {
			firstAllowed = option;
		}

		if (enabled && option.selected) {
			selectedAllowed = true;
		}
	}

	if (!selectedAllowed && firstAllowed) {
		select.value = firstAllowed.value;
	}
}

function operationOptions() {
	return [
		{
			value: RULE_EFFECT_OPERATIONS.ADD,
			label: localize(
				"WFRP1ED.ActiveEffect.Add",
				"Add",
				"Dodaj",
			),
		},
		{
			value: RULE_EFFECT_OPERATIONS.SUBTRACT,
			label: localize(
				"WFRP1ED.ActiveEffect.Subtract",
				"Subtract",
				"Odejmij",
			),
		},
		{
			value: RULE_EFFECT_OPERATIONS.MULTIPLY,
			label: localize(
				"WFRP1ED.ActiveEffect.Multiply",
				"Multiply",
				"Pomnóż",
			),
		},
		{
			value: RULE_EFFECT_OPERATIONS.OVERRIDE,
			label: localize(
				"WFRP1ED.ActiveEffect.Override",
				"Override",
				"Zastąp",
			),
		},
		{
			value: RULE_EFFECT_OPERATIONS.GRANT,
			label: localize(
				"WFRP1ED.ActiveEffect.Grant",
				"Grant",
				"Przyznaj",
			),
		},
	];
}

function sideOptions() {
	return [
		{
			value: RULE_EFFECT_SIDES.SELF,
			label: localize(
				"WFRP1ED.ActiveEffect.Self",
				"Self",
				"Właściciel",
			),
		},
		{
			value: RULE_EFFECT_SIDES.TARGET,
			label: localize(
				"WFRP1ED.ActiveEffect.TargetSide",
				"Target",
				"Cel",
			),
		},
		{
			value: RULE_EFFECT_SIDES.OPPONENT,
			label: localize(
				"WFRP1ED.ActiveEffect.Opponent",
				"Opponent",
				"Przeciwnik",
			),
		},
	];
}

function applicabilityOptions() {
	return [
		{
			value: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			label: localize(
				"WFRP1ED.ActiveEffect.Automatic",
				"Automatic",
				"Automatyczny",
			),
		},
		{
			value: RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
			label: localize(
				"WFRP1ED.ActiveEffect.Contextual",
				"Contextual",
				"Sytuacyjny",
			),
		},
		{
			value: RULE_EFFECT_APPLICABILITY.MANUAL,
			label: localize(
				"WFRP1ED.ActiveEffect.Manual",
				"Manual",
				"Ręczny",
			),
		},
	];
}

function stackingOptions() {
	return [
		{
			value: "once",
			label: localize(
				"WFRP1ED.ActiveEffect.Once",
				"Once",
				"Jednorazowo",
			),
		},
		{
			value: "stack",
			label: localize(
				"WFRP1ED.ActiveEffect.Stack",
				"Stack",
				"Kumuluj",
			),
		},
		{
			value: "per-acquisition",
			label: localize(
				"WFRP1ED.ActiveEffect.PerAcquisition",
				"Per acquisition",
				"Za każde nabycie",
			),
		},
	];
}

function categoryLabel(category) {
	switch (category) {
		case "test-characteristic":
			return localize(
				"WFRP1ED.ActiveEffect.CategoryCharacteristicTests",
				"Characteristic tests",
				"Testy cech",
			);
		case "test-standard":
			return localize(
				"WFRP1ED.ActiveEffect.CategoryStandardTests",
				"Standard Tests",
				"Testy standardowe",
			);
		case "procedure-movement":
			return localize(
				"WFRP1ED.ActiveEffect.CategoryMovement",
				"Movement procedures",
				"Procedury ruchu",
			);
		case "combat-ranged":
			return localize(
				"WFRP1ED.ActiveEffect.CategoryRangedCombat",
				"Ranged combat",
				"Walka dystansowa",
			);
		default:
			return category;
	}
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
