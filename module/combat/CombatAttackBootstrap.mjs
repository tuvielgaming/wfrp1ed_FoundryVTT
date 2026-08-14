import "./CombatAttackSheetStatus.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatAttackRangeRules } from "./CombatAttackRangeRules.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";
import { CombatDefenceResultChat } from "./CombatDefenceResultChat.mjs";
import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";
import { PendingCombatAttack } from "./PendingCombatAttack.mjs";

Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED combat attacks require the core system API to initialize first.",
		);
	}

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		combat: Object.freeze({
			...(game.WFRP1ED.combat ?? {}),
			attack: CombatAttackLauncher,
			attackRangeRules: CombatAttackRangeRules,
			attackResultChat: CombatAttackResultChat,
			defenceTransaction: CombatDefenceTransaction,
			pendingAttack: PendingCombatAttack,
		}),
	});
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	PendingCombatAttack.activateListeners(message, html);
	CombatAttackResultChat.activateListeners(message, html);
	CombatDefenceResultChat.activateListeners(message, html);

	/*
	 * CombatAttackResultChat adds its context synchronously during this render
	 * hook, but CombatDefenceTransaction resolves the target Actor asynchronously
	 * and intentionally verifies that the attack panel is mounted before adding
	 * interactive defence controls. Foundry may still be rendering a detached
	 * ChatMessage element while this hook itself is running. Waiting until the
	 * next animation frame lets Foundry mount the exact same element first, then
	 * decorates it without racing the ChatLog render lifecycle.
	 */
	requestAnimationFrame(() => {
		CombatDefenceTransaction.activateListeners(message, html);
	});
});

Hooks.on("updateChatMessage", (message, changes) => {
	CombatDefenceTransaction.onChatMessageUpdate(message, changes);
});
