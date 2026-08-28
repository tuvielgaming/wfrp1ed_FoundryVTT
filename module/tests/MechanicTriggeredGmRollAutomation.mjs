import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const queued = new Set();

/**
 * Extend the existing GM-only roll automation boundary to dependent rolls which
 * are exposed by another mechanic after its primary result is already known.
 *
 * Do not duplicate those mechanics here. Their existing buttons already own the
 * authoritative action and, importantly, create the normal editable/Luck-capable
 * ChatMessage. This adapter only invokes that same action automatically for an
 * Actor with no non-GM OWNER when the World automation setting is enabled.
 *
 * Current dependent-roll contracts:
 * - Jump damage -> separate held-items d100 check;
 * - Abseiling -> additional Risk Test(s).
 *
 * Psychology/Fear requests use ActorTestRequestWorkflow and therefore already
 * use ActorRollPolicy directly. Fire Ball Initiative does the same in its impact
 * workflow. Future mechanic-triggered tests should prefer those canonical paths.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	/* Movement integrations bind their own button listeners during the same chat
	 * render. Defer two frames so automation invokes the fully-activated action
	 * instead of racing its listener installation. */
	requestAnimationFrame(() => requestAnimationFrame(() => {
		maybeAutomateDependentRoll(message, html);
	}));
});

function maybeAutomateDependentRoll(message, html) {
	const state = movementState(message);
	if (!state) return;
	const actor = ActorRollPolicy.actorFromUuidSync(state.actorUuid);
	if (!ActorRollPolicy.shouldAutomaticallyRollMechanicTest(actor, game.user)) return;

	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;

	if (state.kind === "jump") {
		const button = findActionButton(root, "[data-wfrp-held-items-roll]");
		if (button) queueButtonAction(message, "held-items", button);
		return;
	}

	if (state.kind === "climbing") {
		const button = findActionButton(
			root,
			'[data-wfrp-climbing-action="roll-additional-risk"]',
		);
		if (button) queueButtonAction(message, "additional-risk", button);
	}
}

function queueButtonAction(message, action, button) {
	if (!(button instanceof HTMLButtonElement)) return;
	if (button.disabled || button.hidden || !button.isConnected) return;

	const key = `${String(message?.id ?? "")}:${action}`;
	if (!message?.id || queued.has(key)) return;
	queued.add(key);

	queueMicrotask(() => {
		try {
			if (!button.isConnected || button.disabled || button.hidden) return;
			button.click();
		} finally {
			/* The authoritative action immediately changes its source state. Keep a
			 * short guard only to prevent repeated render hooks from double-clicking
			 * before that Document update arrives. */
			setTimeout(() => queued.delete(key), 1000);
		}
	});
}

function findActionButton(root, selector) {
	const button = root.matches?.(selector)
		? root
		: root.querySelector?.(selector);
	return button instanceof HTMLButtonElement ? button : null;
}

function movementState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
