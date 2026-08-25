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

		/*
		 * DialogV2.wait resolves on every submission. It also temporarily
		 * disables all buttons before calling a button callback, so a thrown
		 * validation error leaves the dialog visibly stuck. Own this small
		 * lifecycle instead: invalid Save attempts stay open, display their
		 * error, and Foundry gets to restore both buttons normally.
		 */
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (result, dialog, submitted = false) => {
				if (settled) return;
				settled = true;
				setTimeout(() => {
					void dialog
						.close(submitted ? { submitted: true } : {})
						.then(() => resolve(result), reject);
				}, 0);
			};

			const dialog = new DialogV2({
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
				form: { closeOnSubmit: false },
				content,
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
						disabled: true,
						callback: (_event, _button, currentDialog) => {
							const validation = this.#refreshValidation(
								currentDialog,
								targets,
							);

							if (!validation.change) {
								setTimeout(() => {
									this.#refreshValidation(currentDialog, targets);
								}, 0);
								return null;
							}

							finish(validation.change, currentDialog, true);
							return validation.change;
						},
					},
					{
						action: "cancel",
						label: localize(
							"WFRP1ED.ActiveEffect.Cancel",
							"Cancel",
							"Anuluj",
						),
						icon: "fa-solid fa-xmark",
						type: "button",
						callback: (_event, _button, currentDialog) => {
							finish(null, currentDialog);
							return null;
						},
					},
				],
			});

			dialog.addEventListener(
				"render",
				() => this.#activate(dialog, targets, initial),
			);
			dialog.addEventListener(
				"close",
				() => {
					if (settled) return;
					settled = true;
					resolve(null);
				},
				{ once: true },
			);
			void dialog.render({ force: true }).catch(reject);
		});
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

		const validation = document.createElement("p");
		validation.classList.add("wfrp-rule-effect-validation");
		validation.dataset.wfrpRuleValidation = "";
		validation.setAttribute("role", "alert");
		validation.setAttribute("aria-live", "polite");
		validation.hidden = true;

		root.append(
			target.root,
			operation.root,
			value.root,
			side.root,
			applicability.root,
			stacking.root,
			condition.root,
			validation,
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

		const refreshTarget = () => {
			const target = targets.find(
				(entry) => entry.id === targetSelect.value,
			);

			this.#refreshForTarget(root, target);
		};

		root.addEventListener("change", (event) => {
			if (event.target === targetSelect) refreshTarget();
			this.#refreshValidation(dialog, targets);
		});
		root.addEventListener("input", () => {
			this.#refreshValidation(dialog, targets);
		});
		refreshTarget();
		this.#refreshValidation(dialog, targets);
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

		const target = targets.find((entry) => entry.id === targetId);

		if (!target) {
			throw new Error(
				localize(
					"WFRP1ED.ActiveEffect.InvalidTarget",
					"Select a valid WFRP rule target.",
					"Wybierz prawidłowy cel reguły WFRP.",
				),
			);
		}

		const formula = String(
			valueOf('input[name="formula"]') ?? "",
		).trim();

		if (target.valueRequired && !formula) {
			const targetLabel = RuleEffectRegistry.label(target);
			throw new Error(
				game.i18n.lang === "pl"
					? `Wprowadź wartość lub formułę dla „${targetLabel}”.`
					: `Enter a value or formula for “${targetLabel}”.`,
			);
		}

		return encodeRuleEffectChange({
			targetId,
			operation: valueOf('select[name="operation"]'),
			formula,
			side: valueOf('select[name="side"]'),
			applicability: valueOf('select[name="applicability"]'),
			stacking: valueOf('select[name="stacking"]'),
			condition: valueOf('input[name="condition"]'),
		});
	}

	static #refreshValidation(dialog, targets) {
		const root = dialog?.element?.querySelector?.(
			".wfrp-rule-effect-editor",
		);
		const warning = root?.querySelector?.(
			"[data-wfrp-rule-validation]",
		);
		const save = dialog?.element?.querySelector?.(
			'button[data-action="save"]',
		);
		let change = null;
		let message = "";

		try {
			change = this.#readDialog(dialog, targets);
		}
		catch (error) {
			message = error instanceof Error && error.message
				? error.message
				: localize(
					"WFRP1ED.ActiveEffect.ValidationFailed",
					"Correct the highlighted rule data before saving.",
					"Popraw wyróżnione dane reguły przed zapisaniem.",
				);
		}

		if (warning) {
			warning.textContent = message;
			warning.hidden = Boolean(change);
		}

		if (save) save.disabled = !change;

		const formula = root?.querySelector?.('input[name="formula"]');
		const targetId = root?.querySelector?.(
			'select[name="targetId"]',
		)?.value;
		const target = targets.find((entry) => entry.id === targetId);
		const formulaInvalid = Boolean(
			target?.valueRequired && !String(formula?.value ?? "").trim(),
		);

		if (formula) {
			if (formulaInvalid) formula.setAttribute("aria-invalid", "true");
			else formula.removeAttribute("aria-invalid");
		}

		return { change, message };
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
		case "damage":
			return localize(
				"WFRP1ED.ActiveEffect.CategoryDamage",
				"Damage",
				"Obrażenia",
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
