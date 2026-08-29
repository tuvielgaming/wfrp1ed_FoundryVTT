import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
let observer = null;
let reconcileQueued = false;

/*
 * FireBallBallGroupPresentation intentionally refreshes visible aggregate cards
 * in place. That is faster than rebuilding the whole ChatLog, but it replaces
 * target sections and therefore can remove controls supplied by sibling
 * presentation integrations. A DOM observer is appropriate here because the
 * mutation itself is the authoritative signal that those sections were
 * replaced; it avoids guessing how many animation frames a damage roll needs.
 */
Hooks.once("ready", () => installObserver());
Hooks.on("renderChatMessageHTML", (message) => {
	if (message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG)) scheduleReconcile();
});

function installObserver() {
	if (observer || !(document.body instanceof HTMLElement)) return;
	observer = new MutationObserver((mutations) => {
		if (!mutations.some(touchesBallGroup)) return;
		scheduleReconcile();
	});
	observer.observe(document.body, { childList: true, subtree: true });
}

function touchesBallGroup(mutation) {
	const target = mutation?.target;
	if (target instanceof Element && target.closest?.("[data-wfrp-fireball-ball-group]")) return true;
	for (const node of mutation?.addedNodes ?? []) {
		if (!(node instanceof Element)) continue;
		if (node.matches?.("[data-wfrp-fireball-ball-group]") || node.querySelector?.("[data-wfrp-fireball-ball-group]")) return true;
	}
	return false;
}

function scheduleReconcile() {
	if (reconcileQueued) return;
	reconcileQueued = true;
	requestAnimationFrame(() => {
		reconcileQueued = false;
		reconcileRenderedGroups();
	});
}

function reconcileRenderedGroups() {
	for (const message of game.messages ?? []) {
		const group = message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
		if (!group) continue;
		const entry = document.querySelector(`[data-message-id="${cssEscape(String(message.id ?? ""))}"]`);
		if (!(entry instanceof HTMLElement)) continue;
		const panel = entry.querySelector("[data-wfrp-fireball-ball-group]");
		if (!(panel instanceof HTMLElement)) continue;
		reconcileGroup(group, panel);
	}
}

function reconcileGroup(group, panel) {
	const sections = [...panel.querySelectorAll(".wfrp-fireball-ball-group__target")];
	const targets = targetEntries(group);
	for (let index = 0; index < Math.min(sections.length, targets.length); index += 1) {
		const section = sections[index];
		if (!(section instanceof HTMLElement)) continue;
		const record = impactRecordForTarget(group, targets[index]);
		const existing = section.querySelector(".wfrp-fireball-ball-group__initiative-action");
		if (record?.state?.status !== "awaiting-initiative") {
			existing?.remove();
			continue;
		}
		if (existing instanceof HTMLButtonElement) {
			existing.disabled = !ActorRollPolicy.canAdjudicate(actorFromUuid(record.state.targetUuid), game.user);
			continue;
		}
		section.append(buildRecoveryButton(record));
	}
}

function buildRecoveryButton(record) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button wfrp-fireball-ball-group__initiative-action";
	button.textContent = localize("Roll Initiative", "Rzuć Inicjatywę");
	button.style.marginTop = "0.35rem";
	button.style.width = "100%";
	const target = actorFromUuid(record?.state?.targetUuid);
	button.disabled = !ActorRollPolicy.canAdjudicate(target, game.user);
	button.addEventListener("click", () => {
		button.disabled = true;
		void invokeCanonicalInitiative(record).catch(reportError);
	});
	return button;
}

async function invokeCanonicalInitiative(record) {
	const message = record?.message;
	const id = String(message?.id ?? "").trim();
	if (!id) throw new Error(localize("The Fire Ball impact is unavailable.", "Trafienie Ognistej Kuli jest niedostępne."));

	let control = canonicalControl(id);
	if (!(control instanceof HTMLButtonElement)) {
		control = await detachedControl(message);
	}
	if (!(control instanceof HTMLButtonElement)) {
		throw new Error(localize(
			"The canonical Fire Ball Initiative action is unavailable.",
			"Kanoniczna akcja Testu Inicjatywy Ognistej Kuli jest niedostępna.",
		));
	}
	if (control.disabled) {
		throw new Error(localize(
			"You may not roll this Fire Ball Initiative Test.",
			"Nie masz uprawnień do tego Testu Inicjatywy Ognistej Kuli.",
		));
	}
	control.click();
}

function canonicalControl(messageId) {
	const entry = document.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
	const panel = entry?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	return firstRollButton(panel);
}

async function detachedControl(message) {
	const host = document.createElement("div");
	host.innerHTML = String(message?.content ?? "");
	if (!host.querySelector("[data-wfrp-fireball-impact-workflow]")) {
		host.innerHTML = '<section class="wfrp1ed wfrp-fireball-impact-workflow" data-wfrp-fireball-impact-workflow></section>';
	}
	Hooks.callAll("renderChatMessageHTML", message, host);
	for (let index = 0; index < 12; index += 1) {
		const control = firstRollButton(host.querySelector("[data-wfrp-fireball-impact-workflow]"));
		if (control instanceof HTMLButtonElement) return control;
		await new Promise((resolve) => requestAnimationFrame(resolve));
	}
	return null;
}

function firstRollButton(panel) {
	if (!(panel instanceof HTMLElement)) return null;
	return [...panel.querySelectorAll("button.combat-damage-roll-button")]
		.find((button) => button instanceof HTMLButtonElement) ?? null;
}

function targetEntries(group) {
	const explicit = Array.isArray(group?.targets) ? group.targets : [];
	if (explicit.length) return explicit;
	return (group?.impactMessageIds ?? []).map((id) => {
		const impact = game.messages?.get(String(id))?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		return impact ? {
			actorUuid: String(impact.targetUuid ?? ""),
			tokenUuid: String(impact.targetTokenUuid ?? ""),
			name: String(impact.targetName ?? "—"),
		} : null;
	}).filter(Boolean);
}

function impactRecordForTarget(group, target) {
	for (const id of group?.impactMessageIds ?? []) {
		const message = game.messages?.get(String(id));
		const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		if (!impact) continue;
		if (target?.tokenUuid && String(impact.targetTokenUuid ?? "") === String(target.tokenUuid)) return { message, state: impact };
		if (String(impact.targetUuid ?? "") === String(target?.actorUuid ?? "")) return { message, state: impact };
	}
	return null;
}

function actorFromUuid(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function cssEscape(value) {
	return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

function reportError(error) {
	console.error("WFRP1ED | Unable to recover grouped Fire Ball Initiative action.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to roll Fire Ball Initiative Test.",
		"Nie udało się wykonać Testu Inicjatywy Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
