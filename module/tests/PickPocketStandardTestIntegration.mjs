import { StandardTestDialog } from "./StandardTestDialog.mjs";
import { StandardTestSkillResolver } from "./StandardTestSkillResolver.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

const PICK_POCKET_TEST_ID = "pickPocket";
const PICK_POCKET_SKILL_ID = "pickPocket";
const UNSKILLED_PICK_POCKET_MODIFIER = -30;
const UNSKILLED_PICK_POCKET_MODIFIER_TYPE = "pick-pocket-unskilled";
const FLAG_SCOPE = "wfrp1ed";
const TEST_RESULT_FLAG_KEY = "testResultState";

/*
 * WFRP 1e Standard Test — Pick Pocket.
 *
 * Mechanics authority:
 * - English Core Rulebook, Standard Tests — Pick Pocket, printed p.71:
 *   a character without Pick Pocket suffers -30% on all Pick Pocket tests.
 * - Polish Core Rulebook, Standardowe Testy — Kradzież kieszonkowa,
 *   printed p.67: postać bez Doliniarstwa otrzymuje -30% do wszystkich testów
 *   kradzieży kieszonkowej.
 *
 * Repeated-acquisition bonuses remain owned by StandardTestSkillResolver.
 * This integration adds only the missing penalty for an Actor who has no
 * Pick Pocket acquisition at all. The modifier is adjudicable after the roll
 * through the same GM/OWNER checkbox contract used by other test modifiers.
 */
installPickPocketDialogRule();
registerPickPocketResultAdjudication();

function installPickPocketDialogRule() {
	if (StandardTestDialog.__wfrpPickPocketRulesInstalled === true) return;

	Object.defineProperty(StandardTestDialog, "__wfrpPickPocketRulesInstalled", {
		value: true,
		configurable: false,
	});

	const originalReadForm = StandardTestDialog._readForm;

	StandardTestDialog._readForm = function (actor, form, entries) {
		const response = originalReadForm.call(this, actor, form, entries);

		if (
			response?.kind !== "test" ||
			response.testId !== PICK_POCKET_TEST_ID ||
			hasPickPocketSkill(actor)
		) {
			return response;
		}

		response.options.modifiers = [
			...(response.options.modifiers ?? []),
			{
				id: "pick-pocket-unskilled-penalty",
				value: UNSKILLED_PICK_POCKET_MODIFIER,
				source: localize(
					"No Pick Pocket skill",
					"Brak umiejętności Doliniarstwo",
				),
				type: UNSKILLED_PICK_POCKET_MODIFIER_TYPE,
				enabled: true,
			},
		];

		return response;
	};
}

function hasPickPocketSkill(actor) {
	return StandardTestSkillResolver.candidates(
		actor,
		PICK_POCKET_TEST_ID,
	).some(
		(candidate) =>
			candidate.rulesId === PICK_POCKET_SKILL_ID &&
			Number(candidate.acquisitions) > 0,
	);
}

function registerPickPocketResultAdjudication() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const state = message?.getFlag?.(
			FLAG_SCOPE,
			TEST_RESULT_FLAG_KEY,
		);
		const modifierIndex = Array.isArray(state?.otherModifiers)
			? state.otherModifiers.findIndex(
				(modifier) =>
					String(modifier?.type ?? "") ===
					UNSKILLED_PICK_POCKET_MODIFIER_TYPE,
			)
			: -1;

		if (modifierIndex < 0) return;

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		if (!card) return;

		const toggle = card.querySelector(
			`input[data-wfrp-test-modifier-toggle]` +
			`[data-modifier-index="${modifierIndex}"]` +
			`[data-modifier-type="${UNSKILLED_PICK_POCKET_MODIFIER_TYPE}"]`,
		);
		if (!(toggle instanceof HTMLInputElement)) return;

		const canAdjudicate = TestResultChat._canAdjudicate(state);
		if (!canAdjudicate) {
			toggle.disabled = true;
			return;
		}

		toggle.disabled = false;
		toggle.title = localize(
			"Enable or disable the unskilled Pick Pocket penalty for this resolved test.",
			"Włącz lub wyłącz karę za próbę Doliniarstwa bez umiejętności dla tego rozstrzygniętego testu.",
		);
		toggle.addEventListener("change", () => {
			void TestResultChat._updateModifierEnabled(
				message,
				modifierIndex,
				toggle.checked,
				UNSKILLED_PICK_POCKET_MODIFIER_TYPE,
			);
		});
	});
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
