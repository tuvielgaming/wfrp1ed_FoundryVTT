const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";

/*
 * Keep the aggregate Fire Ball disclosure marker consistent with Damage cards:
 * right-pointing while folded, down-pointing while expanded.
 *
 * FireBallBallGroupPresentation can rebuild its <details> DOM directly during a
 * linked-message refresh without causing another renderChatMessageHTML hook.
 * Therefore do not bind state to one transient <details> instance. Reconcile all
 * currently rendered Ball cards after renders and after the user toggles a Ball
 * summary. This also survives later aggregate-card refreshes.
 */
Hooks.on("renderChatMessageHTML", (message) => {
	if (!message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG)) return;
	requestAnimationFrame(() => requestAnimationFrame(synchronizeAllIndicators));
});

/* Use delegated click reconciliation because aggregate refreshes replace the
 * actual <details> element. The browser changes details.open after the click, so
 * synchronize on the next animation frame. */
document.addEventListener("click", (event) => {
	const summary = event.target?.closest?.(
		"[data-wfrp-fireball-ball-group] details > summary",
	);
	if (!(summary instanceof HTMLElement)) return;
	requestAnimationFrame(() => synchronizeDetails(summary.parentElement));
}, true);

/* Keyboard activation of <summary> does not necessarily produce the same click
 * path on every browser/Foundry shell. Reconcile Enter/Space as well. */
document.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" && event.key !== " ") return;
	const summary = event.target?.closest?.(
		"[data-wfrp-fireball-ball-group] details > summary",
	);
	if (!(summary instanceof HTMLElement)) return;
	requestAnimationFrame(() => synchronizeDetails(summary.parentElement));
}, true);

function synchronizeAllIndicators() {
	for (const details of document.querySelectorAll(
		"[data-wfrp-fireball-ball-group] details.wfrp-fireball-ball-group__details",
	)) {
		synchronizeDetails(details);
	}
}

function synchronizeDetails(details) {
	if (!(details instanceof HTMLDetailsElement)) return;
	const indicator = details.querySelector(
		":scope > summary .wfrp-fireball-ball-group__expand-indicator",
	);
	if (!(indicator instanceof HTMLElement)) return;

	indicator.textContent = details.open ? "▼" : "▶";
	const summary = details.querySelector(":scope > summary");
	summary?.setAttribute("aria-expanded", details.open ? "true" : "false");
}
