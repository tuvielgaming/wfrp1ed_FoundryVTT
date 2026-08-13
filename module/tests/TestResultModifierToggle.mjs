import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const ACTIVE_EFFECT_TYPE = "active-effect";
const GENERAL_MODIFIER_SELECTOR = "[data-wfrp-test-general-modifier]";
const ROLL_SELECTOR = "[data-wfrp-test-roll-value]";

/**
 * Post-roll adjudication for generic TestResult cards.
 *
 * The GM retains the existing general-modifier and Active Effect controls. In
 * addition, the GM or the user who created the roll may replace the displayed
 * d100 value with a physical/manual result. The native Foundry Roll attached to
 * the ChatMessage is never changed; the first manual edit preserves its numeric
 * result as `originalRoll` in the snapshot and then re-renders TestResultChat so
 * target, success/failure, and margin are recalculated through the same path as
 * modifier edits.
 */
export class TestResultModifierToggle {
	static activateListeners(message, html) {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!state) return;

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		if (!card) return;

		this.#activateRollEditor(message, state, card);

		if (!game.user?.isGM) return;

		const generalModifier = card.querySelector(GENERAL_MODIFIER_SELECTOR);
		if (generalModifier instanceof HTMLInputElement) {
			generalModifier.addEventListener(
				"change",
				() => normalizeGeneralModifierInput(generalModifier),
				true,
			);
		}

		const toggles = card.querySelectorAll(
			`[data-wfrp-test-modifier-toggle][data-modifier-type="${ACTIVE_EFFECT_TYPE}"]`,
		);
		if (toggles.length === 0) return;

		card.classList.add("is-gm-effect-editable");

		for (const input of toggles) {
			const index = modifierIndex(input);
			const modifier = Array.isArray(state.otherModifiers)
				? state.otherModifiers[index]
				: null;

			if (
				index < 0 ||
				!modifier ||
				String(modifier.type ?? "") !== ACTIVE_EFFECT_TYPE
			) {
				input.disabled = true;
				continue;
			}

			input.checked = modifier.enabled !== false;
			input.disabled = false;
			input.title = localize(
				"WFRP1ED.TestResult.GMEffectToggle",
				"GM: include or exclude this effect for this result.",
				"MG: uwzględnij lub wyłącz ten efekt dla tego wyniku.",
			);

			input.addEventListener("change", () => {
				void this.#setModifierEnabled(message, index, input);
			});
		}
	}

	static #activateRollEditor(message, state, card) {
		let input = card.querySelector(ROLL_SELECTOR);
		if (!(input instanceof HTMLInputElement)) {
			const metrics = card.querySelector(".wfrp1e-test-card__metrics");
			const rollMetric = metrics?.querySelector(
				":scope > .wfrp1e-test-card__metric:first-child",
			);
			const value = rollMetric?.querySelector("strong");
			if (!(value instanceof HTMLElement)) return;

			input = document.createElement("input");
			input.type = "number";
			input.min = "1";
			input.max = "100";
			input.step = "1";
			input.inputMode = "numeric";
			input.autocomplete = "off";
			input.readOnly = true;
			input.value = String(state.roll ?? value.textContent ?? "");
			input.dataset.wfrpTestRollValue = "";
			input.classList.add("wfrp1e-test-card__roll-input");
			value.replaceWith(input);
		}

		if (!canEditRoll(message, state, game.user)) {
			input.readOnly = true;
			input.tabIndex = -1;
			input.classList.add("is-readonly");
			input.title = localize(
				"WFRP1ED.TestResult.RollReadOnly",
				"Only the GM or the user who made this roll can replace the d100 result.",
				"Tylko MG albo użytkownik, który wykonał ten rzut, może zmienić wynik K100.",
			);
			return;
		}

		input.readOnly = false;
		input.classList.add("is-editable");
		input.title = localize(
			"WFRP1ED.TestResult.RollEdit",
			"Enter a d100 result from 1 to 100, then press Enter or leave the field. The test will be recalculated without rerolling.",
			"Wprowadź wynik K100 od 1 do 100, a następnie naciśnij Enter lub opuść pole. Test zostanie przeliczony bez ponownego rzutu.",
		);

		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			input.blur();
		});

		input.addEventListener("change", () => {
			void this.#setRollValue(message, input);
		});
	}

	static async #setRollValue(message, input) {
		try {
			const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
			if (!state) {
				throw new Error(
					"This chat message has no editable test snapshot.",
				);
			}
			if (!canEditRoll(message, state, game.user)) {
				throw new Error(localize(
					"WFRP1ED.TestResult.RollEditDenied",
					"Only the GM or the user who made this roll can change the d100 result.",
					"Tylko MG albo użytkownik, który wykonał ten rzut, może zmienić wynik K100.",
				));
			}

			const raw = String(input?.value ?? "").trim();
			const requested = Number(raw);
			if (!raw || !Number.isFinite(requested) || !Number.isInteger(requested)) {
				throw new Error(localize(
					"WFRP1ED.TestResult.RollInvalid",
					"Enter a whole d100 result from 1 to 100.",
					"Wprowadź całkowity wynik K100 od 1 do 100.",
				));
			}

			const value = Math.min(100, Math.max(1, requested));
			if (value !== requested) {
				input.value = String(value);
				ui.notifications.warn(localize(
					"WFRP1ED.TestResult.RollClamped",
					`A d100 result must be between 1 and 100. The value was set to ${value}.`,
					`Wynik K100 musi mieścić się w zakresie od 1 do 100. Wartość ustawiono na ${value}.`,
				));
			}

			const updated = TestResultChat._copyState(state);
			const original = originalRoll(state);
			updated.version = Math.max(3, Number(updated.version) || 0);
			updated.originalRoll = original;
			updated.roll = value;
			updated.rollEdited = value !== original;
			updated.rollEditedBy = updated.rollEdited
				? String(game.user?.id ?? "")
				: "";
			updated.rollEditedAt = updated.rollEdited ? Date.now() : null;
			updated.updatedBy = game.user?.id ?? "";
			updated.updatedAt = Date.now();

			const content = await TestResultChat._render(updated);
			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
			});
		} catch (error) {
			console.error("WFRP1ED | Unable to edit test-result d100.", error);
			const current = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
			if (input) input.value = String(current?.roll ?? "");
			ui.notifications.error(
				error?.message ?? "Unable to change the d100 result.",
			);
		}
	}

	static async #setModifierEnabled(message, index, input) {
		if (!game.user?.isGM) return;

		try {
			const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
			if (!state) {
				throw new Error(
					"This chat message has no editable test snapshot.",
				);
			}

			const updated = TestResultChat._copyState(state);
			const modifier = updated.otherModifiers?.[index];
			if (
				!modifier ||
				String(modifier.type ?? "") !== ACTIVE_EFFECT_TYPE
			) {
				throw new Error(
					"This test modifier is not an editable Active Effect.",
				);
			}

			modifier.enabled = input.checked === true;
			updated.updatedBy = game.user?.id ?? "";
			updated.updatedAt = Date.now();

			const content = await TestResultChat._render(updated);
			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
			});
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to toggle test-result Active Effect modifier.",
				error,
			);

			const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
			const current = Array.isArray(state?.otherModifiers)
				? state.otherModifiers[index]
				: null;
			if (current) input.checked = current.enabled !== false;

			ui.notifications.error(
				error?.message ??
					"Unable to change the Active Effect modifier.",
			);
		}
	}
}

function canEditRoll(message, state, user) {
	if (!message || !state || !user) return false;
	if (user.isGM) return true;
	const userId = String(user.id ?? "");
	const createdBy = String(state.createdBy ?? "");
	const authorId = String(message.author?.id ?? message.user?.id ?? "");
	return Boolean(userId) && (createdBy === userId || authorId === userId);
}

function originalRoll(state) {
	const number = Number(state?.originalRoll ?? state?.roll);
	if (
		!Number.isFinite(number) ||
		!Number.isInteger(number) ||
		number < 1 ||
		number > 100
	) {
		throw new Error("The original test d100 result is invalid.");
	}
	return number;
}

function normalizeGeneralModifierInput(input) {
	const raw = String(input?.value ?? "").trim();
	if (raw === "" || raw === "+" || raw === "-") {
		input.value = "0";
	}
}

function modifierIndex(input) {
	const index = Number(input?.dataset?.modifierIndex);
	return Number.isInteger(index) && index >= 0 ? index : -1;
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}

Hooks.on(
	"renderChatMessageHTML",
	(message, html) => {
		TestResultModifierToggle.activateListeners(message, html);
	},
);
