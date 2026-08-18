Hooks.on("renderChatMessageHTML", (message) => {
	if (!message?.id) return;

	/* Foundry fires this hook while the message HTML is still pending insertion.
	 * Therefore isAtBottom describes the user's position before this new card can
	 * increase the scroll height. Preserve that native follow/not-follow choice. */
	if (ui.chat?.isAtBottom !== true) return;
	if (!isNewestVisibleMessage(message)) return;

	/* WFRP render hooks can make a Critical/result card substantially taller than
	 * the base ChatMessage. Foundry may perform its own scroll before the final
	 * layout settles, so follow once after insertion and once after late layout or
	 * embedded images have settled. */
	queueMicrotask(() => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => void scrollChatBottom());
		});
	});

	setTimeout(() => void scrollChatBottom(), 120);
});

async function scrollChatBottom() {
	const chat = ui.chat;
	if (!chat?.scrollBottom) return;

	try {
		await chat.scrollBottom({
			popout: true,
			waitImages: true,
			scrollOptions: {
				behavior: "auto",
				block: "end",
			},
		});
	} catch (error) {
		console.debug("WFRP1ED | Chat bottom follow skipped.", error);
	}
}

function isNewestVisibleMessage(message) {
	const visible = [...(game.messages ?? [])]
		.filter((candidate) => candidate?.visible !== false)
		.sort((left, right) =>
			(Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0)) ||
			String(left.id ?? "").localeCompare(String(right.id ?? "")),
		);
	return visible.at(-1)?.id === message.id;
}
