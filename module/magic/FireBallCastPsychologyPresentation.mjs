const FLAG_SCOPE = "wfrp1ed";
const CAST_FLAG = "fireBallCast";
const ACTOR_TEST_FLAG = "actorTestRequest";
const TEST_RESULT_FLAG = "testResultState";
const SECTION_ATTR = "data-wfrp-fireball-cast-psychology";

let refreshQueued = false;

/**
 * Fire Ball Fear belongs to the casting/encounter target, not to an individual
 * projectile. Present one Psychology summary on the cast card and let Ball cards
 * focus on the per-projectile Initiative + Damage chain.
 *
 * Canonical ActorTestRequest/TestResult messages remain untouched and visible at
 * this stage, so rolling, Luck and later adjudication continue to use their
 * existing mechanics. This module is presentation-only.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateCastPsychology(message, html));
});

Hooks.on("createChatMessage", (message) => {
	if (isFireBallFearMessage(message)) requestRefresh();
});
Hooks.on("updateChatMessage", (message) => {
	if (isFireBallFearMessage(message) || isFireBallFearResult(message)) requestRefresh();
});

function decorateCastPsychology(message, html) {
	const cast = message?.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (!cast?.castId) return;
	const root = asElement(html);
	const summary = root?.matches?.(".fire-ball-cast-summary")
		? root
		: root?.querySelector?.(".fire-ball-cast-summary");
	if (!(summary instanceof HTMLElement)) return;

	summary.querySelector(`[${SECTION_ATTR}]`)?.remove();
	const requests = fearRequestsForCast(cast.castId);
	if (!requests.length) return;

	const section = document.createElement("details");
	section.setAttribute(SECTION_ATTR, "");
	section.className = "wfrp-fireball-cast-psychology";
	section.style.marginTop = "0.45rem";

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
	arrow.textContent = "▸";
	arrow.setAttribute("aria-hidden", "true");
	const label = document.createElement("strong");
	label.textContent = localize("Psychology", "Psychologia");
	const compact = document.createElement("span");
	compact.textContent = psychologyCompact(requests);
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
	for (const request of requests) body.append(psychologyRow(request));
	section.append(body);

	section.addEventListener("toggle", () => {
		arrow.textContent = section.open ? "▾" : "▸";
		heading.setAttribute("aria-expanded", section.open ? "true" : "false");
	});
	summary.append(section);
}

function psychologyRow(message) {
	const state = message.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG) ?? {};
	const row = document.createElement("div");
	Object.assign(row.style, {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content",
		alignItems: "center",
		gap: "0.6rem",
		minHeight: "1.45rem",
	});
	const actor = documentFromUuid(state.actorUuid);
	const label = document.createElement("span");
	label.textContent = String(state.actorName ?? actor?.name ?? "—");
	const outcome = fearOutcome(message);
	const value = document.createElement("strong");
	value.textContent = outcome.text;
	value.style.whiteSpace = "nowrap";
	if (outcome.kind === "success") value.style.color = "#31542f";
	if (outcome.kind === "failure") value.style.color = "#7b2626";
	row.append(label, value);
	return row;
}

function psychologyCompact(requests) {
	const outcomes = requests.map(fearOutcome);
	const resolved = outcomes.filter((entry) => entry.kind === "success" || entry.kind === "failure").length;
	return `${resolved}/${outcomes.length} ${localize("resolved", "rozstrzygnięto")}`;
}

function fearOutcome(requestMessage) {
	const state = requestMessage?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
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

function fearRequestsForCast(castId) {
	const id = String(castId ?? "").trim();
	if (!id) return [];
	const requests = [];
	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
		if (state?.source?.kind !== "spell-fire-ball") continue;
		if (String(state.source?.castId ?? "") !== id) continue;
		requests.push(message);
	}
	return requests.sort((a, b) => String(a.id).localeCompare(String(b.id)));
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
	try {
		return foundry.utils.fromUuidSync(String(uuid ?? "").trim()) ?? null;
	} catch (_error) {
		return null;
	}
}

function cssEscape(value) {
	return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
