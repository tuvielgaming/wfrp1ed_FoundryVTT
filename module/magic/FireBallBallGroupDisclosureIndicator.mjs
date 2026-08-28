const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";

/* Keep the aggregate Fire Ball disclosure marker consistent with Damage cards:
 * right-pointing while folded, down-pointing while expanded. The aggregate card
 * itself remains owned by FireBallBallGroupPresentation; this adapter only
 * reconciles presentation after that renderer rebuilds the <details> element. */
Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG)) return;
	requestAnimationFrame(() => requestAnimationFrame(() => bindIndicator(html)));
});

function bindIndicator(html) {
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-ball-group]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-ball-group]");
	if (!(panel instanceof HTMLElement)) return;
	const details = panel.querySelector(":scope > details");
	const indicator = details?.querySelector?.(".wfrp-fireball-ball-group__expand-indicator");
	if (!(details instanceof HTMLDetailsElement) || !(indicator instanceof HTMLElement)) return;

	const synchronize = () => {
		indicator.textContent = details.open ? "▾" : "▸";
		const summary = details.querySelector(":scope > summary");
		summary?.setAttribute("aria-expanded", details.open ? "true" : "false");
	};

	synchronize();
	if (details.dataset.wfrpBallDisclosureBound === "true") return;
	details.dataset.wfrpBallDisclosureBound = "true";
	details.addEventListener("toggle", synchronize);
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
