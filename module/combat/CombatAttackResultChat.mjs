import { CombatAttackRangeRules } from "./CombatAttackRangeRules.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";
import { canSeeFullTestDetails } from "../tests/TestResultAudienceVisibility.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const RANGE_MODIFIER_TYPE = "combat-range";

/**
 * Attack-specific context layered onto the existing generic TestResult card.
 *
 * The generic Test card remains authoritative for the physical d100 and target
 * calculation. This controller stores only combat context (weapon, defender,
 * range policy, later defence/damage state) in a separate flag and injects its
 * presentation after the generic card renders.
 *
 * Restricted viewers get only an empty attack-context shell. That lets a
 * defender OWNER receive their own defence controls later without exposing the
 * attacker's range/modifier diagnostics. Safe target identity is rendered in
 * the shared Test identity header instead.
 *
 * GM range edits deliberately rewrite the persisted range modifier inside the
 * generic test snapshot, then ask TestResultChat to re-render against the same
 * original d100. No reroll and no live Weapon/Actor reread occurs.
 */
export class CombatAttackResultChat {
	static rangeModifierType = RANGE_MODIFIER_TYPE;

	static async attach(message, attackState) {
		if (!message?.id) {
			throw new Error("Combat attack result requires a ChatMessage.");
		}

		const state = mutableCopy(attackState);
		state.version = Number(state.version) || 1;
		state.updatedBy = game.user?.id ?? "";
		state.updatedAt = Date.now();

		await message.setFlag(FLAG_SCOPE, FLAG_KEY, state);
		return message;
	}

	static activateListeners(message, html) {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!state) return;

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		if (!card || card.querySelector("[data-wfrp-combat-attack-context]")) {
			return;
		}

		const panel = this.#buildPanel(
			message,
			state,
			canSeeFullTestDetails(message),
		);
		const header = card.querySelector(".wfrp1e-test-card__header");
		if (header?.parentElement === card) {
			header.insertAdjacentElement("afterend", panel);
		} else {
			card.prepend(panel);
		}
	}

	static #buildPanel(message, state, fullDetails) {
		const panel = document.createElement("section");
		panel.classList.add("wfrp1e-combat-attack-context");
		panel.dataset.wfrpCombatAttackContext = "";

		if (!fullDetails) {
			panel.classList.add("is-audience-shell");
			return panel;
		}

		const heading = document.createElement("div");
		heading.classList.add("combat-attack-context__heading");

		const kind = document.createElement("strong");
		kind.textContent = attackFamilyLabel(state.family);
		const weapon = document.createElement("span");
		weapon.textContent = String(state.weapon?.name ?? "—");
		heading.append(kind, weapon);
		panel.append(heading);

		/*
		 * A real defender is already displayed in the shared identity block, so
		 * only the explicit no-defender/object mode needs a combat-context row.
		 */
		if (state.targetMode !== "defender") {
			panel.append(
				row(
					localize("Target", "Cel"),
					localize("No defender / object", "Bez obrońcy / obiekt"),
				),
			);
		}

		if (state.attackCost > 0) {
			panel.append(
				row(
					localize("Attacks spent", "Zużyte Ataki"),
					String(state.attackCost),
				),
			);
		}

		/* The concrete Equipment Item is the ammunition variant. Persisting its
		 * snapshot on the attack lets chat history state which special arrow/bolt
		 * was actually fired even if the inventory stack is later renamed, moved
		 * or depleted. */
		if (state.family === "ranged" && state.ammunition?.name) {
			panel.append(
				row(
					localize("Ammunition", "Amunicja"),
					String(state.ammunition.name),
				),
			);
		}

		if (state.range) {
			panel.append(this.#rangePanel(message, state));
		}

		return panel;
	}

	static #rangePanel(message, state) {
		const range = normalizeRangeState(state.range);
		const wrapper = document.createElement("div");
		wrapper.classList.add("combat-attack-range");

		const automaticRow = document.createElement("label");
		automaticRow.classList.add("combat-attack-range__control");
		const automatic = document.createElement("input");
		automatic.type = "checkbox";
		automatic.checked = range.automatic;
		automatic.dataset.attackRangeAutomatic = "";
		automatic.disabled = !game.user?.isGM;
		const automaticText = document.createElement("span");
		automaticText.textContent = localize(
			"Automatically apply range effects",
			"Automatycznie uwzględnij zasięg",
		);
		automaticRow.append(automatic, automaticText);
		wrapper.append(automaticRow);

		const distanceRow = editableNumberRow(
			localize("Distance", "Dystans"),
			range.distance,
			"attackRangeDistance",
			{ min: 0, step: "any", disabled: !game.user?.isGM },
		);
		distanceRow.root.hidden = !range.automatic;
		wrapper.append(distanceRow.root);

		if (range.automatic) {
			wrapper.append(
				row(
					localize("Range band", "Przedział zasięgu"),
					CombatAttackRangeRules.label(range.band),
				),
				row(
					localize("BS range modifier", "Modyfikator zasięgu US"),
					signed(range.bsModifier),
				),
				row(
					localize("Range damage modifier", "Modyfikator obrażeń za zasięg"),
					signed(range.damageModifier),
				),
			);
			if (range.legal === false) {
				const warning = document.createElement("div");
				warning.classList.add("combat-attack-range__warning");
				warning.textContent = localize(
					"The entered distance is beyond the weapon's Extreme range.",
					"Podany dystans przekracza maksymalny zasięg broni.",
				);
				wrapper.append(warning);
			}
		} else {
			const manual = editableNumberRow(
				localize("Damage modifier", "Modyfikator obrażeń"),
				range.manualDamageModifier,
				"attackRangeManualDamage",
				{ step: "1", disabled: !game.user?.isGM },
			);
			wrapper.append(manual.root);
		}

		if (game.user?.isGM) {
			automatic.title = localize(
				"GM: change range automation without rerolling the d100.",
				"MG: zmień automatykę zasięgu bez ponownego rzutu K100.",
			);
			automatic.addEventListener("change", () => {
				void this.#updateRange(message, {
					automatic: automatic.checked,
				});
			});

			distanceRow.input.addEventListener("change", () => {
				void this.#updateRange(message, {
					distance: distanceRow.input.value,
				});
			});

			const manualInput = wrapper.querySelector(
				"[data-attack-range-manual-damage]",
			);
			manualInput?.addEventListener("change", () => {
				void this.#updateRange(message, {
					manualDamageModifier: manualInput.value,
				});
			});
		}

		return wrapper;
	}

	static async #updateRange(message, changes) {
		try {
			if (!game.user?.isGM) {
				throw new Error("Only a GM can adjudicate attack range after the roll.");
			}

			const attackState = mutableCopy(
				message?.getFlag?.(FLAG_SCOPE, FLAG_KEY),
			);
			const testState = mutableCopy(
				message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY),
			);

			if (!attackState?.range || !testState) {
				throw new Error("This attack has no editable range/test snapshot.");
			}

			const current = normalizeRangeState(attackState.range);
			const automatic = Object.hasOwn(changes, "automatic")
				? changes.automatic === true
				: current.automatic;
			const distance = Object.hasOwn(changes, "distance")
				? nonNegativeNumber(changes.distance, "Distance")
				: current.distance;
			const manualDamageModifier = Object.hasOwn(
				changes,
				"manualDamageModifier",
			)
				? finiteNumber(changes.manualDamageModifier, "Damage modifier")
				: current.manualDamageModifier;

			let nextRange;
			if (automatic) {
				const resolved = CombatAttackRangeRules.resolve(
					current.profile,
					distance,
				);
				nextRange = {
					...current,
					automatic: true,
					distance,
					band: resolved.band,
					legal: resolved.legal,
					bsModifier: resolved.bsModifier,
					damageModifier: resolved.damageModifier,
					manualDamageModifier,
				};
			} else {
				nextRange = {
					...current,
					automatic: false,
					distance,
					band: null,
					legal: true,
					bsModifier: 0,
					damageModifier: manualDamageModifier,
					manualDamageModifier,
				};
			}

			attackState.range = nextRange;
			attackState.updatedBy = game.user?.id ?? "";
			attackState.updatedAt = Date.now();

			if (!Array.isArray(testState.otherModifiers)) {
				testState.otherModifiers = [];
			}
			let rangeModifier = testState.otherModifiers.find(
				(entry) => String(entry?.type ?? "") === RANGE_MODIFIER_TYPE,
			);
			if (!rangeModifier) {
				rangeModifier = {
					source: localize("Range", "Zasięg"),
					type: RANGE_MODIFIER_TYPE,
					value: 0,
					enabled: false,
				};
				testState.otherModifiers.push(rangeModifier);
			}
			rangeModifier.value = nextRange.bsModifier;
			rangeModifier.enabled = nextRange.automatic;
			testState.updatedBy = game.user?.id ?? "";
			testState.updatedAt = Date.now();

			const content = await TestResultChat._render(testState);
			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: attackState,
				[`flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`]: testState,
			});
		} catch (error) {
			console.error("WFRP1ED | Unable to adjudicate attack range.", error);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to update attack range.",
					"Nie udało się zaktualizować zasięgu ataku.",
				),
			);
		}
	}
}

function normalizeRangeState(value) {
	const source = value && typeof value === "object" ? value : {};
	const profile = CombatAttackRangeRules.profile(source.profile ?? {});
	return {
		automatic: source.automatic === true,
		distance: nonNegativeNumber(source.distance ?? 0, "Distance"),
		profile,
		band: source.band ?? null,
		legal: source.legal !== false,
		bsModifier: finiteNumber(source.bsModifier ?? 0, "BS modifier"),
		damageModifier: finiteNumber(source.damageModifier ?? 0, "Damage modifier"),
		manualDamageModifier: finiteNumber(
			source.manualDamageModifier ?? 0,
			"Manual damage modifier",
		),
	};
}

function editableNumberRow(labelText, value, dataName, options = {}) {
	const root = document.createElement("label");
	root.classList.add("combat-attack-context__row", "is-control");
	const label = document.createElement("span");
	label.textContent = labelText;
	const input = document.createElement("input");
	input.type = "number";
	input.value = String(value);
	input.autocomplete = "off";
	input.dataset[dataName] = "";
	if (options.min !== undefined) input.min = String(options.min);
	if (options.step !== undefined) input.step = String(options.step);
	input.disabled = options.disabled === true;
	root.append(label, input);
	return { root, input };
}

function row(labelText, value) {
	const element = document.createElement("div");
	element.classList.add("combat-attack-context__row");
	const label = document.createElement("span");
	label.textContent = labelText;
	const strong = document.createElement("strong");
	strong.textContent = String(value ?? "—");
	element.append(label, strong);
	return element;
}

function attackFamilyLabel(family) {
	return family === "ranged"
		? localize("Ranged attack", "Atak dystansowy")
		: localize("Melee attack", "Atak wręcz");
}

function mutableCopy(value) {
	return value && typeof value === "object"
		? foundry.utils.deepClone(value)
		: value;
}

function signed(value) {
	const number = finiteNumber(value, "modifier");
	return number >= 0 ? `+${number}` : String(number);
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return number;
}

function nonNegativeNumber(value, label) {
	const number = finiteNumber(value, label);
	if (number < 0) throw new Error(`${label} must not be negative.`);
	return number;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
