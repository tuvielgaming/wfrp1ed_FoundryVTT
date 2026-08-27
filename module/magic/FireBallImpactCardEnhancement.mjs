import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const DAMAGE_FLAG_KEY = "damageState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "fire-ball-flammable-action-request";
const RESPONSE_TYPE = "fire-ball-flammable-action-response";
const TIMEOUT_MS = 30000;
const STRENGTH = 3;
const pending = new Map();
const active = new Set();
const queuedAutomatic = new Set();
let installed = false;

/**
 * Presentation/reconciliation layer for Fire Ball impact cards.
 *
 * This module deliberately owns only the cross-stage UI concerns which are
 * awkward for the base impact workflow:
 * - compact Initiative outcome + editable d100 on one card,
 * - die-shaped d10/d8 result badges,
 * - adding/removing Flammable after base damage without rerolling the d10.
 */
export function installFireBallImpactCardEnhancement() {
	if (installed) return;
	installed = true;
	Hooks.on("renderChatMessageHTML", (message, html) => {
		requestAnimationFrame(() => enhance(message, html));
	});
	Hooks.once("ready", () => {
		game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload));
	});
}

function enhance(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-impact-workflow]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	if (!(panel instanceof HTMLElement)) return;

	decorateInitiative(panel, state);
	decorateDiceBadges(panel);
	removeDuplicateInitiativeDetail(panel);
	interceptResolvedFlammableAdjudication(panel, message, state);

	if (state.status === "awaiting-flammable-damage" && state.damage) {
		renderPendingFlammableDamage(panel, message, state);
	}
}

function decorateInitiative(panel, state) {
	if (!state.initiative) return;
	const initiativeRow = panel.querySelector(".wfrp-fireball-initiative-row");
	if (!(initiativeRow instanceof HTMLElement)) return;

	if (!panel.querySelector("[data-fire-ball-initiative-outcome]")) {
		const outcome = document.createElement("div");
		outcome.className = "wfrp1e-damage-card__row";
		outcome.dataset.fireBallInitiativeOutcome = "";
		const label = document.createElement("span");
		label.textContent = localize("Initiative", "Inicjatywa");
		const value = document.createElement("strong");
		value.textContent = state.initiative.success
			? localize("success — half damage", "sukces — połowa obrażeń")
			: localize("failure — full damage", "porażka — pełne obrażenia");
		outcome.append(label, value);
		initiativeRow.before(outcome);
	}

	const label = initiativeRow.querySelector(":scope > span:first-child");
	if (label) label.textContent = localize("Initiative Test", "Test Inicjatywy");
	const editor = initiativeRow.querySelector(".wfrp-fireball-inline-roll");
	const resultText = editor?.querySelector("strong");
	resultText?.remove();
}

function decorateDiceBadges(panel) {
	for (const row of panel.querySelectorAll(".wfrp-fireball-die-row")) {
		const badge = row.querySelector(".wfrp-fireball-die-badge");
		const input = row.querySelector("input[type='number']");
		if (!(badge instanceof HTMLElement) || !(input instanceof HTMLInputElement)) continue;
		const sides = Number(input.max) === 8 ? 8 : 10;
		styleDieBadge(badge, sides, input.value);
	}
}

function styleDieBadge(badge, sides, value) {
	badge.textContent = String(value ?? "—");
	badge.title = `d${sides}`;
	badge.setAttribute("aria-label", `d${sides}: ${value}`);
	Object.assign(badge.style, {
		display: "inline-grid",
		placeItems: "center",
		width: "30px",
		height: "30px",
		minWidth: "30px",
		background: "#3b3329",
		color: "#f5ead5",
		fontWeight: "700",
		fontSize: "13px",
		lineHeight: "1",
		textAlign: "center",
		clipPath: sides === 8
			? "polygon(50% 0%, 85% 15%, 100% 50%, 85% 85%, 50% 100%, 15% 85%, 0% 50%, 15% 15%)"
			: "polygon(50% 0%, 79% 9%, 97% 35%, 97% 65%, 79% 91%, 50% 100%, 21% 91%, 3% 65%, 3% 35%, 21% 9%)",
	});
}

function removeDuplicateInitiativeDetail(panel) {
	for (const row of panel.querySelectorAll(".wfrp1e-damage-card__details-body .wfrp1e-damage-card__row")) {
		const label = row.querySelector(":scope > span:first-child")?.textContent?.trim();
		if (label === "Inicjatywa" || label === "Initiative") row.remove();
	}
}

function interceptResolvedFlammableAdjudication(panel, message, state) {
	if (!state.damage) return;
	panel.addEventListener("change", (event) => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement)) return;
		if (input.dataset.fireBallVulnerability !== "flammable") return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (!game.user?.isGM) return;
		void adjudicateResolvedFlammable(message, input.checked === true).catch(reportError);
	}, { capture: true, once: true });
}

async function adjudicateResolvedFlammable(message, nextValue) {
	const state = foundry.utils.deepClone(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {});
	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!target || !caster || !state.damage) return;
	assertUnapplied(message, target);

	if (!state.initiative) {
		throw new Error(localize(
			"Initiative must be resolved before changing Fire Ball damage vulnerability.",
			"Test Inicjatywy musi być rozstrzygnięty przed zmianą podatności obrażeń Ognistej Kuli.",
		));
	}

	if (nextValue === state.flammable) return;
	state.flammable = nextValue;
	await clearDamageFlag(message, target);

	if (nextValue) {
		state.status = "awaiting-flammable-damage";
		state.damage = {
			...state.damage,
			flammableRoll: null,
			finalDamage: null,
			updatedAt: Date.now(),
		};
		state.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
		void ui.chat?.render?.({ force: true });
		return;
	}

	await recalculateDamage(message, state, target, caster, {
		damageRoll: Number(state.damage.damageRoll),
		flammableRoll: 0,
		requestingUser: game.user,
	});
}

function renderPendingFlammableDamage(panel, message, state) {
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	if (!caster || !target) return;
	const amount = panel.querySelector(".wfrp1e-damage-card__amount");
	if (amount) amount.textContent = "—";

	if (!panel.querySelector("[data-fire-ball-preserved-d10]")) {
		const row = document.createElement("div");
		row.className = "wfrp1e-damage-card__row wfrp-fireball-die-row";
		row.dataset.fireBallPreservedD10 = "";
		const label = document.createElement("span");
		label.textContent = localize("Fire Ball damage", "Obrażenia Ognistej Kuli");
		const editor = document.createElement("span");
		editor.className = "wfrp-fireball-die-editor";
		const badge = document.createElement("span");
		badge.className = "wfrp-fireball-die-badge";
		styleDieBadge(badge, 10, state.damage.damageRoll);
		const input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "10";
		input.step = "1";
		input.value = String(state.damage.damageRoll);
		input.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user);
		input.addEventListener("change", () => void requestPendingAction(message, "d10", { value: input.value }).catch(reportError));
		editor.append(badge, input);
		row.append(label, editor);
		const initiativeRow = panel.querySelector(".wfrp-fireball-initiative-row");
		(initiativeRow ?? panel.lastElementChild)?.after?.(row);
	}

	if (!panel.querySelector("[data-fire-ball-roll-flammable]")) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "combat-damage-roll-button";
		button.dataset.fireBallRollFlammable = "";
		button.textContent = localize("Roll flammable damage (d8)", "Rzuć obrażenia za łatwopalność (k8)");
		button.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user);
		button.addEventListener("click", () => void requestPendingAction(message, "d8").catch(reportError));
		panel.append(button);
	}
	maybeAutoFlammable(message, caster);
}

async function requestPendingAction(message, action, extra = {}) {
	const state = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	const caster = ActorRollPolicy.actorFromUuidSync(state?.casterUuid);
	if (!state || !ActorRollPolicy.canAdjudicate(caster, game.user)) {
		throw new Error(localize("You may not resolve this damage roll.", "Nie masz uprawnień do rozstrzygnięcia tego rzutu obrażeń."));
	}
	if (game.user?.isGM) return resolvePendingAsAuthority(message, action, game.user, extra);
	const gm = ActorRollPolicy.primaryActiveGM();
	if (!gm || !game.socket) throw new Error(localize("An active GM is required.", "Wymagany jest aktywny MG."));
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error(localize("The GM did not resolve the roll in time.", "MG nie rozstrzygnął rzutu w wymaganym czasie.")));
		}, TIMEOUT_MS);
		pending.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
			action,
			extra,
		});
	});
}

async function handleSocket(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const entry = pending.get(String(payload.requestId ?? ""));
		if (!entry) return;
		pending.delete(String(payload.requestId ?? ""));
		clearTimeout(entry.timeout);
		if (payload.ok) entry.resolve(payload.result ?? null);
		else entry.reject(new Error(String(payload.error ?? "Unable to resolve flammable damage.")));
		return;
	}
	if (payload.type !== REQUEST_TYPE || !ActorRollPolicy.isPrimaryActiveGM()) return;
	const requester = game.users?.get(String(payload.requestUserId ?? ""));
	const message = game.messages?.get(String(payload.messageId ?? ""));
	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		if (!requester || !message) throw new Error("Request source is unavailable.");
		response.result = await resolvePendingAsAuthority(message, String(payload.action ?? ""), requester, payload.extra ?? {});
		response.ok = true;
	} catch (error) {
		response.error = error?.message ?? "Unable to resolve flammable damage.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function resolvePendingAsAuthority(message, action, requestingUser, extra = {}) {
	const key = `${message.id}:${action}`;
	if (active.has(key)) return null;
	const state = foundry.utils.deepClone(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {});
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	if (!caster || !target || !ActorRollPolicy.canAdjudicate(caster, requestingUser)) {
		throw new Error("The requesting user does not own this damage roll.");
	}
	if (state.status !== "awaiting-flammable-damage" || !state.damage || !state.initiative) return state;
	active.add(key);
	try {
		if (action === "d10") {
			state.damage.damageRoll = boundedInteger(extra.value, 1, 10, "Fire Ball d10");
			state.updatedAt = Date.now();
			await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
			void ui.chat?.render?.({ force: true });
			return state;
		}
		if (action !== "d8") throw new Error("Unknown pending Fire Ball damage action.");
		const roll = await new Roll("1d8").evaluate({ allowInteractive: false });
		await showRollAnimation(roll, requestingUser);
		return recalculateDamage(message, state, target, caster, {
			damageRoll: Number(state.damage.damageRoll),
			flammableRoll: boundedInteger(roll.total, 1, 8, "Flammable d8"),
			requestingUser,
		});
	} finally {
		active.delete(key);
	}
}

async function recalculateDamage(message, state, target, caster, { damageRoll, flammableRoll, requestingUser }) {
	if (!state.initiative) throw new Error("Initiative must be resolved before damage.");
	await clearDamageFlag(message, target);
	const fullDamage = STRENGTH + Number(damageRoll) + (state.flammable ? Number(flammableRoll) : 0);
	const afterInitiative = state.initiative.success ? Math.floor(fullDamage / 2) : fullDamage;
	const toughness = nonNegativeInteger(target.getCharacteristicValue("t"), "Toughness");
	const packet = new DamagePacket({
		rawAmount: afterInitiative,
		targetActorUuid: target.uuid,
		source: {
			kind: "spell-fire-ball",
			id: `${state.castId || state.spellUuid}-ball-${state.ballNumber}-${target.id}-${foundry.utils.randomID(6)}`,
			uuid: state.spellUuid,
			label: state.spellName,
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.APPLY,
		criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
	});
	const resolution = DamageResolver.resolve(packet, { toughness: { value: toughness } });
	await DamageChat.attach(message, { packet, resolution });
	state.status = "resolved";
	state.damage = {
		...state.damage,
		packetId: packet.id,
		damageRoll: Number(damageRoll),
		flammableRoll: state.flammable ? Number(flammableRoll) : 0,
		fullDamage,
		afterInitiative,
		toughness,
		finalDamage: resolution.finalAmount,
		rolledBy: String(requestingUser?.id ?? state.damage?.rolledBy ?? ""),
		rolledAt: state.damage?.rolledAt ?? Date.now(),
		updatedAt: Date.now(),
	};
	state.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
	void ui.chat?.render?.({ force: true });
	return state;
}

async function clearDamageFlag(message, target) {
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!damageState) return;
	if (DamageApplication.transactionFor(target, damageState.packet?.id)?.state === "applied") {
		throw new Error(localize(
			"Revert applied damage before recalculating this Fire Ball hit.",
			"Cofnij zastosowane obrażenia przed ponownym obliczeniem tego trafienia Ognistej Kuli.",
		));
	}
	await message.unsetFlag(FLAG_SCOPE, DAMAGE_FLAG_KEY);
}

function assertUnapplied(message, target) {
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (damageState?.packet?.id && DamageApplication.transactionFor(target, damageState.packet.id)?.state === "applied") {
		throw new Error(localize(
			"Revert applied damage before changing Fire Ball vulnerabilities.",
			"Cofnij zastosowane obrażenia Ognistej Kuli przed zmianą podatności.",
		));
	}
}

function maybeAutoFlammable(message, caster) {
	if (!ActorRollPolicy.shouldAutomaticallyRoll(caster, game.user)) return;
	const key = `${message.id}:auto-d8`;
	if (queuedAutomatic.has(key)) return;
	queuedAutomatic.add(key);
	queueMicrotask(() => void resolvePendingAsAuthority(message, "d8", game.user)
		.catch(reportError)
		.finally(() => setTimeout(() => queuedAutomatic.delete(key), 250)));
}

async function showRollAnimation(roll, requestingUser) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, requestingUser ?? game.user, true);
	} catch (_error) {}
}

function boundedInteger(value, minimum, maximum, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return number;
}

function nonNegativeInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
	return number;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Fire Ball impact card enhancement failed.", error);
	ui.notifications.error(error?.message ?? localize("Unable to update Fire Ball impact.", "Nie udało się zaktualizować trafienia Ognistej Kuli."));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
