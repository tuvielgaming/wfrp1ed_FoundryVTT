import { adjudicateFireBallCastFear } from "./FireBallVulnerabilitySync.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CAST_FLAG = "fireBallCast";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const ACTOR_TEST_FLAG = "actorTestRequest";
const TEST_RESULT_FLAG = "testResultState";
const SECTION_ATTR = "data-wfrp-fireball-cast-psychology";

let refreshQueued = false;

/**
 * Fire Ball Fear belongs to the casting target, not to an individual projectile.
 * The cast summary therefore owns the visible vulnerability checkbox and one
 * result row per creature actually hit by at least one Ball. Canonical impact,
 * ActorTestRequest and TestResult messages remain the mechanical source of truth.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateCastPsychology(message, html));
});

Hooks.on("createChatMessage", (message) => {
	if (isRelated(message)) requestRefresh();
});
Hooks.on("updateChatMessage", (message) => {
	if (isRelated(message)) requestRefresh();
});

function decorateCastPsychology(message, html) {
	const cast = message?.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (!cast?.castId) return;
	const root = asElement(html);
	const summary = root?.matches?.(".fire-ball-cast-summary")
		? root
		: root?.querySelector?.(".fire-ball-cast-summary");
	if (!(summary instanceof HTMLElement)) return;

	const previous = summary.querySelector(`[${SECTION_ATTR}]`);
	const wasOpen = previous instanceof HTMLDetailsElement && previous.open;
	previous?.remove();

	const targets = psychologyTargetsForCast(cast);
	if (!targets.length) return;

	const section = document.createElement("details");
	section.setAttribute(SECTION_ATTR, "");
	section.className = "wfrp-fireball-cast-psychology";
	section.style.marginTop = "0.45rem";
	section.open = wasOpen;

	const heading = document.createElement("summary");
	Object.assign(heading.style, {
		display: "grid",
		gridTemplateColumns: "max-content minmax(0, 1fr) max-content",
		alignItems: "center",
		gap: "0.45rem",
		cursor: "pointer",
		listStyle: "none",
	});
	const arrow = document.createElement("span");
	arrow.textContent = section.open ? "▾" : "▸";
	arrow.setAttribute("aria-hidden", "true");
	const label = document.createElement("strong");
	label.textContent = localize("Psychology", "Psychologia");
	const compact = document.createElement("span");
	compact.textContent = psychologyCompact(targets);
	compact.style.textAlign = "right";
	compact.style.whiteSpace = "nowrap";
	heading.append(arrow, label, compact);
	section.append(heading);

	const body = document.createElement("div");
	Object.assign(body.style, {
		marginTop: "0.35rem",
		paddingTop: "0.35rem",
		borderTop: "1px solid rgba(74, 52, 31, 0.22)",
	});
	for (const target of targets) body.append(psychologyRow(cast.castId, target));
	section.append(body);

	section.addEventListener("toggle", () => {
		arrow.textContent = section.open ? "▾" : "▸";
		heading.setAttribute("aria-expanded", section.open ? "true" : "false");
	});
	summary.append(section);
}

function psychologyRow(castId, target) {
	const row = document.createElement("div");
	Object.assign(row.style, {
		display: "grid",
		gridTemplateColumns: "max-content minmax(0, 1fr) max-content",
		alignItems: "center",
		gap: "0.5rem",
		minHeight: "1.65rem",
	});

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.checked = target.enabled;
	checkbox.disabled = !game.user?.isGM;
	checkbox.title = localize("Fear of Fire", "Strach przed ogniem");
	checkbox.setAttribute("aria-label", `${target.name}: ${localize("Fear of Fire", "Strach przed ogniem")}`);

	const label = document.createElement("span");
	label.textContent = target.name;

	const outcome = fearOutcome(target);
	const value = document.createElement("strong");
	value.textContent = outcome.text;
	value.style.whiteSpace = "nowrap";
	value.style.textAlign = "right";
	if (outcome.kind === "success") value.style.color = "#31542f";
	if (outcome.kind === "failure") value.style.color = "#7b2626";

	checkbox.addEventListener("change", () => {
		if (!game.user?.isGM) return;
		const requested = checkbox.checked === true;
		checkbox.disabled = true;
		void adjudicateFireBallCastFear(castId, target.actorUuid, requested)
			.catch((error) => {
				checkbox.checked = !requested;
				reportError(error);
			})
			.finally(() => {
				if (checkbox.isConnected) checkbox.disabled = !game.user?.isGM;
			});
	});

	row.append(checkbox, label, value);
	return row;
}

function psychologyCompact(targets) {
	const applicable = targets.filter((target) => target.enabled);
	const resolved = applicable
		.map(fearOutcome)
		.filter((entry) => entry.kind === "success" || entry.kind === "failure")
		.length;
	return `${resolved}/${applicable.length} ${localize("resolved", "rozstrzygnięto")}`;
}

function fearOutcome(target) {
	if (!target.enabled) return { text: localize("Not applicable", "Nie dotyczy"), kind: "neutral" };
	const request = target.requestMessage;
	const state = request?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
	if (state?.status !== "resolved" || !state?.resultMessageId) {
		return { text: localize("Pending", "Oczekuje"), kind: "neutral" };
	}
	const resultState = game.messages?.get(String(state.resultMessageId))?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG);
	if (!resultState) return { text: localize("Resolved", "Rozstrzygnięto"), kind: "neutral" };
	const success = testResultSuccess(resultState);
	return {
		text: success ? localize("Success", "Sukces") : localize("Failure", "Porażka"),
		kind: success ? "success" : "failure",
	};
}

/**
 * Build the cast-level Psychology roster from the cast's authoritative volley
 * targets first. Impact messages and Fear requests then overlay vulnerability
 * and result state. This keeps every creature hit by at least one Ball visible
 * even when one impact has not yet linked its Fear request.
 */
function psychologyTargetsForCast(cast) {
	const castId = String(cast?.castId ?? "").trim();
	if (!castId) return [];
	const byActor = new Map();

	for (const volley of cast?.volleys ?? []) {
		for (const target of volley?.targets ?? []) {
			const actorUuid = String(target?.actorUuid ?? target?.uuid ?? "").trim();
			if (!actorUuid) continue;
			if (!byActor.has(actorUuid)) {
				byActor.set(actorUuid, {
					actorUuid,
					name: String(target?.name ?? documentFromUuid(actorUuid)?.name ?? "—"),
					enabled: false,
					explicitlyDisabled: false,
					requestMessage: null,
				});
			}
		}
	}

	for (const message of game.messages ?? []) {
		const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		if (String(impact?.castId ?? "") !== castId) continue;
		const actorUuid = String(impact?.targetUuid ?? "").trim();
		if (!actorUuid) continue;
		let entry = byActor.get(actorUuid);
		if (!entry) {
			entry = {
				actorUuid,
				name: String(impact?.targetName ?? documentFromUuid(actorUuid)?.name ?? "—"),
				enabled: false,
				explicitlyDisabled: false,
				requestMessage: null,
			};
			byActor.set(actorUuid, entry);
		}
		if (impact?.fearManuallyDisabled === true) {
			entry.explicitlyDisabled = true;
			entry.enabled = false;
		} else if (impact?.fearOfFire === true) {
			entry.enabled = true;
		}
		const requestId = String(impact?.fearRequestMessageId ?? "").trim();
		if (requestId && !entry.requestMessage) entry.requestMessage = game.messages?.get(requestId) ?? null;
	}

	for (const message of game.messages ?? []) {
		const request = message.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
		if (request?.source?.kind !== "spell-fire-ball") continue;
		if (String(request?.source?.castId ?? "") !== castId) continue;
		const actorUuid = String(request?.actorUuid ?? request?.source?.targetUuid ?? "").trim();
		if (!actorUuid) continue;
		let entry = byActor.get(actorUuid);
		if (!entry) {
			entry = {
				actorUuid,
				name: String(request?.actorName ?? documentFromUuid(actorUuid)?.name ?? "—"),
				enabled: false,
				explicitlyDisabled: false,
				requestMessage: null,
			};
			byActor.set(actorUuid, entry);
		}
		entry.requestMessage = message;
		/* A linked request means Fear was enabled for the cast unless an impact
		 * explicitly records a later GM disable. */
		if (!entry.explicitlyDisabled) entry.enabled = true;
	}

	return [...byActor.values()]
		.map(({ explicitlyDisabled, ...entry }) => entry)
		.sort((a, b) => a.name.localeCompare(b.name));
}

function isRelated(message) {
	if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)) return true;
	if (isFireBallFearMessage(message)) return true;
	return isFireBallFearResult(message);
}

function isFireBallFearMessage(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
	return state?.source?.kind === "spell-fire-ball";
}

function isFireBallFearResult(message) {
	const id = String(message?.id ?? "").trim();
	if (!id || !message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG)) return false;
	for (const request of game.messages ?? []) {
		const state = request.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
		if (state?.source?.kind !== "spell-fire-ball") continue;
		if (String(state.resultMessageId ?? "") === id) return true;
	}
	return false;
}

function testResultSuccess(state) {
	const roll = Number(state?.roll);
	const baseTarget = Number(state?.baseTarget);
	const general = Number(state?.generalModifier?.value ?? 0);
	const other = (state?.otherModifiers ?? []).reduce((sum, modifier) => {
		if (modifier?.enabled === false) return sum;
		return sum + Number(modifier?.value ?? 0);
	}, 0);
	const target = Math.max(0, Math.min(100, baseTarget + general + other));
	return Number.isFinite(roll) && roll <= target;
}

function requestRefresh() {
	if (refreshQueued) return;
	refreshQueued = true;
	requestAnimationFrame(() => {
		refreshQueued = false;
		for (const message of game.messages ?? []) {
			if (!message.getFlag?.(FLAG_SCOPE, CAST_FLAG)) continue;
			const entry = document.querySelector(`[data-message-id="${cssEscape(message.id)}"]`);
			if (entry instanceof HTMLElement) decorateCastPsychology(message, entry);
		}
	});
}

function documentFromUuid(uuid) {
	try { return foundry.utils.fromUuidSync(String(uuid ?? "").trim()) ?? null; }
	catch (_error) { return null; }
}

function cssEscape(value) {
	return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to adjudicate cast Psychology.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to update Fear of Fire.",
		"Nie udało się zaktualizować Strachu przed ogniem.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
