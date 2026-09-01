/**
 * Refresh only the already-rendered sidebar copy of one persistent ChatMessage.
 *
 * WFRP combat deliberately creates one generic TestResult ChatMessage first and
 * then layers attack/defence state onto that same document. Foundry's document
 * update lifecycle does not guarantee that an already logged ChatMessage is
 * rendered again merely because a flag was attached. The WFRP decorators live
 * in renderChatMessageHTML, so without an explicit refresh the stored document
 * can be mechanically complete while the visible DOM remains the earlier plain
 * Test card.
 *
 * Foundry v14 ChatLog.renderMessage() is the supported single-message renderer.
 * Replacing only the existing sidebar element avoids full ChatLog rerenders,
 * preserves history/scroll ownership in Foundry, and causes the ordinary
 * renderChatMessageHTML decorator pipeline to run for the updated document.
 */
export async function refreshVisibleChatMessage(message) {
	const id = String(message?.id ?? "").trim();
	if (!id) return null;

	const chatRoot = asElement(ui.chat?.element);
	if (!(chatRoot instanceof HTMLElement)) return null;

	const selector = `[data-message-id="${cssEscape(id)}"]`;
	const current = chatRoot.matches?.(selector)
		? chatRoot
		: chatRoot.querySelector?.(selector);
	if (!(current instanceof HTMLElement)) return null;

	const ChatLog = foundry.applications?.sidebar?.tabs?.ChatLog;
	if (typeof ChatLog?.renderMessage !== "function") {
		console.warn(
			"WFRP1ED | ChatLog.renderMessage is unavailable; visible ChatMessage refresh skipped.",
		);
		return null;
	}

	const replacement = await ChatLog.renderMessage(message);
	if (!(replacement instanceof HTMLElement)) return null;

	current.replaceWith(replacement);
	return replacement;
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
