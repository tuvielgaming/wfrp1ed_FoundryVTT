/*
 * Keep the ordinary "follow new chat" behaviour, but distinguish a genuinely
 * new local roll/result from a full ChatLog re-render. Fire Ball grouping does
 * several forced renders while resolving one action; those renders can leave
 * Foundry's isAtBottom flag false even though the user has just clicked a roll.
 *
 * IMPORTANT: never drive ChatLog scrolling while the Chat UI is hidden behind a
 * different sidebar tab. Foundry can present a newly-created persistent
 * ChatMessage as a temporary off-tab preview. Calling scrollBottom({popout:true})
 * against that hidden/virtualized ChatLog can desynchronize its rendered history
 * from game.messages. We therefore touch bottom-follow state only when the real
 * ChatLog is currently visible.
 */
Hooks.on("renderChatMessageHTML", (message) => {
	if (!message?.id) return;
	const chat = ui.chat;
	if (!chat?.scrollBottom || !isChatVisible(chat)) return;
	if (chat.isAtBottom === false) return;
	scheduleBottomFollow(String(message.id));
});

Hooks.on("createChatMessage", (message) => {
	if (!message?.id) return;
	const chat = ui.chat;
	if (!chat?.scrollBottom || !isChatVisible(chat)) return;

	/* A Test/Damage card produced by this client is part of the action the user
	 * just requested, so reveal it even if an intermediate forced chat render made
	 * Foundry think the viewport was no longer at the bottom. Remote messages still
	 * respect the user's decision to browse older chat history. */
	if (chat.isAtBottom === false && !authoredByCurrentUser(message)) return;
	scheduleBottomFollow(String(message.id));
});

function authoredByCurrentUser(message) {
	const authorId = String(
		message?.author?.id ??
		message?.user?.id ??
		message?.user ??
		message?._source?.user ??
		"",
	);
	return Boolean(authorId) && authorId === String(game.user?.id ?? "");
}

function scheduleBottomFollow(messageId) {
	queueMicrotask(() => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => void scrollChatBottom(messageId));
		});
	});

	/* Some WFRP chat decorators add controls after the first layout pass. */
	setTimeout(() => void scrollChatBottom(messageId), 120);
}

async function scrollChatBottom(messageId) {
	const chat = ui.chat;
	if (!chat?.scrollBottom || !isChatVisible(chat)) return;

	try {
		await chat.scrollBottom({
			popout: true,
			waitImages: true,
			scrollOptions: {
				behavior: "instant",
				block: "end",
			},
		});

		/* scrollBottom() moves the viewport, but late WFRP card growth can leave
		 * Foundry's private `isAtBottom` / Jump-to-Bottom state stale until a real
		 * user scroll occurs. Synchronize the actual scroll container and emit the
		 * same native scroll event that a tiny manual wheel movement would cause. */
		synchronizeNativeBottomState(chat, messageId);
		requestAnimationFrame(() => {
			if (isChatVisible(chat)) synchronizeNativeBottomState(chat, messageId);
		});
	} catch (error) {
		console.debug("WFRP1ED | Chat bottom follow skipped.", error);
	}
}

function isChatVisible(chat) {
	const root = asElement(chat?.element);
	if (!(root instanceof HTMLElement) || !root.isConnected) return false;

	/* Hidden sidebar tabs normally have no rendered client rectangles. The
	 * computed-style fallback covers installations/themes which retain layout but
	 * hide the inactive tab explicitly. */
	if (root.getClientRects().length === 0) return false;
	const style = getComputedStyle(root);
	if (style.display === "none" || style.visibility === "hidden") return false;

	/* A chat element can exist inside a hidden ancestor even when its own style is
	 * visible. Walking ancestors prevents us from treating that inactive sidebar
	 * panel as an interactive ChatLog. */
	let ancestor = root.parentElement;
	while (ancestor) {
		const ancestorStyle = getComputedStyle(ancestor);
		if (
			ancestorStyle.display === "none" ||
			ancestorStyle.visibility === "hidden"
		) {
			return false;
		}
		ancestor = ancestor.parentElement;
	}

	return true;
}

function synchronizeNativeBottomState(chat, messageId) {
	const root = asElement(chat?.element);
	if (!root) return;

	const escaped = cssEscape(messageId);
	const entry = root.querySelector?.(`[data-message-id="${escaped}"]`) ?? null;
	const scroller = findScrollContainer(entry, root);
	if (!scroller) return;

	const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	if (Math.abs(scroller.scrollTop - maxScrollTop) > 1) {
		scroller.scrollTop = maxScrollTop;
	}

	/* Foundry's own ChatLog scroll listener owns `isAtBottom` and the native
	 * Jump-to-Bottom button. Dispatching scroll lets core recompute both rather
	 * than trying to hide or mutate its control ourselves. */
	scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function findScrollContainer(entry, root) {
	let node = entry?.parentElement ?? null;
	while (node) {
		if (isScrollable(node)) return node;
		if (node === root) break;
		node = node.parentElement;
	}

	for (const selector of [".chat-scroll", "#chat-log", ".chat-log"]) {
		const candidate = root.matches?.(selector)
			? root
			: root.querySelector?.(selector);
		if (candidate && isScrollable(candidate)) return candidate;
		if (candidate?.parentElement && isScrollable(candidate.parentElement)) {
			return candidate.parentElement;
		}
	}

	return isScrollable(root) ? root : null;
}

function isScrollable(element) {
	if (!(element instanceof HTMLElement)) return false;
	if (element.scrollHeight <= element.clientHeight + 1) return false;

	const overflowY = getComputedStyle(element).overflowY;
	return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape ? CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}
