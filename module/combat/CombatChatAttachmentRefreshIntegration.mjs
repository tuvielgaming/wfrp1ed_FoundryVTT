import { refreshVisibleChatMessage } from "../chat/ChatMessagePresentationRefresh.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";
import { CombatDefenceResultChat } from "./CombatDefenceResultChat.mjs";

const INSTALL_MARKER = Symbol.for("wfrp1ed.combatChatAttachmentRefresh");

/**
 * Ensure combat-specific state layered onto an already-published generic Test
 * ChatMessage is reflected immediately in the visible ChatLog DOM.
 *
 * TestResultChat publishes the persistent message before CombatAttackResultChat
 * or CombatDefenceResultChat attaches its additional flag. Foundry does not
 * guarantee another render for a flag-only update, while our combat panels are
 * intentionally added by renderChatMessageHTML. Wrap the two attachment points
 * once and refresh only the already-rendered sidebar message afterwards.
 */
if (!globalThis[INSTALL_MARKER]) {
	globalThis[INSTALL_MARKER] = true;
	wrapAttachment(CombatAttackResultChat);
	wrapAttachment(CombatDefenceResultChat);
}

function wrapAttachment(controller) {
	const original = controller?.attach;
	if (typeof original !== "function") return;

	controller.attach = async function(message, state) {
		const result = await original.call(this, message, state);
		try {
			await refreshVisibleChatMessage(message);
		} catch (error) {
			/* Mechanical persistence is already complete. Presentation refresh must
			 * never invalidate the attack/defence transaction itself. */
			console.warn(
				"WFRP1ED | Unable to refresh layered combat ChatMessage presentation.",
				error,
			);
		}
		return result;
	};
}
