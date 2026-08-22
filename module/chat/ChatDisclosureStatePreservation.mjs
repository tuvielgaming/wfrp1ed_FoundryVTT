const TARGET_DISCLOSURE_SELECTOR = "details.wfrp1e-test-card__target";
const disclosureStates = new Map();

/*
 * Preserve the user's local open/closed state for expandable WFRP test-card
 * breakdowns while a ChatMessage is re-rendered.
 *
 * Manual roll/modifier edits update the ChatMessage content. Foundry then
 * rebuilds the DOM from the Handlebars template, and a plain <details> element
 * returns to its template default (currently closed). That made the section
 * collapse immediately after entering a value inside the expanded breakdown.
 *
 * This is deliberately client-local UI state. It is not written to message
 * flags, so opening a breakdown on one user's screen does not open it for other
 * connected users and does not become part of the mechanical/audit snapshot.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const root = asElement(html);
	if (!root) return;

	const disclosures = targetDisclosures(root);
	if (disclosures.length === 0) return;

	const messageId = String(message?.id ?? "").trim();
	if (!messageId) return;

	let state = disclosureStates.get(messageId);
	if (!state) {
		state = new Map();
		disclosureStates.set(messageId, state);
	}

	for (const [index, details] of disclosures.entries()) {
		const key = disclosureKey(details, index);
		if (state.has(key)) {
			details.open = state.get(key) === true;
		} else {
			state.set(key, details.open === true);
		}

		details.addEventListener("toggle", () => {
			const current = disclosureStates.get(messageId) ?? new Map();
			current.set(key, details.open === true);
			disclosureStates.set(messageId, current);
		});
	}
});

Hooks.on("deleteChatMessage", (message) => {
	const messageId = String(message?.id ?? "").trim();
	if (messageId) disclosureStates.delete(messageId);
});

function targetDisclosures(root) {
	const results = [];
	if (root.matches?.(TARGET_DISCLOSURE_SELECTOR)) results.push(root);
	results.push(...(root.querySelectorAll?.(TARGET_DISCLOSURE_SELECTOR) ?? []));
	return results;
}

function disclosureKey(details, index) {
	const explicit = String(details?.dataset?.wfrpDisclosureKey ?? "").trim();
	return explicit || `test-card-target:${index}`;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
