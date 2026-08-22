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
 * Closed combat transactions are mechanically immutable until Damage is
 * explicitly reverted.
 *
 * Presentation metadata is not mechanical adjudication. In particular, the GM
 * may still change only `testResultState.resultVisibility` after damage has been
 * applied, using the same share/restrict context action available before the
 * transaction closed. Roll, target, modifiers and all other test state remain
 * protected by this guard.
 */
Hooks.once("init", () => {
	installRollCommitGuard();

	Hooks.on("renderChatMessageHTML", (message, html) => {
		applyRenderedLockState(message, html);
		queueMicrotask(() => applyRenderedLockState(message, html));
	});

	Hooks.on("preUpdateChatMessage", (message, changes) => {
		if (!testStateChanged(changes)) return;
		if (!isCombatTestAdjudicationLocked(message)) return;
		if (isVisibilityOnlyTestStateUpdate(message, changes)) return;
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
			/* Stale DOM/socket request: preserve the authoritative roll silently. */
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

/**
 * Allow exactly the existing GM visibility toggle on a closed Test card.
 * TestResultChat writes a complete snapshot even when only visibility changes,
 * so compare the incoming snapshot with the stored one after removing the three
 * presentation/audit fields which that operation is allowed to update.
 */
function isVisibilityOnlyTestStateUpdate(message, changes) {
	if (!game.user?.isGM) return false;

	const current = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	const incoming = changedTestState(changes, current);
	if (!plainObject(current) || !plainObject(incoming)) return false;
	if (String(incoming.resultVisibility ?? "") === String(current.resultVisibility ?? "")) {
		return false;
	}

	return stableState(mechanicalTestState(current)) ===
		stableState(mechanicalTestState(incoming));
}

function changedTestState(changes, current) {
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	const nested = foundry.utils.getProperty?.(changes, path);
	if (plainObject(nested)) return nested;
	if (plainObject(changes?.flags?.[FLAG_SCOPE]?.[TEST_FLAG_KEY])) {
		return changes.flags[FLAG_SCOPE][TEST_FLAG_KEY];
	}
	if (plainObject(changes?.[path])) return changes[path];

	/* Also accept Foundry's flattened leaf-update form if the visibility helper is
	 * ever simplified to update only individual paths in the future. */
	const visibilityPath = `${path}.resultVisibility`;
	if (Object.hasOwn(changes ?? {}, visibilityPath) && plainObject(current)) {
		const copy = foundry.utils.deepClone(current);
		copy.resultVisibility = changes[visibilityPath];
		const byPath = `${path}.updatedBy`;
		const atPath = `${path}.updatedAt`;
		if (Object.hasOwn(changes, byPath)) copy.updatedBy = changes[byPath];
		if (Object.hasOwn(changes, atPath)) copy.updatedAt = changes[atPath];
		return copy;
	}
	return null;
}

function mechanicalTestState(state) {
	const copy = foundry.utils.deepClone(state ?? {});
	delete copy.resultVisibility;
	delete copy.updatedBy;
	delete copy.updatedAt;
	return copy;
}

function stableState(value) {
	try {
		return JSON.stringify(value ?? null);
	} catch (_error) {
		return "";
	}
}

function plainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
		for (const entry of visibleMessageElements(message.id)) {
			callback(entry, message);
		}
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

function visibleMessageElements(messageId) {
	const id = String(messageId ?? "");
	if (!id) return [];
	const escaped = globalThis.CSS?.escape
		? CSS.escape(id)
		: id.replaceAll('"', '\\"');
	return [...document.querySelectorAll(`[data-message-id="${escaped}"]`)];
}

function testStateChanged(changes) {
	return flagChanged(changes, TEST_FLAG_KEY);
}

function flagChanged(changes, key) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${key}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined ||
		Object.keys(changes).some((entry) => String(entry).startsWith(`${path}.`));
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
