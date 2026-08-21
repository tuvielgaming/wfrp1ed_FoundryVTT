import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const TEST_STATE_FLAG_KEY = "testResultState";
const DROWNING_STATE_FLAG_KEY = "drowningState";
const RISK_TEST_ID = "risk";

const ACTIVE_DROWNING_PHASES = new Set(["countdown", "drowning"]);
const LOCK_NOTE_SELECTOR = "[data-wfrp-drowning-risk-lock]";
const ROLL_SELECTOR = "[data-wfrp-test-roll-value]";
const GENERAL_MODIFIER_SELECTOR = "[data-wfrp-test-general-modifier]";
const MODIFIER_TOGGLE_SELECTOR = "[data-wfrp-test-modifier-toggle]";

/*
 * Presentation/editability bridge between the manual drowning lifecycle and the
 * generic TestResult card.
 *
 * Drowning remains the source of truth. This module does not persist a second
 * lock flag on the Risk message. While an accepted drowning sequence is active,
 * or while any of its Wound losses is still applied, the linked Risk card is
 * rendered read-only. Once that state is safely reversible again, the next chat
 * render naturally restores the standard TestResult permissions/listeners.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	applyDrowningRiskReadOnlyPresentation(message, html);
});

Hooks.on("updateChatMessage", (message) => {
	if (!swimmingState(message)) return;
	requestChatRefresh();
});

Hooks.on("updateActor", (actor) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!actorHasLinkedDrowning(actor)) return;
	requestChatRefresh();
});

/* Luck registers its context actions before this module is loaded. Wrap only
 * the K100-changing clover actions so they disappear while this Risk result is
 * mechanically read-only. Status/reset Luck actions remain available. */
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;
	for (const entry of menuItems) {
		if (String(entry?.icon ?? "") !== "fa-solid fa-clover") continue;
		const originalVisible = entry.visible;
		entry.visible = (target) => {
			const message = messageFromContextTarget(target);
			if (drowningLocksRiskMessage(message)) return false;
			return typeof originalVisible === "function"
				? originalVisible(target)
				: originalVisible !== false;
		};
	}
});

function applyDrowningRiskReadOnlyPresentation(message, html) {
	if (!riskTestState(message)) return;
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.(LOCK_NOTE_SELECTOR)?.remove();
	card.classList.remove("is-drowning-result-locked");

	if (!drowningLocksRiskMessage(message)) return;

	const title = localize(
		"This Risk result is read-only while the accepted drowning lifecycle depends on it. End/reverse the drowning sequence and invalidate any applied drowning Wound loss before changing the result.",
		"Ten wynik Testu Ryzyka jest tylko do odczytu, dopóki zależy od niego zaakceptowany cykl tonięcia. Zakończ/cofnij tonięcie i unieważnij zastosowaną utratę Żywotności, zanim zmienisz wynik testu.",
	);

	card.classList.add("is-drowning-result-locked");

	const roll = card.querySelector(ROLL_SELECTOR);
	if (roll instanceof HTMLInputElement) {
		makeInputReadOnly(roll, title);
	}

	const generalModifier = card.querySelector(GENERAL_MODIFIER_SELECTOR);
	if (generalModifier instanceof HTMLInputElement) {
		makeInputReadOnly(generalModifier, title);
	}

	for (const toggle of card.querySelectorAll(MODIFIER_TOGGLE_SELECTOR)) {
		if (!(toggle instanceof HTMLInputElement)) continue;
		toggle.disabled = true;
		toggle.title = title;
	}

	const note = document.createElement("section");
	note.className = "wfrp1e-drowning-risk-lock";
	note.dataset.wfrpDrowningRiskLock = "";
	note.title = title;

	const icon = document.createElement("i");
	icon.className = "fa-solid fa-lock";
	icon.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent = localize(
		"Result locked by active drowning",
		"Wynik zablokowany przez aktywne tonięcie",
	);
	note.append(icon, text);

	const metrics = card.querySelector(".wfrp1e-test-card__metrics");
	if (metrics) metrics.before(note);
	else card.append(note);
}

function makeInputReadOnly(input, title) {
	input.readOnly = true;
	input.tabIndex = -1;
	input.classList.remove("is-editable");
	input.classList.add("is-readonly");
	input.title = title;
}

function drowningLocksRiskMessage(message) {
	if (!riskTestState(message) || !message?.id) return false;
	return linkedSwimmingMessages(message.id).some((swimmingMessage) => {
		const state = drowningState(swimmingMessage);
		return Boolean(
			state && (
				ACTIVE_DROWNING_PHASES.has(String(state.phase ?? "")) ||
				hasAppliedDrowningDamage(state)
			),
		);
	});
}

function hasAppliedDrowningDamage(state) {
	const actor = actorFromUuidSync(state?.actorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return (state?.damageRounds ?? []).some((entry) =>
		DamageApplication.transactionFor(actor, entry?.packetId)?.state === "applied",
	);
}

function linkedSwimmingMessages(riskMessageId) {
	const id = String(riskMessageId ?? "").trim();
	if (!id) return [];
	return [...(game.messages ?? [])].filter((message) => {
		const state = swimmingState(message);
		return state?.hazardous === true && String(state.riskMessageId ?? "") === id;
	});
}

function actorHasLinkedDrowning(actor) {
	const uuid = String(actor?.uuid ?? "");
	if (!uuid) return false;
	return [...(game.messages ?? [])].some((message) =>
		String(drowningState(message)?.actorUuid ?? "") === uuid,
	);
}

function swimmingState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state) &&
		String(state.kind ?? "") === "swimming"
		? state
		: null;
}

function drowningState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function riskTestState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state) &&
		String(state.testId ?? "") === RISK_TEST_ID
		? state
		: null;
}

function actorFromUuidSync(uuid) {
	const id = String(uuid ?? "").trim();
	if (!id) return null;
	try {
		const document = foundry.utils.fromUuidSync(id);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(
		entry?.dataset?.messageId ??
		target?.attr?.("data-message-id") ??
		target?.data?.("message-id") ??
		"",
	).trim();
	return messageId ? game.messages?.get(messageId) ?? null : null;
}

function requestChatRefresh() {
	setTimeout(() => {
		void ui.chat?.render?.({ force: true });
	}, 0);
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
