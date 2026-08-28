import {
	adjudicateFireBallCastFear,
	adjudicateFireBallCastFlammable,
} from "./FireBallVulnerabilitySync.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CAST_FLAG = "fireBallCast";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const ACTOR_TEST_FLAG = "actorTestRequest";
const TEST_RESULT_FLAG = "testResultState";
const SECTION_ATTR = "data-wfrp-fireball-cast-psychology";

let refreshQueued = false;

/**
 * Fire Ball vulnerabilities belong to the target in the cast, not to one
 * projectile. The cast summary therefore owns one Flammable switch and one Fear
 * of Fire switch per creature hit by at least one Ball. Fear results are shown
 * here as Psychology; individual Ball cards keep only Initiative and Damage.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		decorateCastPsychology(message, html);
		/* BallGroupPresentation also renders from a hook. Strip its obsolete
		 * per-Ball Flammable control on the following frame so this remains robust
		 * regardless of hook registration order while we preserve the canonical
		 * hidden impact controls underneath. */
		requestAnimationFrame(() => stripPerBallFlammable(html));
	});
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
	label.textContent = localize("Vulnerabilities", "Podatności");
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
	for (const target of targets) body.append(vulnerabilityRow(cast.castId, target));
	section.append(body);

	section.addEventListener("toggle", () => {
		arrow.textContent = section.open ? "▾" : "▸";
		heading.setAttribute("aria-expanded", section.open ? "true" : "false");
	});
	summary.append(section);
}

function vulnerabilityRow(castId, target) {
	const row = document.createElement("section");
	Object.assign(row.style, {
		padding: "0.25rem 0",
		borderBottom: "1px solid rgba(74, 52, 31, 0.12)",
	});

	const top = document.createElement("div");
	Object.assign(top.style, {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content",
		alignItems: "center",
		gap: "0.5rem",
		minHeight: "1.5rem",
	});
	const name = document.createElement("strong");
	name.textContent = target.name;
	const outcome = fearOutcome(target);
	const value = document.createElement("strong");
	value.textContent = `${localize("Fear", "Strach")}: ${outcome.text}`;
	value.style.whiteSpace = "nowrap";
	value.style.textAlign = "right";
	if (outcome.kind === "success") value.style.color = "#31542f";
	if (outcome.kind === "failure") value.style.color = "#7b2626";
	top.append(name, value);
	row.append(top);

	const controls = document.createElement("div");
	Object.assign(controls.style, {
		display: "flex",
		flexWrap: "wrap",
		gap: "0.35rem 0.9rem",
		marginTop: "0.15rem",
	});

	const flammable = checkboxControl(localize("Flammable", "Łatwopalny"), target.flammable);
	flammable.input.indeterminate = target.flammableMixed === true;
	flammable.input.disabled = !game.user?.isGM;
	flammable.input.title = target.flammableMixed
		? localize(
			"Existing Ball impacts disagree. Choose a value to normalize the whole cast for this target.",
			"Istniejące trafienia Kul mają różne wartości. Wybierz wartość, aby ujednolicić cały czar dla tego celu.",
		)
		: localize("Flammable for every Fire Ball in this cast", "Łatwopalny dla każdej Ognistej Kuli w tym rzuceniu czaru");
	flammable.input.addEventListener("change", () => {
		if (!game.user?.isGM) return;
		const requested = flammable.input.checked === true;
		flammable.input.indeterminate = false;
		flammable.input.disabled = true;
		void adjudicateFireBallCastFlammable(castId, target.actorUuid, requested)
			.catch((error) => {
				flammable.input.checked = target.flammable;
				flammable.input.indeterminate = target.flammableMixed === true;
				reportError(error);
			})
			.finally(() => {
				if (flammable.input.isConnected) flammable.input.disabled = !game.user?.isGM;
			});
	});

	const fear = checkboxControl(localize("Fear of Fire", "Strach przed ogniem"), target.enabled);
	fear.input.disabled = !game.user?.isGM;
	fear.input.addEventListener("change", () => {
		if (!game.user?.isGM) return;
		const requested = fear.input.checked === true;
		fear.input.disabled = true;
		void adjudicateFireBallCastFear(castId, target.actorUuid, requested)
			.catch((error) => {
				fear.input.checked = !requested;
				reportError(error);
			})
			.finally(() => {
				if (fear.input.isConnected) fear.input.disabled = !game.user?.isGM;
			});
	});

	controls.append(flammable.label, fear.label);
	row.append(controls);
	return row;
}

function checkboxControl(text, checked) {
	const label = document.createElement("label");
	label.className = "wfrp1ed-checkbox";
	Object.assign(label.style, {
		display: "inline-flex",
		alignItems: "center",
		gap: "0.35rem",
	});
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked === true;
	label.append(input, document.createTextNode(text));
	return { label, input };
}

function psychologyCompact(targets) {
	const applicable = targets.filter((target) => target.enabled);
	const resolved = applicable
		.map(fearOutcome)
		.filter((entry) => entry.kind === "success" || entry.kind === "failure")
		.length;
	return `${localize("Fear", "Strach")} ${resolved}/${applicable.length}`;
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

function psychologyTargetsForCast(cast) {
	const castId = String(cast?.castId ?? "").trim();
	if (!castId) return [];
	const byActor = new Map();

	const ensureEntry = (actorUuid, name = "—") => {
		let entry = byActor.get(actorUuid);
		if (!entry) {
			entry = {
				actorUuid,
				name,
				enabled: false,
				explicitlyDisabled: false,
				requestMessage: null,
				flammableValues: new Set(),
			};
			byActor.set(actorUuid, entry);
		}
		return entry;
	};

	for (const volley of cast?.volleys ?? []) {
		for (const target of volley?.targets ?? []) {
			const actorUuid = String(target?.actorUuid ?? target?.uuid ?? "").trim();
			if (!actorUuid) continue;
			ensureEntry(actorUuid, String(target?.name ?? documentFromUuid(actorUuid)?.name ?? "—"));
		}
	}

	for (const message of impactMessagesForCast(castId)) {
		const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		const actorUuid = String(impact?.targetUuid ?? "").trim();
		if (!actorUuid) continue;
		const entry = ensureEntry(actorUuid, String(impact?.targetName ?? documentFromUuid(actorUuid)?.name ?? "—"));
		entry.flammableValues.add(impact?.flammable === true);
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
		const entry = ensureEntry(actorUuid, String(request?.actorName ?? documentFromUuid(actorUuid)?.name ?? "—"));
		entry.requestMessage = message;
		if (!entry.explicitlyDisabled) entry.enabled = true;
	}

	return [...byActor.values()]
		.map((entry) => {
			const values = [...entry.flammableValues];
			const flammableMixed = values.length > 1;
			const flammable = values.length > 0 && values.every((value) => value === true);
			return {
				actorUuid: entry.actorUuid,
				name: entry.name,
				enabled: entry.enabled,
				requestMessage: entry.requestMessage,
				flammable,
				flammableMixed,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function impactMessagesForCast(castId) {
	const cast = String(castId ?? "").trim();
	if (!cast) return [];
	const byId = new Map();
	for (const message of game.messages ?? []) {
		const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		if (String(impact?.castId ?? "") === cast) byId.set(String(message.id), message);
	}
	for (const message of game.messages ?? []) {
		const group = message.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
		if (String(group?.castId ?? "") !== cast) continue;
		for (const id of group?.impactMessageIds ?? []) {
			const normalized = String(id ?? "").trim();
			const impactMessage = normalized ? game.messages?.get(normalized) : null;
			if (impactMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)) byId.set(normalized, impactMessage);
		}
	}
	return [...byId.values()];
}

function stripPerBallFlammable(html) {
	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	root.querySelectorAll?.(".wfrp-fireball-ball-group__flammable").forEach((element) => element.remove());
}

function isRelated(message) {
	if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)) return true;
	if (message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG)) return true;
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
		for (const element of document.querySelectorAll?.(".wfrp-fireball-ball-group__flammable") ?? []) {
			element.remove();
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
	console.error("WFRP1ED | Unable to adjudicate cast vulnerabilities.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to update Fire Ball vulnerability.",
		"Nie udało się zaktualizować podatności Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
