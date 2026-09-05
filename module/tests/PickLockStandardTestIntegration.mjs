import "./PickPocketStandardTestIntegration.mjs";
import "./StandardTestPendingTargetCanvasIntegration.mjs";
import "./StandardTestResultMetadataIntegration.mjs";
import "./StandardTestRuleReminderIntegration.mjs";
import "./StandardTestTargetIntegration.mjs";
import "./TargetResistanceStandardTestIntegration.mjs";
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
 * integration adds only the missing unskilled rule. The DialogV2 validation
 * guard first verified for Lock Rating is also shared here by every required
 * numeric Standard Test context field, so ordinary incomplete user input is
 * handled inside the dialog instead of escaping as a rejected Promise.
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
		activateRequiredContextValidation.call(this, dialog, entries);
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

function activateRequiredContextValidation(dialog, entries) {
	const root = dialog?.element;
	const body = root?.querySelector?.(".standard-test-dialog-body");
	const select = root?.querySelector?.('select[name="testId"]');
	const rollButton = root?.querySelector?.('button[data-action="roll"]');
	const form = rollButton?.form ?? root?.querySelector?.("form");

	if (
		!(body instanceof HTMLElement) ||
		!(select instanceof HTMLSelectElement)
	) {
		return;
	}

	const fieldDefinitions = [
		{
			tag: "requires-noise-level",
			name: "noise",
			englishLabel: "Base Listen chance",
			polishLabel: "Bazowa szansa Słuchania",
			positive: false,
		},
		{
			tag: "requires-lock-rating",
			name: "lockDifficulty",
			englishLabel: "Lock Rating",
			polishLabel: "Stopień trudności zamka",
			positive: false,
		},
		{
			tag: "requires-jump-height",
			name: "jumpHeight",
			englishLabel: "Jump height",
			polishLabel: "Wysokość zeskoku",
			positive: true,
		},
		{
			tag: "requires-leap-gap",
			name: "leapGap",
			englishLabel: "Gap to clear",
			polishLabel: "Dystans do pokonania",
			positive: true,
		},
	]
		.map((definition) => ({
			...definition,
			input: root?.querySelector?.(`input[name="${definition.name}"]`),
		}))
		.filter((definition) => definition.input instanceof HTMLInputElement);

	const warning = document.createElement("div");
	warning.classList.add("standard-test-context-value");
	warning.dataset.standardValidationWarning = "";
	warning.setAttribute("role", "alert");
	warning.setAttribute("aria-live", "polite");
	warning.hidden = true;
	body.prepend(warning);

	const currentEntry = () =>
		entries.find((entry) => entry.id === select.value);

	const validationIssue = () => {
		const entry = currentEntry();
		const tags = entry?.tags ?? [];

		for (const field of fieldDefinitions) {
			if (!tags.includes(field.tag)) continue;

			const raw = String(field.input.value ?? "").trim();
			const label = localize(field.englishLabel, field.polishLabel);

			if (!raw) {
				return {
					input: field.input,
					message: localize(
						`Enter ${field.englishLabel} before rolling.`,
						`Uzupełnij pole „${field.polishLabel}” przed rzutem.`,
					),
				};
			}

			const value = Number(raw);
			if (!Number.isFinite(value)) {
				return {
					input: field.input,
					message: localize(
						`Enter a valid numeric value for ${field.englishLabel} before rolling.`,
						`Wprowadź prawidłową liczbę w polu „${field.polishLabel}” przed rzutem.`,
					),
				};
			}

			if (field.positive && value <= 0) {
				return {
					input: field.input,
					message: localize(
						`${field.englishLabel} must be greater than zero.`,
						`Pole „${field.polishLabel}” musi mieć wartość większą od zera.`,
					),
				};
			}

			field.input.removeAttribute("aria-invalid");
		}

		return null;
	};

	const clearWarning = () => {
		warning.hidden = true;
		warning.textContent = "";

		for (const field of fieldDefinitions) {
			field.input.removeAttribute("aria-invalid");
		}
	};

	const showWarning = (issue) => {
		clearWarning();
		warning.textContent = issue.message;
		warning.hidden = false;
		issue.input.setAttribute("aria-invalid", "true");
		issue.input.focus();
	};

	const guardSubmission = (event) => {
		const issue = validationIssue();
		if (!issue) {
			clearWarning();
			return true;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		showWarning(issue);
		return false;
	};

	/*
	 * DialogV2 routes action-button clicks through its own submit handler. The
	 * capture listener stops an invalid Roll before that handler reaches the
	 * existing _readForm validation, so ordinary missing input never becomes an
	 * uncaught Promise rejection. The form/keyboard guards cover alternate
	 * submission paths without changing the defensive validation in _readForm.
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

	for (const field of fieldDefinitions) {
		field.input.addEventListener("input", () => {
			field.input.removeAttribute("aria-invalid");
			if (!validationIssue()) clearWarning();
		});
	}
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