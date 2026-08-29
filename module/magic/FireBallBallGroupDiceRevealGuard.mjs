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
 *
 * Important: Foundry may reuse an existing ChatMessage DOM node during a forced
 * chat render. Therefore this guard must actively remove its own hidden state
 * once the cast is revealed; merely returning when the reveal flag exists can
 * leave a previously-hidden aggregate permanently invisible.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const group = message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
	if (!group) return;

	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const entry = root.closest?.("[data-message-id], .chat-message, li.message, li.chat-message") ?? root;
	if (!(entry instanceof HTMLElement)) return;

	const castMessage = castMessageForGroup(group);
	const cast = castMessage?.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (cast?.group !== true) {
		show(entry);
		return;
	}

	if (castMessage?.getFlag?.(FLAG_SCOPE, REVEAL_FLAG)) {
		show(entry);
		return;
	}

	hide(entry);
});

function castMessageForGroup(group) {
	const directId = String(group?.castMessageId ?? "").trim();
	if (directId) {
		const direct = game.messages?.get(directId);
		if (direct) return direct;
	}

	/* castMessageId can lag castId by one linkage pass. The castId itself is the
	 * authoritative transaction key, so use it as an exact fallback rather than
	 * leaving the aggregate outside the dice-first gate. */
	const castId = String(group?.castId ?? "").trim();
	if (!castId) return null;
	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, CAST_FLAG);
		if (String(state?.castId ?? "") === castId) return message;
	}
	return null;
}

function hide(entry) {
	entry.dataset.wfrpFireBallPendingGroupHits = "";
	entry.style.display = "none";
	entry.setAttribute("aria-hidden", "true");
}

function show(entry) {
	delete entry.dataset.wfrpFireBallPendingGroupHits;
	entry.style.removeProperty("display");
	entry.removeAttribute("aria-hidden");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
