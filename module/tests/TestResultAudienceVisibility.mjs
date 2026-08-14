import { TestResultChat } from "./TestResultChat.mjs";
import {
	TEST_RESULT_VISIBILITY,
	normalizeTestResultVisibility,
} from "./TestResultVisibility.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";

/**
 * Viewer-specific TestResult presentation policy.
 *
 * Mechanical state always remains stored in the ChatMessage flags. This module
 * only reduces the rendered DOM for viewers who are neither GM nor OWNER of the
 * Actor who made the Test. A GM can still explicitly publish a full Test card
 * through the existing result-visibility context action.
 *
 * Restricted viewers retain only the identity/action header, optional target
 * identity supplied by TestResultIdentityChat, and final Success/Failure. They
 * do not receive threshold, formula, modifiers, d100 value, or margin.
 */
export function canSeeFullTestDetails(message, user = game.user) {
	if (!message || !user) return false;
	if (user.isGM) return true;

	const state = message.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state) return false;
	if (
		normalizeTestResultVisibility(state.resultVisibility) ===
		TEST_RESULT_VISIBILITY.PUBLIC
	) {
		return true;
	}

	const actor = actorForTestMessage(message);
	return actor?.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

export function actorForTestMessage(message) {
	const speaker = message?.speaker ?? {};
	const sceneId = String(speaker.scene ?? "").trim();
	const tokenId = String(speaker.token ?? "").trim();
	if (sceneId && tokenId) {
		const token = game.scenes?.get(sceneId)?.tokens?.get(tokenId);
		if (token?.actor?.documentName === "Actor") return token.actor;
	}

	const actorId = String(speaker.actor ?? "").trim();
	if (actorId) {
		const actor = game.actors?.get(actorId);
		if (actor?.documentName === "Actor") return actor;
	}

	return null;
}

function applyAudienceVisibility(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state || canSeeFullTestDetails(message)) return;

	const rendered = TestResultChat._asElement(html);
	const card = rendered?.matches?.(".wfrp1e-test-card")
		? rendered
		: rendered?.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	card.classList.add("is-audience-restricted");
	card.querySelector(".wfrp1e-test-card__target")?.remove();
	card.querySelector(".wfrp1e-test-card__metrics")?.remove();
}

/*
 * `registerChatHooks()` in wfrp1ed.mjs calls this static method dynamically at
 * render time. Replacing the method here upgrades the existing hook without a
 * second competing visibility pass or a broad rewrite of TestResultChat.
 */
TestResultChat.applyClientVisibility = applyAudienceVisibility;

/*
 * The persisted value remains `gm-only` for compatibility, but its UI meaning
 * is now GM + Actor OWNER. Rename only the TestResult eye-slash context action
 * after the core hook has populated the menu; do not touch unrelated Foundry
 * visibility actions which may use the same icon.
 */
Hooks.once("init", () => {
	Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
		if (!game.user?.isGM || !Array.isArray(menuItems)) return;
		const restricted = menuItems.find((entry) => {
			if (!String(entry?.icon ?? "").includes("fa-eye-slash")) return false;
			const name = String(entry?.name ?? "").toLowerCase();
			return name.includes("test details") || name.includes("szczegóły testu");
		});
		if (!restricted) return;
		restricted.name = localize(
			"Test details: restrict to GM & Actor owner",
			"Szczegóły testu: tylko MG i właściciel Aktora",
		);
	});
});

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
