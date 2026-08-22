import { TestResultChat } from "./TestResultChat.mjs";
import { actorForTestMessage } from "./TestResultAudienceVisibility.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_FLAG_KEY = "testResultState";
const VISIBILITY_FLAG_KEY = "testResultDetailsVisibility";
const PUBLIC = "public";
const RESTRICTED = "gm-only";

/*
 * Test-detail visibility is presentation metadata, not adjudication state.
 *
 * Historically it lived inside `testResultState`. Changing visibility therefore
 * looked like a Test-result edit to combat reconciliation/transaction guards.
 * That was harmless before damage application, but after Apply Damage the closed
 * transaction correctly rejected the apparent Test edit.
 *
 * Keep old messages compatible by falling back to state.resultVisibility, while
 * all new GM share/restrict actions persist only this separate ChatMessage flag.
 * Roll, target, margin, modifiers and damage reconciliation are never touched.
 */

TestResultChat.applyClientVisibility = applyClientVisibility;
TestResultChat.addContextMenuOptions = addContextMenuOptions;
TestResultChat.setResultVisibility = setResultVisibility;

function applyClientVisibility(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!state) return;
	if (game.user?.isGM) return;
	if (effectiveVisibility(message, state) === PUBLIC) return;

	const actor = actorForTestMessage(message);
	if (
		actor?.testUserPermission?.(
			game.user,
			CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
		) === true
	) {
		return;
	}

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	card.classList.add("is-audience-restricted");
	card.querySelector(".wfrp1e-test-card__target")?.remove();
	card.querySelector(".wfrp1e-test-card__metrics")?.remove();
}

function addContextMenuOptions(menuItems) {
	if (!game.user?.isGM || !Array.isArray(menuItems)) return;

	menuItems.push(
		{
			label: localize(
				"Test details: share with players",
				"Szczegóły testu: udostępnij graczom",
			),
			icon: '<i class="fa-solid fa-eye"></i>',
			visible: (target) => {
				const message = messageFromContextTarget(target);
				const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
				return Boolean(state) && effectiveVisibility(message, state) !== PUBLIC;
			},
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void setResultVisibility(message, PUBLIC);
			},
		},
		{
			label: localize(
				"Test details: restrict to GM & Actor owner",
				"Szczegóły testu: tylko MG i właściciel Aktora",
			),
			icon: '<i class="fa-solid fa-eye-slash"></i>',
			visible: (target) => {
				const message = messageFromContextTarget(target);
				const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
				return Boolean(state) && effectiveVisibility(message, state) === PUBLIC;
			},
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void setResultVisibility(message, RESTRICTED);
			},
		},
	);
}

async function setResultVisibility(message, visibility) {
	try {
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only a GM can change test-result detail visibility.",
				"Tylko MG może zmieniać widoczność szczegółów wyniku testu.",
			));
		}

		const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!state) {
			throw new Error(localize(
				"This ChatMessage has no Test-result snapshot.",
				"Ta wiadomość nie zawiera wyniku testu.",
			));
		}

		const normalized = visibility === PUBLIC ? PUBLIC : RESTRICTED;
		if (effectiveVisibility(message, state) === normalized &&
			message.getFlag?.(FLAG_SCOPE, VISIBILITY_FLAG_KEY) === normalized) {
			return;
		}

		/* Presentation-only flag: deliberately do not rewrite testResultState or
		 * card content. The ChatMessage update itself causes Foundry ChatLog views
		 * (including popouts) to rebuild the card from its unchanged content. */
		await message.setFlag(FLAG_SCOPE, VISIBILITY_FLAG_KEY, normalized);
	} catch (error) {
		console.error("WFRP1ED | Unable to update Test-detail visibility.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to update Test-detail visibility.",
				"Nie udało się zmienić widoczności szczegółów testu.",
			),
		);
	}
}

function effectiveVisibility(message, state = null) {
	const override = String(
		message?.getFlag?.(FLAG_SCOPE, VISIBILITY_FLAG_KEY) ?? "",
	).trim();
	if (override === PUBLIC || override === RESTRICTED) return override;

	return String(state?.resultVisibility ?? "").trim() === PUBLIC
		? PUBLIC
		: RESTRICTED;
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

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
