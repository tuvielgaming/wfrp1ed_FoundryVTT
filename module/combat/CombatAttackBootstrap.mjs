import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatAttackRangeRules } from "./CombatAttackRangeRules.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";
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
			pendingAttack: PendingCombatAttack,
		}),
	});
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	PendingCombatAttack.activateListeners(message, html);
	CombatAttackResultChat.activateListeners(message, html);
});
