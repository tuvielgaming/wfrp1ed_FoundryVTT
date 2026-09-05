import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const PICK_LOCK_TEST_ID = "pickLock";
const PICK_POCKET_TEST_ID = "pickPocket";
const ESTIMATE_TEST_ID = "estimate";
const LISTEN_TEST_ID = "listen";
const EVALUATE_MODIFIER_ID = "skill:evaluate:modifier";
const ACUTE_HEARING_MODIFIER_ID = "skill:acuteHearing:modifier";
const UNSKILLED_PICK_LOCK_TYPE = "pick-lock-unskilled";

/*
 * Non-mechanical reminders for easy-to-forget Standard Test limits and
 * secondary Skill effects which the generic percentile result cannot express
 * numerically by itself.
 *
 * Mechanics authority:
 * - English Core Rulebook, Standard Tests — Pick Lock, printed pp.70-71:
 *   a skilled character may make up to three unsuccessful tests at the same
 *   lock; further attempts automatically fail; each attempt takes 1 round / 10s.
 * - English Core Rulebook, Standard Tests — Pick Pocket, printed p.71:
 *   one test per day; prolonged pick-pocketing suffers a cumulative -10% per
 *   consecutive day (-10 second day, -20 third, etc.); unskilled attempts -30%.
 * - English Core Rulebook, Evaluate Skill, printed p.50, together with Standard
 *   Tests — Estimate, printed p.68: Evaluate gives +10% to Estimate and reduces
 *   the Estimate margin of error from 10% to 5% in all cases. Therefore a
 *   successful Estimate with Evaluate is accurate to within +/-5%, while a
 *   failed Estimate is out by more than 5%.
 * - English Core Rulebook, Acute Hearing Skill, printed Skills section: Acute
 *   Hearing gives +10% to Listen Tests and increases hearing distance by 2 yards.
 *
 * These reminders intentionally do not create attempt/day counters or invent an
 * estimated numeric value. They keep the RAW consequences visible at the point
 * of resolution while leaving information which Core assigns to the GM in the
 * GM's hands.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state?.testId) return;

	const rendered = TestResultChat._asElement(html);
	const card = rendered?.matches?.(".wfrp1e-test-card")
		? rendered
		: rendered?.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	if (state.testId === PICK_LOCK_TEST_ID) {
		const unskilled = Array.isArray(state.otherModifiers) &&
			state.otherModifiers.some(
				(modifier) =>
					String(modifier?.type ?? "") === UNSKILLED_PICK_LOCK_TYPE,
			);

		if (!unskilled) {
			insertReminder(
				card,
				"pick-lock-skilled",
				localize(
					"Pick Lock: at the same lock, a skilled character may make up to 3 unsuccessful tests. Further attempts automatically fail. Each attempt takes 1 round (10 seconds).",
					"Otwieranie zamków: przy tym samym zamku postać posiadająca umiejętność może wykonać maksymalnie 3 nieudane testy. Dalsze próby automatycznie kończą się niepowodzeniem. Każda próba trwa 1 rundę (10 sekund).",
				),
			);
		}
		return;
	}

	if (state.testId === PICK_POCKET_TEST_ID) {
		insertReminder(
			card,
			"pick-pocket",
			localize(
				"Pick Pocket: only 1 test may be made per day. Consecutive days of pick-pocketing impose a cumulative -10% penalty (-10% on day 2, -20% on day 3, and so on). A character without Pick Pocket suffers -30%.",
				"Doliniarstwo: można wykonać tylko 1 test dziennie. Kolejne dni ciągłego kieszonkostwa nakładają kumulatywną karę -10% (-10% drugiego dnia, -20% trzeciego itd.). Postać bez Doliniarstwa otrzymuje karę -30%.",
			),
		);
		return;
	}

	if (
		state.testId === ESTIMATE_TEST_ID &&
		hasEnabledModifier(state, EVALUATE_MODIFIER_ID)
	) {
		insertReminder(
			card,
			"estimate-evaluate",
			localize(
				"Evaluate: a successful Estimate is accurate to within +/-5%; a failed Estimate is out by more than 5%.",
				"Szacowanie: udana Ocena jest dokładna do +/-5%; nieudana Ocena myli się o więcej niż 5%.",
			),
		);
		return;
	}

	if (
		state.testId === LISTEN_TEST_ID &&
		hasEnabledModifier(state, ACUTE_HEARING_MODIFIER_ID)
	) {
		insertReminder(
			card,
			"listen-acute-hearing",
			localize(
				"Acute Hearing: hearing distance is increased by 2 yards.",
				"Czuły słuch: zasięg słyszenia zwiększa się o 2 metry.",
			),
		);
	}
});

function hasEnabledModifier(state, modifierId) {
	return Array.isArray(state?.otherModifiers) && state.otherModifiers.some(
		(modifier) =>
			String(modifier?.id ?? "") === modifierId &&
			modifier?.enabled !== false,
	);
}

function insertReminder(card, id, text) {
	if (card.querySelector(`[data-wfrp-standard-test-reminder="${id}"]`)) return;
	const header = card.querySelector(".wfrp1e-test-card__header");
	if (!header) return;

	const notice = document.createElement("div");
	notice.classList.add("wfrp1e-test-card__breakdown");
	notice.dataset.wfrpStandardTestReminder = id;
	notice.setAttribute("role", "note");

	const strong = document.createElement("strong");
	strong.textContent = text;
	notice.append(strong);
	header.insertAdjacentElement("afterend", notice);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
