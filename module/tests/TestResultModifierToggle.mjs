import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const ACTIVE_EFFECT_TYPE = "active-effect";
const GENERAL_MODIFIER_SELECTOR = "[data-wfrp-test-general-modifier]";
const ROLL_SELECTOR = "[data-wfrp-test-roll-value]";
const SOCKET_CHANNEL = "system.wfrp1ed";
const ROLL_REQUEST_TYPE = "test-result-roll-edit-request";
const ROLL_RESPONSE_TYPE = "test-result-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRollRequests = new Map();

/**
 * Post-roll adjudication for generic TestResult cards.
 *
 * The GM retains the existing general-modifier and Active Effect controls. The
 * displayed d100 may additionally be replaced by the GM or an OWNER of the
 * Actor represented by the ChatMessage speaker. Permission therefore follows
 * the character, not the user who happened to click the roll button.
 *
 * A non-GM edit is committed by the designated active GM so an Actor owner may
 * also correct a result whose ChatMessage was originally created by the GM.
 * The native Foundry Roll attached to the ChatMessage is never rewritten; the
 * original numeric result is preserved in `originalRoll` and TestResultChat is
 * re-rendered from the persisted snapshot so target, success/failure and margin
 * are recalculated through the same path as modifier edits.
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

	/**
	 * GM-authoritative d100 snapshot update used by direct GM edits and owner
	 * socket requests.
	 */
	static async commitRollValue(message, value, requestingUser) {
		if (!game.user?.isGM) {
			throw new Error("Test-result roll edits require GM authority.");
		}

		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!state) {
			throw new Error("This chat message has no editable test snapshot.");
		}
		if (!canEditRoll(message, requestingUser)) {
			throw new Error(localize(
				"WFRP1ED.TestResult.RollEditDenied",
				"Only the GM or an OWNER of this Actor can change the d100 result.",
				"Tylko MG albo Właściciel tego Aktora może zmienić wynik K100.",
			));
		}

		const normalized = normalizedD100(value);
		const updated = TestResultChat._copyState(state);
		const original = originalRoll(state);
		updated.version = Math.max(3, Number(updated.version) || 0);
		updated.originalRoll = original;
		updated.roll = normalized;
		updated.rollEdited = normalized !== original;
		updated.rollEditedBy = updated.rollEdited
			? String(requestingUser?.id ?? "")
			: "";
		updated.rollEditedAt = updated.rollEdited ? Date.now() : null;
		updated.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
		updated.updatedAt = Date.now();

		const content = await TestResultChat._render(updated);
		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});

		return Object.freeze({
			messageId: String(message.id ?? ""),
			roll: normalized,
			originalRoll: original,
			rollEdited: updated.rollEdited,
		});
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

		if (!canEditRoll(message, game.user)) {
			input.readOnly = true;
			input.tabIndex = -1;
			input.classList.add("is-readonly");
			input.title = localize(
				"WFRP1ED.TestResult.RollReadOnly",
				"Only the GM or an OWNER of this Actor can replace the d100 result.",
				"Tylko MG albo Właściciel tego Aktora może zmienić wynik K100.",
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
			if (!canEditRoll(message, game.user)) {
				throw new Error(localize(
					"WFRP1ED.TestResult.RollEditDenied",
					"Only the GM or an OWNER of this Actor can change the d100 result.",
					"Tylko MG albo Właściciel tego Aktora może zmienić wynik K100.",
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

			const value = normalizedD100(requested);
			if (value !== requested) {
				input.value = String(value);
				ui.notifications.warn(localize(
					"WFRP1ED.TestResult.RollClamped",
					`A d100 result must be between 1 and 100. The value was set to ${value}.`,
					`Wynik K100 musi mieścić się w zakresie od 1 do 100. Wartość ustawiono na ${value}.`,
				));
			}

			if (game.user?.isGM) {
				await this.commitRollValue(message, value, game.user);
				return;
			}

			await requestOwnerRollEdit(message, value);
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

async function requestOwnerRollEdit(message, value) {
	if (!canEditRoll(message, game.user)) {
		throw new Error(localize(
			"WFRP1ED.TestResult.RollEditDenied",
			"Only the GM or an OWNER of this Actor can change the d100 result.",
			"Tylko MG albo Właściciel tego Aktora może zmienić wynik K100.",
		));
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"WFRP1ED.TestResult.RollEditNeedsGM",
			"A GM must be connected to save an Actor owner's manual d100 result.",
			"MG musi być połączony, aby zapisać ręczny wynik K100 wprowadzony przez właściciela Aktora.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRollRequests.delete(requestId);
			reject(new Error("Test-result roll edit request timed out."));
		}, SOCKET_TIMEOUT_MS);

		pendingRollRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: ROLL_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			roll: normalizedD100(value),
		});
	});
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (payload) => {
		if (!payload || typeof payload !== "object") return;

		if (payload.type === ROLL_RESPONSE_TYPE) {
			handleRollResponse(payload);
			return;
		}

		if (payload.type !== ROLL_REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: ROLL_RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			requestUserId: String(payload.requestUserId ?? ""),
		};

		try {
			const message = game.messages?.get(String(payload.messageId ?? ""));
			const user = game.users?.get(String(payload.requestUserId ?? ""));
			if (!message) {
				throw new Error("Requested TestResult ChatMessage is not available.");
			}
			if (!user?.active) {
				throw new Error("Requesting user is not active.");
			}

			response.result = await TestResultModifierToggle.commitRollValue(
				message,
				payload.roll,
				user,
			);
		} catch (error) {
			response.error = error instanceof Error
				? error.message
				: String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleRollResponse(payload) {
	if (
		String(payload.requestUserId ?? "") !==
		String(game.user?.id ?? "")
	) return;

	const requestId = String(payload.requestId ?? "");
	const pending = pendingRollRequests.get(requestId);
	if (!pending) return;

	clearTimeout(pending.timeout);
	pendingRollRequests.delete(requestId);

	if (payload.error) {
		pending.reject(new Error(String(payload.error)));
		return;
	}
	pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
}

function canEditRoll(message, user) {
	if (!message || !user) return false;
	if (user.isGM) return true;

	const actor = actorForMessage(message);
	if (!actor) return false;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

/** Prefer the speaker Token Actor so synthetic Actor ownership stays correct. */
function actorForMessage(message) {
	const speaker = message?.speaker ?? {};
	const sceneId = String(speaker.scene ?? "").trim();
	const tokenId = String(speaker.token ?? "").trim();
	if (sceneId && tokenId) {
		const scene = game.scenes?.get(sceneId);
		const token = scene?.tokens?.get(tokenId);
		if (token?.actor?.documentName === "Actor") return token.actor;
	}

	const actorId = String(speaker.actor ?? "").trim();
	if (actorId) {
		const actor = game.actors?.get(actorId);
		if (actor?.documentName === "Actor") return actor;
	}

	return null;
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

function normalizedD100(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || !Number.isInteger(number)) {
		throw new Error(localize(
			"WFRP1ED.TestResult.RollInvalid",
			"Enter a whole d100 result from 1 to 100.",
			"Wprowadź całkowity wynik K100 od 1 do 100.",
		));
	}
	return Math.min(100, Math.max(1, number));
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

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}

Hooks.once("ready", () => registerSocket());

Hooks.on(
	"renderChatMessageHTML",
	(message, html) => {
		TestResultModifierToggle.activateListeners(message, html);
	},
);
