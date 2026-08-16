import { TestResultModifierToggle } from "../tests/TestResultModifierToggle.mjs";
import {
	combatAttackSourceForTest,
	combatTestLockReason,
	isCombatTestAdjudicationLocked,
} from "./CombatTransactionState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DAMAGE_FLAG_KEY = "damageState";
const LOCK_MARKER = "wfrpTransactionLocked";
const PREVIOUS_READONLY = "wfrpTransactionPreviousReadonly";
const PREVIOUS_DISABLED = "wfrpTransactionPreviousDisabled";
const PREVIOUS_TITLE = "wfrpTransactionPreviousTitle";
let chatRefreshQueued = false;

/**
 * Closed combat transactions are immutable until Damage is explicitly reverted.
 *
 * Apply Damage is the closing boundary for positive damage. Once the target
 * Actor records that application, Attack/Defence/Additional-Damage Test inputs
 * become visibly read-only on every client. Damage invalidation reopens the
 * transaction and restores the exact interactive state those controls had before
 * the transaction was closed.
 *
 * The authority guard remains as a fallback for a stale DOM/socket request, but
 * normal users should never be able to type into a closed Test input at all.
 */
Hooks.once("init", () => {
	installRollCommitGuard();

	Hooks.on("renderChatMessageHTML", (message, html) => {
		applyRenderedLockState(message, html);

		/*
		 * Several Test presentation hooks decorate the same card. Re-check once
		 * after the current render stack has finished so no later decorator can
		 * accidentally turn a closed roll input editable again.
		 */
		queueMicrotask(() => applyRenderedLockState(message, html));
	});

	Hooks.on("preUpdateChatMessage", (message, changes) => {
		if (!testStateChanged(changes)) return;
		if (!isCombatTestAdjudicationLocked(message)) return;
		return false;
	});

	/*
	 * The authoritative damage application is mirrored into the source Attack
	 * ChatMessage. Synchronize already-rendered linked Test cards immediately
	 * instead of relying only on ChatLog deciding to reconstruct older history.
	 */
	Hooks.on("updateChatMessage", (message, changes) => {
		if (!message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return;
		if (!flagChanged(changes, DAMAGE_FLAG_KEY)) return;

		if (isCombatTestAdjudicationLocked(message)) {
			lockVisibleCombatFamily(message);
		} else {
			unlockVisibleCombatFamily(message);
		}
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
			 * This should only be reachable from a stale DOM/socket request. Preserve
			 * the authoritative roll, repaint the cards, and do not surface an error.
			 */
			lockVisibleCombatFamily(combatAttackSourceForTest(message));
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

function applyRenderedLockState(message, html) {
	if (!isCombatTestAdjudicationLocked(message)) return;
	lockRenderedCombatTest(html);
}

function lockVisibleCombatFamily(sourceMessage) {
	forEachVisibleCombatTest(sourceMessage, (entry) => {
		lockRenderedCombatTest(entry);
	});
}

function unlockVisibleCombatFamily(sourceMessage) {
	forEachVisibleCombatTest(sourceMessage, (entry) => {
		unlockRenderedCombatTest(entry);
	});
}

function forEachVisibleCombatTest(sourceMessage, callback) {
	if (!sourceMessage?.id || typeof callback !== "function") return;
	const sourceId = String(sourceMessage.id);

	for (const message of game.messages ?? []) {
		if (!message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY)) continue;
		if (combatAttackSourceForTest(message)?.id !== sourceId) continue;
		const entry = visibleMessageElement(message.id);
		if (entry) callback(entry, message);
	}
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
			rememberInputState(input);
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
			rememberInputState(input);
			input.disabled = true;
			input.tabIndex = -1;
			input.classList.remove("is-editable");
			input.classList.add("is-readonly");
			input.title = reason;
		}
	}
}

function unlockRenderedCombatTest(html) {
	const root = asElement(html);
	if (!root) return;

	const card = root.matches?.(".wfrp1e-test-card")
		? root
		: root.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	card.classList.remove("is-combat-transaction-locked");
	for (const input of card.querySelectorAll(`input[data-${datasetAttribute(LOCK_MARKER)}]`)) {
		if (!(input instanceof HTMLInputElement)) continue;
		restoreInputState(input);
	}
}

function rememberInputState(input) {
	if (input.dataset[LOCK_MARKER] === "true") return;
	input.dataset[LOCK_MARKER] = "true";
	input.dataset[PREVIOUS_READONLY] = input.readOnly ? "true" : "false";
	input.dataset[PREVIOUS_DISABLED] = input.disabled ? "true" : "false";
	input.dataset[PREVIOUS_TITLE] = String(input.title ?? "");
}

function restoreInputState(input) {
	const wasReadOnly = input.dataset[PREVIOUS_READONLY] === "true";
	const wasDisabled = input.dataset[PREVIOUS_DISABLED] === "true";
	const previousTitle = String(input.dataset[PREVIOUS_TITLE] ?? "");

	input.readOnly = wasReadOnly;
	input.disabled = wasDisabled;
	input.removeAttribute("aria-readonly");
	input.tabIndex = wasReadOnly || wasDisabled ? -1 : 0;
	input.classList.toggle("is-editable", !wasReadOnly && !wasDisabled);
	input.classList.toggle("is-readonly", wasReadOnly || wasDisabled);
	input.title = previousTitle;

	delete input.dataset[LOCK_MARKER];
	delete input.dataset[PREVIOUS_READONLY];
	delete input.dataset[PREVIOUS_DISABLED];
	delete input.dataset[PREVIOUS_TITLE];
}

function datasetAttribute(datasetKey) {
	return datasetKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function visibleMessageElement(messageId) {
	const id = String(messageId ?? "");
	if (!id) return null;
	const escaped = globalThis.CSS?.escape
		? CSS.escape(id)
		: id.replaceAll('"', '\\"');
	return document.querySelector(`[data-message-id="${escaped}"]`);
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
