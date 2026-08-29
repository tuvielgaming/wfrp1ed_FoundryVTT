const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const CAST_FLAG = "fireBallCast";
const REVEAL_FLAG = "fireBallGroupHitsRevealed";

/**
 * Group-hit target selection is not public until its Dice So Nice batch ends.
 * While that animation is pending, hide both the cast-derived Ball aggregates
 * and the canonical per-target impacts. After reveal, Ball aggregates are shown;
 * canonical impacts are left to FireBallPresentationConsistency, which hides
 * them once an aggregate owns them.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const group = message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!group && !impact) return;

	const castId = String(group?.castId ?? impact?.castId ?? "").trim();
	if (!castId) return;
	const castMessage = castMessageForId(castId);
	const cast = castMessage?.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (cast?.group !== true) return;

	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const entry = root.closest?.("[data-message-id], .chat-message, li.message, li.chat-message") ?? root;
	if (!(entry instanceof HTMLElement)) return;

	const revealed = Boolean(castMessage?.getFlag?.(FLAG_SCOPE, REVEAL_FLAG));
	if (!revealed) {
		hideEntry(entry);
		return;
	}

	/* Aggregate cards are safe to reveal now. Canonical impact cards intentionally
	 * remain untouched here: the normal grouping presentation decides whether a
	 * represented impact stays hidden or must remain visible as a safety fallback. */
	if (group) showEntry(entry);
});

function castMessageForId(castId) {
	for (const message of game.messages ?? []) {
		const cast = message.getFlag?.(FLAG_SCOPE, CAST_FLAG);
		if (String(cast?.castId ?? "") === String(castId)) return message;
	}
	return null;
}

function hideEntry(entry) {
	entry.dataset.wfrpFireBallPendingGroupHits = "";
	entry.style.display = "none";
	entry.setAttribute("aria-hidden", "true");
}

function showEntry(entry) {
	delete entry.dataset.wfrpFireBallPendingGroupHits;
	entry.style.removeProperty("display");
	entry.removeAttribute("aria-hidden");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
