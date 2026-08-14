import "./CombatAttackSheetStatus.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatAttackRangeRules } from "./CombatAttackRangeRules.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";
import { CombatDefenceResultChat } from "./CombatDefenceResultChat.mjs";
import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";
import { PendingCombatAttack } from "./PendingCombatAttack.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";

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
	 * next animation frame lets Foundry mount the exact same element first.
	 *
	 * Defence data itself belongs only to the GM and OWNER(s) of the defending
	 * Actor. Other viewers still receive the compact attack identity/result card,
	 * but the defence transaction is never rendered for them.
	 */
	requestAnimationFrame(() => {
		void activateDefenceForViewer(message, html);
	});
});

Hooks.on("updateChatMessage", (message, changes) => {
	CombatDefenceTransaction.onChatMessageUpdate(message, changes);
});

async function activateDefenceForViewer(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (!attack || attack.targetMode !== "defender") return;

	const defender = await defenderFromAttack(attack);
	if (!defender) return;
	if (!game.user?.isGM) {
		const ownsDefender = defender.testUserPermission?.(
			game.user,
			CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
		) === true;
		if (!ownsDefender) return;
	}

	CombatDefenceTransaction.activateListeners(message, html);
}

async function defenderFromAttack(attack) {
	const uuid = String(attack?.target?.uuid ?? "").trim();
	if (!uuid || typeof globalThis.fromUuid !== "function") return null;

	try {
		const document = await globalThis.fromUuid(uuid);
		if (document?.documentName === "Actor") return document;
		if (document?.actor?.documentName === "Actor") return document.actor;
		return null;
	} catch (_error) {
		return null;
	}
}
