import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const ACTIVE_EFFECT_TYPE = "active-effect";

/**
 * GM-only post-roll adjudication for Active Effect test modifiers.
 *
 * The chat snapshot already owns the resolved numeric modifier values and the
 * original d100 roll. Toggling one modifier therefore changes only its enabled
 * flag and re-renders TestResultChat from that immutable snapshot. The Actor,
 * Item, ActiveEffect and formula inputs are never re-read or mutated here.
 */
export class TestResultModifierToggle {
	static activateListeners(message, html) {
		if (!game.user?.isGM) {
			return;
		}

		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);

		if (!state) {
			return;
		}

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");

		if (!card) {
			return;
		}

		const toggles = card.querySelectorAll(
			`[data-wfrp-test-modifier-toggle][data-modifier-type="${ACTIVE_EFFECT_TYPE}"]`,
		);

		if (toggles.length === 0) {
			return;
		}

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
				void this.#setModifierEnabled(
					message,
					index,
					input,
				);
			});
		}
	}

	static async #setModifierEnabled(message, index, input) {
		if (!game.user?.isGM) {
			return;
		}

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
		}
		catch (error) {
			console.error(
				"WFRP1ED | Unable to toggle test-result Active Effect modifier.",
				error,
			);

			const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
			const current = Array.isArray(state?.otherModifiers)
				? state.otherModifiers[index]
				: null;

			if (current) {
				input.checked = current.enabled !== false;
			}

			ui.notifications.error(
				error?.message ??
					"Unable to change the Active Effect modifier.",
			);
		}
	}
}

function modifierIndex(input) {
	const index = Number(input?.dataset?.modifierIndex);

	return Number.isInteger(index) && index >= 0
		? index
		: -1;
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

Hooks.on(
	"renderChatMessageHTML",
	(message, html) => {
		TestResultModifierToggle.activateListeners(message, html);
	},
);
