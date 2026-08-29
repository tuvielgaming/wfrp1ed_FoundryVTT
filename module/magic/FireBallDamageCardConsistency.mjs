const FLAG_SCOPE = "wfrp1ed";
const VIEW_FLAG = "fireBallDamageResultView";

/*
 * Fire Ball damage views use the shared DamageChat template so their mechanics
 * stay identical to combat damage. The generic template still contains its old
 * context-menu guidance, while Fire Ball already exposes the canonical Apply
 * Damage button directly. Remove only that redundant presentation from Fire Ball
 * views; do not change the shared template or melee/ranged damage cards.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, VIEW_FLAG)) return;
	requestAnimationFrame(() => normalize(message, html));
});

Hooks.on("updateChatMessage", (message) => {
	if (!message?.getFlag?.(FLAG_SCOPE, VIEW_FLAG)) return;
	requestAnimationFrame(() => normalizeRendered(message));
});

function normalizeRendered(message) {
	const entry = document.querySelector(`[data-message-id="${cssEscape(String(message?.id ?? ""))}"]`);
	if (entry instanceof HTMLElement) normalize(message, entry);
}

function normalize(_message, html) {
	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const card = root.matches?.("[data-wfrp-damage-card]")
		? root
		: root.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement)) return;

	/* The visible Apply button is the source of interaction for this card. A zero
	 * result correctly has no Apply action because no Wounds transaction exists. */
	card.querySelector(".wfrp1e-damage-card__status")?.remove();
	card.querySelector(".wfrp1e-damage-card__hint")?.remove();
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function cssEscape(value) {
	return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}
