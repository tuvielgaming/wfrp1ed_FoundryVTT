import { TestResultModifierToggle } from "../tests/TestResultModifierToggle.mjs";
import {
	combatTestLockReason,
	isCombatTestAdjudicationLocked,
} from "./CombatTransactionState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DAMAGE_FLAG_KEY = "damageState";
let chatRefreshQueued = false;

/**
 * Closed combat transactions are immutable until Damage is explicitly reverted.
 *
 * The normal UX is visual rather than notification-driven: when Apply Damage
 * closes the transaction, Attack/Defence/Additional-Damage cards rerender with
 * their adjudication inputs read-only. Authority guards remain as a defensive
 * fallback for stale DOM/socket requests, but a stale edit is treated as a
 * harmless no-op and the Chat is refreshed instead of showing an error toast.
 */
Hooks.once("init", () => {
	installRollCommitGuard();

	Hooks.on("renderChatMessageHTML", (message, html) => {
		if (!isCombatTestAdjudicationLocked(message)) return;
		lockRenderedCombatTest(html);
	});

	Hooks.on("preUpdateChatMessage", (message, changes) => {
		if (!testStateChanged(changes)) return;
		if (!isCombatTestAdjudicationLocked(message)) return;
		return false;
	});

	/*
	 * Damage state lives on the source Attack message while the Parry and
	 * Additional Damage Tests are separate older ChatMessages. Re-render Chat on
	 * every client when that boundary changes so all related cards lock/unlock in
	 * the same frame rather than leaving a stale editable Parry card behind.
	 */
	Hooks.on("updateChatMessage", (message, changes) => {
		if (!message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return;
		if (!flagChanged(changes, DAMAGE_FLAG_KEY)) return;
		requestChatRefresh();
	});
});

function installRollCommitGuard() {
	if (TestResultModifierToggle.__wfrpCombatTransactionLockInstalled === true) {
		return;
	}

	const original = TestResultModifierToggle.commitRollValue;
	TestResultModifierToggle.commitRollValue = async function lockedCombatRollCommit(
		message,
		value,
		requestingUser,
	) {
		if (isCombatTestAdjudicationLocked(message)) {
			/*
			 * A correctly rerendered card is already read-only, so this branch is
			 * only for a stale DOM/socket race. Do not turn that implementation race
			 * into a user-facing warning: restore the authoritative presentation and
			 * return the unchanged snapshot.
			 */
			requestChatRefresh();
			return closedRollSnapshot(message);
		}
		return original.call(this, message, value, requestingUser);
	};

	Object.defineProperty(
		TestResultModifierToggle,
		"__wfrpCombatTransactionLockInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function closedRollSnapshot(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY) ?? {};
	const roll = Number(state.roll);
	const originalRoll = Number(state.originalRoll ?? state.roll);
	return Object.freeze({
		messageId: String(message?.id ?? ""),
		roll: Number.isFinite(roll) ? roll : null,
		originalRoll: Number.isFinite(originalRoll) ? originalRoll : null,
		rollEdited: state.rollEdited === true,
		locked: true,
	});
}

function lockRenderedCombatTest(html) {
	const root = asElement(html);
	if (!root) return;

	const card = root.matches?.(".wfrp1e-test-card")
		? root
		: root.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	card.classList.add("is-combat-transaction-locked");
	const reason = combatTestLockReason();

	for (const selector of [
		"[data-wfrp-test-roll-value]",
		"[data-wfrp-test-general-modifier]",
	]) {
		for (const input of card.querySelectorAll(selector)) {
			if (!(input instanceof HTMLInputElement)) continue;
			input.readOnly = true;
			input.setAttribute("aria-readonly", "true");
			input.tabIndex = -1;
			input.classList.remove("is-editable");
			input.classList.add("is-readonly");
			input.title = reason;
		}
	}

	for (const selector of [
		"[data-wfrp-test-modifier-toggle]",
		"[data-attack-range-automatic]",
		"[data-attack-range-distance]",
		"[data-attack-range-manual-damage]",
	]) {
		for (const input of card.querySelectorAll(selector)) {
			if (!(input instanceof HTMLInputElement)) continue;
			input.disabled = true;
			input.tabIndex = -1;
			input.classList.remove("is-editable");
			input.classList.add("is-readonly");
			input.title = reason;
		}
	}
}

function testStateChanged(changes) {
	return flagChanged(changes, TEST_FLAG_KEY);
}

function flagChanged(changes, key) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${key}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function requestChatRefresh() {
	if (chatRefreshQueued) return;
	chatRefreshQueued = true;
	requestAnimationFrame(() => {
		chatRefreshQueued = false;
		void ui.chat?.render?.({ force: true });
	});
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}
