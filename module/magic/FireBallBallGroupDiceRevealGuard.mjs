const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const CAST_FLAG = "fireBallCast";
const REVEAL_FLAG = "fireBallGroupHitsRevealed";

/**
 * A Fire Ball aggregate is presentation derived from the same group-hit roll as
 * the cast summary. For group casts it must not reveal targets/actions before
 * the physical Level×d3 Dice So Nice batch has finished.
 *
 * The cast message owns the existing reveal flag. Ball cards simply follow it;
 * no additional timing or rule state is introduced here.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const group = message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
	if (!group) return;
	const castMessage = game.messages?.get(String(group.castMessageId ?? ""));
	const cast = castMessage?.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (cast?.group !== true) return;
	if (castMessage?.getFlag?.(FLAG_SCOPE, REVEAL_FLAG)) return;

	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const entry = root.closest?.("[data-message-id], .chat-message, li.message, li.chat-message") ?? root;
	if (!(entry instanceof HTMLElement)) return;
	entry.dataset.wfrpFireBallPendingGroupHits = "";
	entry.style.display = "none";
	entry.setAttribute("aria-hidden", "true");
});

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
