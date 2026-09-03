import { StandardTestDialog } from "./StandardTestDialog.mjs";
import { StandardTestSkillResolver } from "./StandardTestSkillResolver.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

const PICK_LOCK_TEST_ID = "pickLock";
const PICK_LOCK_SKILL_ID = "pickLock";
const UNSKILLED_PICK_LOCK_MODIFIER = -30;
const UNSKILLED_PICK_LOCK_MODIFIER_TYPE = "pick-lock-unskilled";
const FLAG_SCOPE = "wfrp1ed";
const TEST_RESULT_FLAG_KEY = "testResultState";

/*
 * WFRP 1e Pick Lock rules which are specific to the absence of the Skill.
 *
 * Mechanics authority:
 * - English Core Rulebook, Pick Lock Skill, printed p.54: each acquisition
 *   after the first gives +10%.
 * - English Core Rulebook, Standard Tests — Pick Lock, printed pp.70-71:
 *   target = Dexterity minus Lock Rating; a skilled character may make up to
 *   three unsuccessful attempts at the same lock; a character without Pick
 *   Lock gets one attempt at that lock with a -30% penalty.
 *
 * The existing Standard Test definition and Skill resolver already own the
 * Dexterity-minus-Lock-Rating formula and repeated-acquisition bonuses. This
 * integration adds only the missing unskilled rule and user-facing validation.
 *
 * The current Standard Test context has a numeric Lock Rating but no stable
 * identity for the physical lock. Therefore the one-attempt limit is surfaced
 * explicitly in the result chat instead of pretending to persist a reliable
 * per-lock attempt counter.
 */
installPickLockDialogRules();
registerPickLockResultPresentation();

function installPickLockDialogRules() {
	if (StandardTestDialog.__wfrpPickLockRulesInstalled === true) return;

	Object.defineProperty(StandardTestDialog, "__wfrpPickLockRulesInstalled", {
		value: true,
		configurable: false,
	});

	const originalActivateDialog = StandardTestDialog._activateDialog;
	const originalReadForm = StandardTestDialog._readForm;

	StandardTestDialog._activateDialog = function (dialog, actor, entries) {
		originalActivateDialog.call(this, dialog, actor, entries);
		activateLockRatingValidation.call(this, dialog, entries);
	};

	StandardTestDialog._readForm = function (actor, form, entries) {
		const response = originalReadForm.call(this, actor, form, entries);

		if (
			response?.kind !== "test" ||
			response.testId !== PICK_LOCK_TEST_ID ||
			hasPickLockSkill(actor)
		) {
			return response;
		}

		response.options.modifiers = [
			...(response.options.modifiers ?? []),
			{
				id: "pick-lock-unskilled-penalty",
				value: UNSKILLED_PICK_LOCK_MODIFIER,
				source: localize(
					"No Pick Lock skill",
					"Brak umiejętności Otwieranie zamków",
				),
				type: UNSKILLED_PICK_LOCK_MODIFIER_TYPE,
				enabled: true,
			},
		];

		return response;
	};
}

function activateLockRatingValidation(dialog, entries) {
	const root = dialog?.element;
	const body = root?.querySelector?.(".standard-test-dialog-body");
	const select = root?.querySelector?.('select[name="testId"]');
	const lockInput = root?.querySelector?.('input[name="lockDifficulty"]');
	const rollButton = root?.querySelector?.('button[data-action="roll"]');
	const form = rollButton?.form ?? root?.querySelector?.("form");

	if (
		!(body instanceof HTMLElement) ||
		!(select instanceof HTMLSelectElement) ||
		!(lockInput instanceof HTMLInputElement)
	) {
		return;
	}

	const warning = document.createElement("div");
	warning.classList.add("standard-test-context-value");
	warning.dataset.standardValidationWarning = "";
	warning.setAttribute("role", "alert");
	warning.hidden = true;
	body.prepend(warning);

	const currentEntry = () =>
		entries.find((entry) => entry.id === select.value);

	const validationMessage = () => {
		const entry = currentEntry();
		if (!entry?.tags?.includes("requires-lock-rating")) return "";

		const raw = String(lockInput.value ?? "").trim();
		if (!raw) {
			return localize(
				"Enter the Lock Rating before rolling.",
				"Wprowadź Stopień trudności zamka przed rzutem.",
			);
		}

		if (!Number.isFinite(Number(raw))) {
			return localize(
				"Enter a valid numeric Lock Rating before rolling.",
				"Wprowadź prawidłowy liczbowy Stopień trudności zamka przed rzutem.",
			);
		}

		return "";
	};

	const clearWarning = () => {
		warning.hidden = true;
		warning.textContent = "";
		lockInput.removeAttribute("aria-invalid");
	};

	const showWarning = (message) => {
		warning.textContent = message;
		warning.hidden = false;
		lockInput.setAttribute("aria-invalid", "true");
		lockInput.focus();
	};

	const guardSubmission = (event) => {
		const message = validationMessage();
		if (!message) {
			clearWarning();
			return true;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		showWarning(message);
		return false;
	};

	/*
	 * DialogV2 routes action-button clicks through its own submit handler. The
	 * capture listener stops an invalid Roll before that handler reaches the
	 * existing _readForm validation, so ordinary missing input never becomes an
	 * uncaught Promise rejection. The form listener also covers native submits.
	 */
	rollButton?.addEventListener("click", guardSubmission, true);
	form?.addEventListener("submit", guardSubmission, true);

	root.addEventListener(
		"keydown",
		(event) => {
			if (event.key === "Enter") {
				guardSubmission(event);
			}
		},
		true,
	);

	select.addEventListener("change", clearWarning);
	lockInput.addEventListener("input", () => {
		if (!validationMessage()) clearWarning();
	});
}

function hasPickLockSkill(actor) {
	return StandardTestSkillResolver.candidates(
		actor,
		PICK_LOCK_TEST_ID,
	).some(
		(candidate) =>
			candidate.rulesId === PICK_LOCK_SKILL_ID &&
			Number(candidate.acquisitions) > 0,
	);
}

function registerPickLockResultPresentation() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const state = message?.getFlag?.(
			FLAG_SCOPE,
			TEST_RESULT_FLAG_KEY,
		);
		const modifierIndex = Array.isArray(state?.otherModifiers)
			? state.otherModifiers.findIndex(
				(modifier) =>
					String(modifier?.type ?? "") ===
					UNSKILLED_PICK_LOCK_MODIFIER_TYPE,
			)
			: -1;

		if (modifierIndex < 0) return;

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		if (!card) return;

		activateUnskilledPenaltyToggle(
			message,
			state,
			card,
			modifierIndex,
		);
		renderUnskilledAttemptNotice(card);
	});
}

function activateUnskilledPenaltyToggle(message, state, card, modifierIndex) {
	const toggle = card.querySelector(
		`input[data-wfrp-test-modifier-toggle]` +
		`[data-modifier-index="${modifierIndex}"]` +
		`[data-modifier-type="${UNSKILLED_PICK_LOCK_MODIFIER_TYPE}"]`,
	);
	if (!(toggle instanceof HTMLInputElement)) return;

	const canAdjudicate = TestResultChat._canAdjudicate(state);
	if (!canAdjudicate) {
		toggle.disabled = true;
		return;
	}

	toggle.disabled = false;
	toggle.title = localize(
		"Enable or disable the unskilled Pick Lock penalty for this resolved test.",
		"Włącz lub wyłącz karę za próbę Otwierania zamków bez umiejętności dla tego rozstrzygniętego testu.",
	);

	toggle.addEventListener("change", () => {
		void TestResultChat._updateModifierEnabled(
			message,
			modifierIndex,
			toggle.checked,
			UNSKILLED_PICK_LOCK_MODIFIER_TYPE,
		);
	});
}

function renderUnskilledAttemptNotice(card) {
	if (card.querySelector("[data-wfrp-pick-lock-unskilled-notice]")) {
		return;
	}

	const header = card.querySelector(".wfrp1e-test-card__header");
	if (!header) return;

	const notice = document.createElement("div");
	notice.classList.add("wfrp1e-test-card__breakdown");
	notice.dataset.wfrpPickLockUnskilledNotice = "";
	notice.setAttribute("role", "note");

	const text = document.createElement("strong");
	text.textContent = localize(
		"Unskilled Pick Lock attempt: -30%. Only one attempt is allowed at this lock.",
		"Próba otwarcia zamka bez umiejętności: -30%. Przy tym zamku dozwolona jest tylko jedna próba.",
	);
	notice.append(text);
	header.insertAdjacentElement("afterend", notice);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
