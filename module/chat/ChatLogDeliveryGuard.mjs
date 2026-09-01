const FLAG_SCOPE = "wfrp1ed";
const pending = new Map();

/**
 * Foundry v14 persists ChatMessage Documents independently from displaying them
 * in the sidebar ChatLog. Normally core's createChatMessage handling calls
 * ChatLog.postOne(), but WFRP result messages can be created and then enriched
 * while another sidebar tab is active. In that state Foundry may show the
 * notification card without the persistent message being logged into the hidden
 * ChatLog.
 *
 * Do not activate Chat and do not manipulate scroll state. Give core one frame
 * to perform its ordinary delivery, then use the supported ChatLog.postOne()
 * API only when ChatMessage.logged still reports false.
 */
Hooks.on("createChatMessage", (message) => {
	if (!isWfrpMessage(message)) return;
	queueDelivery(message, { notify: true });
});

/* Combat layers attack/defence state onto an already-created generic Test
 * message. If that message was created while Chat was inactive, re-check its
 * delivery when the WFRP flags change rather than assuming the create hook was
 * enough. */
Hooks.on("updateChatMessage", (message, changes) => {
	if (!isWfrpMessage(message) && !changesTouchWfrp(changes)) return;
	queueDelivery(message, { notify: false });
});

function queueDelivery(message, { notify }) {
	const id = String(message?.id ?? "").trim();
	if (!id) return;

	const existing = pending.get(id);
	if (existing) {
		existing.notify ||= notify === true;
		return;
	}

	const request = { notify: notify === true };
	pending.set(id, request);

	requestAnimationFrame(() => {
		setTimeout(() => {
			pending.delete(id);
			void ensureLogged(message, request.notify);
		}, 0);
	});
}

async function ensureLogged(message, notify) {
	if (!message?.id || message.logged === true) return;

	const chat = ui.chat;
	if (typeof chat?.postOne !== "function") {
		console.warn(
			"WFRP1ED | ChatLog.postOne is unavailable; persistent message delivery cannot be repaired.",
		);
		return;
	}

	try {
		await chat.postOne(message, {
			notify: notify === true,
			scroll: false,
		});
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to deliver persistent WFRP ChatMessage to ChatLog.",
			error,
		);
	}
}

function isWfrpMessage(message) {
	const scoped = message?.flags?.[FLAG_SCOPE] ?? message?._source?.flags?.[FLAG_SCOPE];
	return Boolean(scoped && typeof scoped === "object" && Object.keys(scoped).length);
}

function changesTouchWfrp(changes) {
	if (!changes || typeof changes !== "object") return false;
	if (changes?.flags?.[FLAG_SCOPE]) return true;
	return Object.keys(changes).some((key) =>
		String(key).startsWith(`flags.${FLAG_SCOPE}.`),
	);
}
