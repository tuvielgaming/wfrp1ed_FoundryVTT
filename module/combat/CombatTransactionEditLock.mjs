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
 * This is both a presentation and an authority boundary. The render pass makes
 * the state obvious by removing all intermediate adjudication affordances, while
 * preUpdateChatMessage and the socket-facing d100 commit guard protect against
 * stale DOM, sockets or programmatic edits.
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
			throw new Error(combatTestLockReason());
		}
		return original.call(this, message, value, requestingUser);
	};

	Object.defineProperty(
		TestResultModifierToggle,
		"__wfrpCombatTransactionLockInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
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
		const input = card.querySelector(selector);
		if (!(input instanceof HTMLInputElement)) continue;
		input.readOnly = true;
		input.tabIndex = -1;
		input.classList.remove("is-editable");
		input.classList.add("is-readonly");
		input.title = reason;
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
