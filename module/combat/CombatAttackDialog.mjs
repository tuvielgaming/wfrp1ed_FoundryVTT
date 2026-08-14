import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { TestDialog } from "../tests/TestDialog.mjs";
import { TestManager } from "../tests/TestManager.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const { DialogV2 } = foundry.applications.api;
const TARGET_MODE_DEFENDER = "defender";
const TARGET_MODE_NONE = "none";
const TARGET_SELECTION_PENDING = "__pending__";
const TARGET_SELECTION_NONE = "__none__";

/**
 * Compose attack-specific inputs around the existing generic Test contract.
 *
 * Target mode and visible-token choice deliberately share one selector. This
 * avoids the previous two-dropdown interaction while preserving three distinct
 * states: unresolved/deferred target, an explicit no-defender/object attack,
 * and a concrete defending Actor.
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
			this.#targetGroup(),
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

	static #targetGroup() {
		const group = this.#formGroup(localize("Target", "Cel"));
		group.root.dataset.attackTargetGroup = "";

		const wrapper = document.createElement("div");
		wrapper.classList.add("combat-attack-target-picker");

		const initialTarget = ActorTargetResolver.singleTargetActor();
		const targetUuid = document.createElement("input");
		targetUuid.type = "hidden";
		targetUuid.name = "targetUuid";
		targetUuid.value = String(initialTarget?.uuid ?? "");

		const selection = document.createElement("select");
		selection.name = "targetSelection";
		selection.dataset.attackTargetSelection = "";

		appendTargetOption(
			selection,
			TARGET_SELECTION_PENDING,
			localize(
				"Choose target / resolve after Roll…",
				"Wybierz cel / rozstrzygnij po rzucie…",
			),
		);
		appendTargetOption(
			selection,
			TARGET_SELECTION_NONE,
			localize("No defender / object", "Bez obrońcy / obiekt"),
		);

		for (const entry of ActorTargetResolver.sceneTokenTargets()) {
			appendTargetOption(selection, entry.actorUuid, entry.name, entry.name);
		}

		if (initialTarget) {
			ensureTargetOption(selection, initialTarget);
			selection.value = initialTarget.uuid;
		}

		const status = document.createElement("div");
		status.classList.add("combat-attack-context-value", "combat-attack-target-status");
		status.dataset.attackTargetStatus = "";
		status.dataset.targetName = String(initialTarget?.name ?? "");

		const actions = document.createElement("div");
		actions.classList.add("combat-attack-target-actions");
		actions.append(
			this.#targetButton(
				"current-target",
				localize("Use current target", "Użyj aktualnego celu"),
				"fa-solid fa-bullseye",
			),
			this.#targetButton(
				"clear-target",
				localize("Clear", "Usuń cel"),
				"fa-solid fa-xmark",
			),
		);

		if (game.user?.isGM) {
			actions.append(
				this.#targetButton(
					"choose-actor",
					localize("Choose Actor", "Wybierz Aktora"),
					"fa-solid fa-user",
				),
			);
		}

		wrapper.append(selection, targetUuid, status, actions);
		group.control.append(wrapper);
		return group.root;
	}

	static #targetButton(action, label, iconClass) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.attackTargetAction = action;
		const icon = document.createElement("i");
		icon.className = iconClass;
		icon.setAttribute("aria-hidden", "true");
		const text = document.createElement("span");
		text.textContent = label;
		button.append(icon, text);
		return button;
	}

	static #activate(dialog) {
		const root = dialog?.element;
		if (!root) return;

		this.#activateTargetPicker(root);

		const checkbox = root.querySelector(
			'input[name="automaticRangeEffects"]',
		);
		const distance = root.querySelector(
			"[data-attack-range-distance]",
		);

		if (checkbox && distance) {
			const refresh = () => {
				distance.hidden = checkbox.checked !== true;
			};
			checkbox.addEventListener("change", refresh);
			refresh();
		}
	}

	static #activateTargetPicker(root) {
		const selection = root.querySelector('[name="targetSelection"]');
		const uuid = root.querySelector('[name="targetUuid"]');
		const status = root.querySelector("[data-attack-target-status]");
		const actions = root.querySelector(".combat-attack-target-actions");
		if (!selection || !uuid || !status || !actions) return;

		const setTarget = (target) => {
			if (!target) return;
			uuid.value = String(target.uuid ?? "");
			status.dataset.targetName = String(target.name ?? "");
			ensureTargetOption(selection, target);
			selection.value = uuid.value;
		};

		const refresh = () => {
			if (selection.value === TARGET_SELECTION_NONE) {
				uuid.value = "";
				status.dataset.targetName = "";
				status.textContent = localize(
					"No defender / object",
					"Bez obrońcy / obiekt",
				);
				return;
			}

			if (selection.value === TARGET_SELECTION_PENDING) {
				uuid.value = "";
				status.dataset.targetName = "";
				status.textContent = localize(
					"No target selected — the target can still be resolved in chat after Roll.",
					"Nie wybrano celu — cel można nadal rozstrzygnąć w czacie po rzucie.",
				);
				return;
			}

			const target = ActorTargetResolver.actorFromUuidSync(selection.value);
			if (target) {
				uuid.value = String(target.uuid ?? "");
				status.dataset.targetName = String(
					selection.selectedOptions?.[0]?.dataset?.targetName ??
					target.name ??
					"",
				);
			}
			status.textContent = status.dataset.targetName || localize(
				"Selected defender",
				"Wybrany obrońca",
			);
		};

		selection.addEventListener("change", refresh);

		for (const button of actions.querySelectorAll("[data-attack-target-action]")) {
			button.addEventListener("click", async (event) => {
				event.preventDefault();
				const action = button.dataset.attackTargetAction;

				if (action === "clear-target") {
					selection.value = TARGET_SELECTION_PENDING;
					refresh();
					return;
				}

				let target = null;
				if (action === "current-target") {
					target = ActorTargetResolver.singleTargetActor();
					if (!target) {
						ui.notifications.warn(localize(
							"Target exactly one token on the canvas, then press this button again.",
							"Wskaż dokładnie jeden token na mapie, a następnie ponownie naciśnij ten przycisk.",
						));
						return;
					}
				} else if (action === "choose-actor" && game.user?.isGM) {
					target = await ActorTargetResolver.chooseActor();
				}

				if (!target) return;
				setTarget(target);
				refresh();
			});
		}

		refresh();
	}

	static #readForm(actor, weapon, test, effectTarget, form) {
		const automaticRangeEffects = weapon.system?.kind === WEAPON_KIND.RANGED
			? form?.elements?.automaticRangeEffects?.checked === true
			: false;
		const distance = automaticRangeEffects
			? finiteNonNegative(form?.elements?.distance?.value ?? 0, "Distance")
			: 0;
		const selection = String(
			form?.elements?.targetSelection?.value ?? TARGET_SELECTION_PENDING,
		);
		const targetMode = selection === TARGET_SELECTION_NONE
			? TARGET_MODE_NONE
			: TARGET_MODE_DEFENDER;
		const target = targetMode === TARGET_MODE_DEFENDER &&
			selection !== TARGET_SELECTION_PENDING
			? ActorTargetResolver.actorFromUuidSync(form?.elements?.targetUuid?.value)
			: null;

		return {
			confirmed: true,
			modifier: TestDialog.readModifier(form),
			resultVisibility: TestDialog.readResultVisibility(form),
			ruleEffects: RuleEffectRollSelection.snapshotFromForm(
				actor,
				effectTarget,
				form,
			),
			targetMode,
			target,
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

function appendTargetOption(select, value, label, targetName = "") {
	const option = document.createElement("option");
	option.value = String(value);
	option.textContent = String(label);
	if (targetName) option.dataset.targetName = String(targetName);
	select.append(option);
	return option;
}

function ensureTargetOption(select, target) {
	const uuid = String(target?.uuid ?? "");
	if (!uuid) return;
	const existing = [...select.options].find((option) => option.value === uuid);
	if (existing) return existing;
	return appendTargetOption(
		select,
		uuid,
		String(target?.name ?? "—"),
		String(target?.name ?? ""),
	);
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
