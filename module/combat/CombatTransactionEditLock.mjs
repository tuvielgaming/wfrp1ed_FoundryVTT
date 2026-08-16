import {
	combatTestLockReason,
	isCombatTestAdjudicationLocked,
} from "./CombatTransactionState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_FLAG_KEY = "testResultState";

/**
 * Closed combat transactions are immutable until Damage is explicitly reverted.
 *
 * This is both a presentation and an authority boundary. The render pass makes
 * the state obvious by removing all intermediate adjudication affordances, while
 * preUpdateChatMessage protects against stale DOM, sockets or programmatic edits.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		if (!isCombatTestAdjudicationLocked(message)) return;
		lockRenderedCombatTest(html);
	});

	Hooks.on("preUpdateChatMessage", (message, changes) => {
		if (!testStateChanged(changes)) return;
		if (!isCombatTestAdjudicationLocked(message)) return;
		return false;
	});
});

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
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}
