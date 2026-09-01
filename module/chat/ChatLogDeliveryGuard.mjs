const FLAG_SCOPE = "wfrp1ed";
const deferredMessageIds = new Set();
let flushScheduled = false;

/**
 * Keep WFRP ChatMessage persistence and ChatLog presentation separate.
 *
 * ChatMessage.create() owns persistence in game.messages. Foundry v14 may show
 * a notification for a message created while another Sidebar tab is active,
 * while the hidden ChatLog has no rendered card for that message yet. Trying to
 * post/render into that inactive ChatLog proved unreliable because its DOM is
 * virtualized by the Sidebar lifecycle.
 *
 * Therefore every newly-created WFRP message is remembered by id. If Chat is
 * already active we verify delivery after core has completed its own create
 * handling. If Chat is inactive we wait for the official changeSidebarTab hook
 * and only then post any still-missing cards from authoritative game.messages.
 */
Hooks.on("createChatMessage", (message) => {
	if (!isWfrpMessage(message)) return;
	remember(message);
	if (isChatActive()) scheduleFlush();
});

/* Combat enriches a generic TestResult after creation. If the original create
 * was missed by an older world state or another module, an update is another
 * safe opportunity to remember the same persistent message. */
Hooks.on("updateChatMessage", (message, changes) => {
	if (!isWfrpMessage(message) && !changesTouchWfrp(changes)) return;
	remember(message);
	if (isChatActive()) scheduleFlush();
});

Hooks.on("deleteChatMessage", (message) => {
	const id = String(message?.id ?? "").trim();
	if (id) deferredMessageIds.delete(id);
});

/* Foundry v14 documents changeSidebarTab(app) as the authoritative notification
 * that one SidebarTab application has become active. Do not guess from hidden
 * DOM state; wait for this lifecycle event and synchronize Chat at that point. */
Hooks.on("changeSidebarTab", (app) => {
	if (!isChatApplication(app)) return;
	scheduleFlush();
});

function remember(message) {
	const id = String(message?.id ?? "").trim();
	if (id) deferredMessageIds.add(id);
}

function scheduleFlush() {
	if (flushScheduled || !deferredMessageIds.size) return;
	flushScheduled = true;

	queueMicrotask(() => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				flushScheduled = false;
				void flushDeferredMessages();
			});
		});
	});
}

async function flushDeferredMessages() {
	if (!isChatActive() || !deferredMessageIds.size) return;

	const chat = ui.chat;
	if (typeof chat?.postOne !== "function") {
		console.warn(
			"WFRP1ED | ChatLog.postOne is unavailable; deferred chat delivery skipped.",
		);
		return;
	}

	/* Resolve from game.messages now, not from stale Document references retained
	 * across an inactive Sidebar interval. Keep creation order so several queued
	 * Test/combat cards appear in the same order as the authoritative collection. */
	const messages = [...deferredMessageIds]
		.map((id) => game.messages?.get(id) ?? null)
		.filter(Boolean)
		.sort((left, right) => messageOrder(left) - messageOrder(right));

	for (const message of messages) {
		const id = String(message.id ?? "");
		if (!id) continue;

		if (chatContainsMessage(id)) {
			deferredMessageIds.delete(id);
			continue;
		}

		try {
			await chat.postOne(message, {
				notify: false,
				scroll: false,
			});
		} catch (error) {
			console.error(
				`WFRP1ED | Unable to add deferred ChatMessage '${id}' to the active ChatLog.`,
				error,
			);
			continue;
		}

		/* postOne is asynchronous and owns DOM insertion. If Foundry accepted the
		 * request, remove the id even when a theme/module changes the final wrapper
		 * selector; a later update hook can re-queue it if necessary. */
		deferredMessageIds.delete(id);
	}
}

function chatContainsMessage(messageId) {
	const root = asElement(ui.chat?.element);
	if (!(root instanceof HTMLElement)) return false;
	const escaped = cssEscape(messageId);
	return Boolean(root.querySelector?.(`[data-message-id="${escaped}"]`));
}

function isChatActive() {
	const chat = ui.chat;
	return Boolean(chat && chat.active === true);
}

function isChatApplication(app) {
	return Boolean(app && (app === ui.chat || String(app.tabName ?? "") === "chat"));
}

function messageOrder(message) {
	const timestamp = Number(message?.timestamp ?? message?._source?.timestamp ?? 0);
	return Number.isFinite(timestamp) ? timestamp : 0;
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

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape
		? CSS.escape(text)
		: text.replace(/["\\]/g, "\\$&");
}
