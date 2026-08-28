const FLAG_SCOPE = "wfrp1ed";

/*
 * Foundry creates a roll-bearing ChatMessage before Dice So Nice finishes its
 * animation. That makes the numerical result visible before the physical dice,
 * which is backwards for an adjudication-first tabletop workflow.
 *
 * Keep this presentation-only: the canonical ChatMessage is created normally so
 * Dice So Nice can use the ordinary Foundry message/roll pipeline. We merely hide
 * a newly-created WFRP card until Dice So Nice reports that message's animation
 * has finished, then reveal the already-canonical card. No rule state changes.
 */
const pendingReveal = new Set();
const revealing = new Set();

Hooks.on("preCreateChatMessage", (message, data) => {
	if (!isWfrpRollMessage(message, data)) return;
	const id = messageId(message, data);
	if (id) pendingReveal.add(id);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	const id = String(message?.id ?? "").trim();
	if (!id || !pendingReveal.has(id)) return;
	setEntryHidden(html, true);
});

Hooks.on("createChatMessage", (message) => {
	const id = String(message?.id ?? "").trim();
	if (!id || !pendingReveal.has(id) || revealing.has(id)) return;
	revealing.add(id);
	queueMicrotask(() => void revealAfterDice(message));
});

async function revealAfterDice(message) {
	const id = String(message?.id ?? "").trim();
	try {
		const wait = game.dice3d?.waitFor3DAnimationByMessageID;
		if (typeof wait === "function") {
			await wait.call(game.dice3d, id);
		}
	} catch (error) {
		/* Dice animation is optional presentation. Never strand a result card. */
		console.error(
			"WFRP1ED | Unable to wait for dice animation before revealing chat result.",
			error,
		);
	} finally {
		pendingReveal.delete(id);
		revealing.delete(id);
		revealRenderedEntry(id);
	}
}

function isWfrpRollMessage(message, data) {
	const rolls = Array.isArray(data?.rolls)
		? data.rolls
		: Array.isArray(message?.rolls)
			? message.rolls
			: [];
	if (!rolls.length) return false;

	const flags = data?.flags?.[FLAG_SCOPE] ?? message?.flags?.[FLAG_SCOPE];
	return Boolean(flags && typeof flags === "object");
}

function messageId(message, data) {
	return String(message?.id ?? message?._id ?? data?._id ?? "").trim();
}

function setEntryHidden(html, hidden) {
	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const entry = root.closest?.("[data-message-id], .chat-message, li.message, li.chat-message") ?? root;
	if (!(entry instanceof HTMLElement)) return;
	if (hidden) {
		entry.dataset.wfrpDiceFirstPending = "";
		entry.style.display = "none";
		entry.setAttribute("aria-hidden", "true");
	} else {
		delete entry.dataset.wfrpDiceFirstPending;
		entry.style.removeProperty("display");
		entry.removeAttribute("aria-hidden");
	}
}

function revealRenderedEntry(messageId) {
	const selector = `[data-message-id="${cssEscape(messageId)}"]`;
	const entry = document.querySelector(selector);
	if (entry instanceof HTMLElement) setEntryHidden(entry, false);
}

function cssEscape(value) {
	return globalThis.CSS?.escape
		? CSS.escape(String(value))
		: String(value).replace(/["\\]/g, "\\$&");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
