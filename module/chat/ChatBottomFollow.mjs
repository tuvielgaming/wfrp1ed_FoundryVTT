const followIntent = new Map();
const FOLLOW_TTL_MS = 2500;

Hooks.on("createChatMessage", (message) => {
	if (!message?.id) return;

	const chat = ui.chat;
	followIntent.set(message.id, chat?.isAtBottom !== false);
	setTimeout(() => followIntent.delete(message.id), FOLLOW_TTL_MS);
});

Hooks.on("renderChatMessageHTML", (message) => {
	if (!message?.id) return;
	if (followIntent.get(message.id) !== true) return;
	if (!isNewestVisibleMessage(message)) return;

	/* Foundry performs its own conditional scroll when the message is inserted.
	 * WFRP cards can grow afterwards in renderChatMessageHTML hooks (critical
	 * result text, fatal controls, consequence panels). Follow once more after
	 * those synchronous mutations and again after layout/images have settled. */
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
				behavior: "instant",
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
