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
 * dialog edits only one namespaced WFRP rule change inside its `changes` array.
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
		const initialTarget = existing?.target ?? targets[0];
		const content = this.#buildContent(
			targets,
			existing,
			initialTarget,
		);

		/*
		 * DialogV2.input is the v14-native path for returning named form fields.
		 * Using its processed form data avoids relying on a button.form snapshot,
		 * which can preserve the initial select value instead of the user's live
		 * selection in this composed HTMLElement dialog.
		 */
		const response = await DialogV2.input({
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
				this.#activate(dialog, targets),
			ok: {
				label: localize(
					"WFRP1ED.ActiveEffect.Save",
					"Save",
					"Zapisz",
				),
				icon: "fa-solid fa-floppy-disk",
			},
			rejectClose: false,
		});

		if (!response) {
			return null;
		}

		return this.#readInput(response);
	}

	static #buildContent(targets, existing, initialTarget) {
		/*
		 * Foundry v14 DialogV2 requires an HTMLElement supplied as `content`
		 * to have no attributes on that outermost node. Keep the required class
		 * on an inner wrapper so render-time listener lookup remains stable.
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
		appendGroupedTargets(targetSelect, targets, existing?.targetId);
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
		appendOptions(operationSelect, operationOptions(), existing?.operation);
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
		formula.value = existing?.formula ?? "";
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
		appendOptions(sideSelect, sideOptions(), existing?.side);
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
			existing?.applicability ??
				RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
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
			existing?.stacking ?? "once",
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
		conditionInput.value = existing?.condition ?? "";
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

		this.#refreshForTarget(root, initialTarget);
		content.append(root);
		return content;
	}

	static #activate(dialog, targets) {
		const root = dialog?.element?.querySelector?.(
			".wfrp-rule-effect-editor",
		);
		const select = root?.querySelector?.(
			'select[name="targetId"]',
		);

		if (!root || !select) {
			return;
		}

		const refresh = () => {
			const target = targets.find(
				(entry) => entry.id === select.value,
			);

			this.#refreshForTarget(root, target);
		};

		select.addEventListener("change", refresh);
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

		const formula = root.querySelector('input[name="formula"]');

		if (formula) {
			formula.required = target.valueRequired;
		}
	}

	static #readInput(data) {
		return encodeRuleEffectChange({
			targetId: formDataValue(data, "targetId"),
			operation: formDataValue(data, "operation"),
			formula: formDataValue(data, "formula"),
			side: formDataValue(data, "side"),
			applicability: formDataValue(data, "applicability"),
			stacking: formDataValue(data, "stacking"),
			condition: formDataValue(data, "condition"),
		});
	}
}

function formDataValue(data, name) {
	if (
		data &&
		typeof data === "object" &&
		Object.hasOwn(data, name)
	) {
		return data[name];
	}

	if (typeof data?.get === "function") {
		return data.get(name);
	}

	return undefined;
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
			option.selected = target.id === selectedValue;
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
		option.selected = entry.value === selectedValue;
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
			label: localize("WFRP1ED.ActiveEffect.Add", "Add", "Dodaj"),
		},
		{
			value: RULE_EFFECT_OPERATIONS.SUBTRACT,
			label: localize("WFRP1ED.ActiveEffect.Subtract", "Subtract", "Odejmij"),
		},
		{
			value: RULE_EFFECT_OPERATIONS.MULTIPLY,
			label: localize("WFRP1ED.ActiveEffect.Multiply", "Multiply", "Pomnóż"),
		},
		{
			value: RULE_EFFECT_OPERATIONS.OVERRIDE,
			label: localize("WFRP1ED.ActiveEffect.Override", "Override", "Zastąp"),
		},
		{
			value: RULE_EFFECT_OPERATIONS.GRANT,
			label: localize("WFRP1ED.ActiveEffect.Grant", "Grant", "Przyznaj"),
		},
	];
}

function sideOptions() {
	return [
		{
			value: RULE_EFFECT_SIDES.SELF,
			label: localize("WFRP1ED.ActiveEffect.Self", "Self", "Właściciel"),
		},
		{
			value: RULE_EFFECT_SIDES.TARGET,
			label: localize("WFRP1ED.ActiveEffect.TargetSide", "Target", "Cel"),
		},
		{
			value: RULE_EFFECT_SIDES.OPPONENT,
			label: localize("WFRP1ED.ActiveEffect.Opponent", "Opponent", "Przeciwnik"),
		},
	];
}

function applicabilityOptions() {
	return [
		{
			value: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			label: localize("WFRP1ED.ActiveEffect.Automatic", "Automatic", "Automatyczny"),
		},
		{
			value: RULE_EFFECT_APPLICABILITY.CONTEXTUAL,
			label: localize("WFRP1ED.ActiveEffect.Contextual", "Contextual", "Sytuacyjny"),
		},
		{
			value: RULE_EFFECT_APPLICABILITY.MANUAL,
			label: localize("WFRP1ED.ActiveEffect.Manual", "Manual", "Ręczny"),
		},
	];
}

function stackingOptions() {
	return [
		{
			value: "once",
			label: localize("WFRP1ED.ActiveEffect.Once", "Once", "Jednorazowo"),
		},
		{
			value: "stack",
			label: localize("WFRP1ED.ActiveEffect.Stack", "Stack", "Kumuluj"),
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
