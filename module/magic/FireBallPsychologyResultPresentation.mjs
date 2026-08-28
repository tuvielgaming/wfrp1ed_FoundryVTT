import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ACTOR_TEST_FLAG_KEY = "actorTestRequest";
const TEST_FLAG_KEY = "testResultState";

/**
 * Restore the rule consequence beside the canonical Fear TestResult rather than
 * duplicating it on the Fire Ball transaction card.
 *
 * WFRP 1e Fear: a failed test leaves the character paralysed for the round. The
 * character may parry if attacked, but cannot move, fight, Dodge, or use another
 * avoidance skill; the Fear test repeats at the start of following rounds until
 * it is overcome. The summary is intentionally shown only on failure.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateFireBallFearFailure(message, html));
});

function decorateFireBallFearFailure(message, html) {
	if (!isFireBallFearResult(message)) return;
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!state || String(state.testId ?? "") !== "fear") return;
	const result = TestResultChat._templateContext(state).result;
	if (result?.success === true) return;

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;
	card.querySelector("[data-wfrp-fireball-psychology-summary]")?.remove();

	const section = document.createElement("section");
	section.dataset.wfrpFireballPsychologySummary = "";
	section.className = "wfrp1e-fireball-psychology-summary";
	Object.assign(section.style, {
		margin: "0.5rem 0",
		padding: "0.45rem 0.55rem",
		borderTop: "1px solid rgba(71, 49, 29, 0.35)",
		borderBottom: "1px solid rgba(71, 49, 29, 0.35)",
	});

	const heading = document.createElement("strong");
	heading.textContent = localize("Psychology — Fear", "Psychologia — Strach");
	const text = document.createElement("div");
	text.textContent = localize(
		"Failure: paralysed with fear for this round. The character cannot move, fight, or take other actions. If attacked, they may parry normally, but cannot Dodge or use another skill to avoid damage. Repeat the Fear Test at the start of each round until the fear is overcome.",
		"Porażka: postać jest sparaliżowana strachem w tej rundzie. Nie może się poruszać, walczyć ani wykonywać innych akcji. Jeśli zostanie zaatakowana, może normalnie parować, ale nie może wykonać Uniku ani użyć innej umiejętności, aby uniknąć obrażeń. Test Strachu powtarza się na początku każdej rundy, aż postać przezwycięży strach.",
	);
	text.style.marginTop = "0.25rem";
	section.append(heading, text);

	const metrics = card.querySelector(".wfrp1e-test-card__metrics");
	if (metrics) metrics.before(section);
	else card.append(section);
}

function isFireBallFearResult(message) {
	const id = String(message?.id ?? "").trim();
	if (!id) return false;
	for (const candidate of game.messages ?? []) {
		const request = candidate.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
		if (request?.source?.kind !== "spell-fire-ball") continue;
		if (String(request?.resultMessageId ?? "") === id) return true;
	}
	return false;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
