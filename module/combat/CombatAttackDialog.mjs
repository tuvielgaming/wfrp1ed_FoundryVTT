import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { TestDialog } from "../tests/TestDialog.mjs";
import { TestManager } from "../tests/TestManager.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Compose attack-specific inputs around the existing generic Test contract.
 *
 * The dialog does not roll, spend Attacks, or resolve combat. It gathers one
 * generic test modifier/effect snapshot plus target and, for future ranged
 * execution, the per-shot Automatic Range Effects choice.
 */
export class CombatAttackDialog {
	static async configure(actor, weapon) {
		assertAttackInputs(actor, weapon);
		const test = attackTest(weapon);
		const effectTarget = RuleEffectRollSelection.targetIdForTest(test);
		const ranged = weapon.system?.kind === WEAPON_KIND.RANGED;

		const response = await DialogV2.wait({
			classes: [
				"wfrp1ed",
				"wfrp1ed-parchment-window",
				"wfrp1ed-combat-attack-dialog",
			],
			window: {
				title: localize(
					`Attack — ${weapon.name}`,
					`Atak — ${weapon.name}`,
				),
			},
			content: this.#buildContent(actor, weapon, test, effectTarget),
			render: (_event, dialog) => this.#activate(dialog),
			buttons: [
				{
					action: "roll",
					label: localize("Roll", "Rzuć"),
					icon: "fa-solid fa-dice-d100",
					default: true,
					callback: (_event, button) =>
						this.#readForm(
							actor,
							weapon,
							test,
							effectTarget,
							button.form,
						),
				},
				{
					action: "cancel",
					label: localize("Cancel", "Anuluj"),
					icon: "fa-solid fa-xmark",
					callback: () => null,
				},
			],
			rejectClose: false,
		});

		if (!response?.confirmed) return null;

		return Object.freeze({
			...response,
			kind: ranged ? WEAPON_KIND.RANGED : WEAPON_KIND.MELEE,
		});
	}

	static #buildContent(actor, weapon, test, effectTarget) {
		const content = document.createElement("div");
		const body = document.createElement("div");
		body.classList.add("combat-attack-dialog-body");

		body.append(
			this.#valueGroup(
				localize("Weapon", "Broń"),
				weapon.name,
			).root,
			this.#valueGroup(
				localize("Test", "Test"),
				test.name,
			).root,
		);

		const target = ActorTargetResolver.singleTargetActor();
		body.append(
			this.#valueGroup(
				localize("Target", "Cel"),
				target?.name ?? localize(
					"No single canvas target. Roll to resolve it in chat.",
					"Brak jednego celu na mapie. Kliknij Rzuć, aby wybrać go w czacie.",
				),
			).root,
		);

		const modifier = this.#numberGroup(
			"modifier",
			TestDialog.modifierLabel(),
			0,
		);
		body.append(modifier.root);

		if (weapon.system?.kind === WEAPON_KIND.RANGED) {
			const automatic = this.#checkGroup(
				"automaticRangeEffects",
				localize(
					"Automatically apply range effects",
					"Automatycznie uwzględnij zasięg",
				),
				true,
			);
			automatic.root.dataset.attackAutomaticRange = "";

			const distance = this.#numberGroup(
				"distance",
				localize("Distance", "Dystans"),
				0,
			);
			distance.input.min = "0";
			distance.input.step = "any";
			distance.root.dataset.attackRangeDistance = "";

			body.append(automatic.root, distance.root);
		}

		body.append(
			RuleEffectRollSelection.buildSection(actor, effectTarget),
		);

		if (game.user?.isGM) {
			const visibility = this.#formGroup(
				TestDialog.resultVisibilityLabel(),
			);
			const select = document.createElement("select");
			select.name = "resultVisibility";
			for (const entry of TestDialog.resultVisibilityOptions()) {
				const option = document.createElement("option");
				option.value = entry.value;
				option.textContent = entry.label;
				select.append(option);
			}
			visibility.control.append(select);
			body.append(visibility.root);
		}

		content.append(body);
		return content;
	}

	static #activate(dialog) {
		const root = dialog?.element;
		const checkbox = root?.querySelector?.(
			'input[name="automaticRangeEffects"]',
		);
		const distance = root?.querySelector?.(
			"[data-attack-range-distance]",
		);

		if (!checkbox || !distance) return;
		const refresh = () => {
			distance.hidden = checkbox.checked !== true;
		};
		checkbox.addEventListener("change", refresh);
		refresh();
	}

	static #readForm(actor, weapon, test, effectTarget, form) {
		const automaticRangeEffects = weapon.system?.kind === WEAPON_KIND.RANGED
			? form?.elements?.automaticRangeEffects?.checked === true
			: false;
		const distance = automaticRangeEffects
			? finiteNonNegative(form?.elements?.distance?.value ?? 0, "Distance")
			: 0;

		return {
			confirmed: true,
			modifier: TestDialog.readModifier(form),
			resultVisibility: TestDialog.readResultVisibility(form),
			ruleEffects: RuleEffectRollSelection.snapshotFromForm(
				actor,
				effectTarget,
				form,
			),
			target: ActorTargetResolver.singleTargetActor(),
			automaticRangeEffects,
			distance,
			manualDamageModifier: 0,
		};
	}

	static #valueGroup(labelText, value) {
		const group = this.#formGroup(labelText);
		const valueElement = document.createElement("div");
		valueElement.classList.add("combat-attack-context-value");
		valueElement.textContent = String(value ?? "—");
		group.control.append(valueElement);
		return group;
	}

	static #numberGroup(name, labelText, initial) {
		const group = this.#formGroup(labelText);
		const input = document.createElement("input");
		input.type = "number";
		input.name = name;
		input.value = String(initial);
		input.step = "1";
		input.autocomplete = "off";
		group.control.append(input);
		return { ...group, input };
	}

	static #checkGroup(name, labelText, checked) {
		const group = this.#formGroup(labelText);
		const input = document.createElement("input");
		input.type = "checkbox";
		input.name = name;
		input.checked = checked === true;
		group.control.append(input);
		return { ...group, input };
	}

	static #formGroup(labelText) {
		const root = document.createElement("div");
		root.classList.add("form-group", "combat-attack-form-group");
		const label = document.createElement("label");
		label.textContent = labelText;
		const control = document.createElement("div");
		control.classList.add("form-fields");
		root.append(label, control);
		return { root, control };
	}
}

function attackTest(weapon) {
	const testId = weapon.system?.kind === WEAPON_KIND.RANGED ? "bs" : "ws";
	const test = TestManager.get(testId);
	if (!test) throw new Error(`WFRP 1e attack Test '${testId}' is not registered.`);
	return test;
}

function assertAttackInputs(actor, weapon) {
	if (actor?.documentName !== "Actor") {
		throw new Error("Combat attack configuration requires an Actor.");
	}
	if (weapon?.type !== "weapon") {
		throw new Error("Combat attack configuration requires a Weapon Item.");
	}
	if (weapon.parent?.uuid !== actor.uuid) {
		throw new Error("The selected Weapon is not owned by this Actor.");
	}
}

function finiteNonNegative(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(`${label} must be a finite non-negative number.`);
	}
	return number;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
