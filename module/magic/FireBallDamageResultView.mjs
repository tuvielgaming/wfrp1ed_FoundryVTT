import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolution } from "../damage/DamageResolution.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { ActorTestRequestWorkflow } from "../tests/ActorTestRequestWorkflow.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const DAMAGE_FLAG_KEY = "damageState";
const VIEW_FLAG_KEY = "fireBallDamageResultView";
const ACTOR_TEST_FLAG_KEY = "actorTestRequest";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "fire-ball-damage-view-action-request";
const RESPONSE_TYPE = "fire-ball-damage-view-action-response";
const TIMEOUT_MS = 30000;
const STRENGTH = 3;
const pending = new Map();
const active = new Set();
let installed = false;

/**
 * Fire Ball extension for the system-wide DamageChat result card.
 *
 * DamageChat and the normal combat lifecycle remain responsible for the card
 * shell, Apply Damage, applied/reverted status and the Damage transaction.
 * This module contributes only Fire Ball-specific adjudication: Initiative,
 * d10/d8 dice and situational fire/psychology vulnerabilities.
 */
export function installFireBallDamageResultView() {
	if (installed) return;
	installed = true;

	Hooks.on("updateChatMessage", (message) => {
		if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) {
			void ensureDamageView(message).catch(reportError);
		}
	});
	Hooks.on("createChatMessage", (message) => {
		if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) {
			void ensureDamageView(message).catch(reportError);
		}
	});
	Hooks.on("renderChatMessageHTML", (message, html) => {
		requestAnimationFrame(() => {
			decorateDamageView(message, html);
			hideResolvedImpactSource(message, html);
		});
	});
	Hooks.once("ready", () => {
		game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload));
		if (ActorRollPolicy.isPrimaryActiveGM()) {
			for (const message of game.messages ?? []) {
				if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) {
					void ensureDamageView(message).catch(reportError);
				}
			}
		}
	});
}

async function ensureDamageView(sourceMessage) {
	if (!ActorRollPolicy.isPrimaryActiveGM()) return null;
	const impact = sourceMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	const damageState = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!impact?.damage || !damageState?.packet || !damageState?.resolution) return null;

	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	if (!target) return null;
	const packet = DamagePacket.fromJSON(damageState.packet);
	const resolution = DamageResolution.fromJSON(damageState.resolution);
	const transaction = DamageApplication.transactionFor(target, packet.id);
	const standalone = DamageChat._state(packet, resolution, "standalone", target.name);
	standalone.application = transaction ? foundry.utils.deepClone(transaction) : null;
	const baseContent = await DamageChat._render(standalone, target, transaction);
	const content = fireBallContent(baseContent, impact, damageState);
	const existing = findView(sourceMessage.id);
	const viewState = {
		version: 1,
		sourceImpactMessageId: String(sourceMessage.id),
		packetId: String(packet.id),
		targetActorUuid: String(target.uuid),
		createdAt: existing?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY)?.createdAt ?? Date.now(),
	};

	if (existing) {
		const changes = {
			content,
			[`flags.${FLAG_SCOPE}.${DAMAGE_FLAG_KEY}`]: standalone,
			[`flags.${FLAG_SCOPE}.${VIEW_FLAG_KEY}`]: viewState,
		};
		await existing.update(changes);
		return existing;
	}

	return ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor: target }),
		content,
		whisper: foundry.utils.deepClone(sourceMessage.whisper ?? []),
		blind: sourceMessage.blind === true,
		flags: {
			[FLAG_SCOPE]: {
				[DAMAGE_FLAG_KEY]: standalone,
				[VIEW_FLAG_KEY]: viewState,
			},
		},
	});
}

function fireBallContent(baseContent, impact, damageState) {
	const template = document.createElement("template");
	template.innerHTML = String(baseContent ?? "").trim();
	const card = template.content.querySelector("[data-wfrp-damage-card]");
	if (!card) return String(baseContent ?? "");

	for (const row of card.querySelectorAll(":scope > .wfrp1e-damage-card__row, :scope > .wfrp1e-damage-card__mitigation")) {
		row.remove();
	}

	const status = card.querySelector("[data-wfrp-damage-status]");
	const hint = card.querySelector(".wfrp1e-damage-card__hint");
	const before = status ?? hint ?? null;

	insertBefore(card, targetRow(impact), before);
	insertBefore(card, vulnerabilityRow(impact), before);
	insertBefore(card, initiativeOutcomeRow(impact), before);
	insertBefore(card, initiativeRollRow(impact), before);
	insertBefore(card, damageDieRow({
		kind: "d10",
		label: localize("Fire Ball damage", "Obrażenia Ognistej Kuli"),
		faces: 10,
		value: impact.damage?.damageRoll,
	}), before);
	if (impact.flammable && Number.isInteger(Number(impact.damage?.flammableRoll))) {
		insertBefore(card, damageDieRow({
			kind: "d8",
			label: localize("Flammable damage", "Obrażenia za łatwopalność"),
			faces: 8,
			value: impact.damage.flammableRoll,
		}), before);
	}

	const details = document.createElement("details");
	details.className = "wfrp1e-damage-card__details";
	details.dataset.wfrpDisclosureKey = "fire-ball-damage-details";
	const summary = document.createElement("summary");
	summary.textContent = localize("Damage details", "Szczegóły obrażeń");
	const body = document.createElement("div");
	body.className = "wfrp1e-damage-card__details-body combat-damage-context__details-body";
	body.append(
		detailRow(localize("Strength", "Siła"), `+${STRENGTH}`),
		detailRow(localize("Armour", "Pancerz"), localize("ignored", "pominięty")),
		detailRow(localize("Toughness", "Wytrzymałość"), `−${nonNegativeInteger(impact.damage?.toughness)}`),
		detailRow(localize("Final damage", "Końcowe obrażenia"), String(damageState?.resolution?.finalAmount ?? impact.damage?.finalDamage ?? 0)),
	);
	details.append(summary, body);
	insertBefore(card, details, before);

	return template.innerHTML;
}

function decorateDamageView(message, html) {
	const view = message?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
	if (!view) return;
	const source = game.messages?.get(String(view.sourceImpactMessageId ?? ""));
	const impact = source?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!source || !impact) return;
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!card) return;

	bindInitiative(card, source, impact);
	bindDamageDie(card, source, impact, "d10");
	bindDamageDie(card, source, impact, "d8");
	bindVulnerabilities(card, source, impact);

	if (impact.status === "awaiting-flammable-damage") {
		const apply = card.querySelector("[data-wfrp-inline-apply-damage]");
		apply?.remove();
		const status = card.querySelector("[data-wfrp-damage-status]");
		if (status) {
			status.hidden = false;
			status.textContent = localize(
				"Fire vulnerability was added — roll only the missing d8 damage.",
				"Dodano łatwopalność — rzuć tylko brakujące obrażenia k8.",
			);
		}
		if (!card.querySelector("[data-fire-ball-roll-missing-d8]")) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "combat-damage-roll-button";
			button.dataset.fireBallRollMissingD8 = "";
			button.textContent = localize("Roll flammable damage (d8)", "Rzuć obrażenia za łatwopalność (k8)");
			const caster = ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
			button.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user);
			button.addEventListener("click", () => void requestMutation(source, "roll-d8").catch(reportError));
			card.append(button);
		}
	}
}

function hideResolvedImpactSource(message, html) {
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact?.damage || !findView(message.id)) return;
	const root = asElement(html);
	const entry = root?.closest?.(".chat-message, li.message, li.chat-message") ?? null;
	if (entry instanceof HTMLElement) {
		entry.style.display = "none";
		return;
	}
	const panel = root?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	if (panel instanceof HTMLElement) panel.hidden = true;
}

function bindInitiative(card, source, impact) {
	const input = card.querySelector("[data-fire-ball-initiative-roll]");
	if (!(input instanceof HTMLInputElement)) return;
	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	input.disabled = !ActorRollPolicy.canAdjudicate(target, game.user) || hasAppliedDamage(source, target);
	input.addEventListener("change", () => {
		void requestMutation(source, "initiative", { value: input.value }).catch(reportError);
	});
}

function bindDamageDie(card, source, impact, kind) {
	const input = card.querySelector(`[data-fire-ball-damage-die="${kind}"]`);
	if (!(input instanceof HTMLInputElement)) return;
	const caster = ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	input.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user) || hasAppliedDamage(source, target);
	input.addEventListener("change", () => {
		void requestMutation(source, kind, { value: input.value }).catch(reportError);
	});
}

function bindVulnerabilities(card, source, impact) {
	for (const input of card.querySelectorAll("[data-fire-ball-view-vulnerability]")) {
		if (!(input instanceof HTMLInputElement)) continue;
		const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
		input.disabled = !game.user?.isGM || hasAppliedDamage(source, target);
		input.addEventListener("change", () => {
			void requestMutation(source, "vulnerability", {
				kind: String(input.dataset.fireBallViewVulnerability ?? ""),
				value: input.checked === true,
			}).catch(reportError);
		});
	}
}

async function requestMutation(source, action, extra = {}) {
	const impact = source?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) throw new Error("This Fire Ball impact is no longer available.");
	const actor = action === "initiative"
		? ActorRollPolicy.actorFromUuidSync(impact.targetUuid)
		: ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
	if (action !== "vulnerability" && !ActorRollPolicy.canAdjudicate(actor, game.user)) {
		throw new Error(localize("You may not edit this roll.", "Nie masz uprawnień do edycji tego rzutu."));
	}
	if (action === "vulnerability" && !game.user?.isGM) {
		throw new Error(localize("Only the GM may adjudicate vulnerabilities.", "Tylko MG może rozstrzygać podatności."));
	}
	if (ActorRollPolicy.isPrimaryActiveGM()) {
		return mutateAsAuthority(source, action, game.user, extra);
	}
	const gm = ActorRollPolicy.primaryActiveGM();
	if (!gm || !game.socket) throw new Error(localize("An active GM is required.", "Wymagany jest aktywny MG."));
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error(localize("The GM did not resolve the edit in time.", "MG nie rozstrzygnął zmiany w wymaganym czasie.")));
		}, TIMEOUT_MS);
		pending.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			sourceMessageId: String(source.id ?? ""),
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
		else entry.reject(new Error(String(payload.error ?? "Unable to edit Fire Ball damage.")));
		return;
	}
	if (payload.type !== REQUEST_TYPE || !ActorRollPolicy.isPrimaryActiveGM()) return;
	const requester = game.users?.get(String(payload.requestUserId ?? ""));
	const source = game.messages?.get(String(payload.sourceMessageId ?? ""));
	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		if (!requester || !source) throw new Error("The Fire Ball edit source is unavailable.");
		response.result = await mutateAsAuthority(source, String(payload.action ?? ""), requester, payload.extra ?? {});
		response.ok = true;
	} catch (error) {
		response.error = error?.message ?? "Unable to edit Fire Ball damage.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function mutateAsAuthority(source, action, requester, extra = {}) {
	const key = `${source.id}:${action}`;
	if (active.has(key)) return null;
	const impact = foundry.utils.deepClone(source.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {});
	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
	if (!target || !caster) throw new Error("The caster or target is unavailable.");
	if (hasAppliedDamage(source, target)) {
		throw new Error(localize(
			"Revert applied damage before editing this Fire Ball result.",
			"Cofnij zastosowane obrażenia przed edycją tego wyniku Ognistej Kuli.",
		));
	}
	if (action === "initiative" && !ActorRollPolicy.canAdjudicate(target, requester)) {
		throw new Error("The requesting user does not own the Initiative roll.");
	}
	if (!["initiative", "vulnerability"].includes(action) && !ActorRollPolicy.canAdjudicate(caster, requester)) {
		throw new Error("The requesting user does not own the damage roll.");
	}
	if (action === "vulnerability" && !requester?.isGM) {
		throw new Error("Only a GM may adjudicate vulnerabilities.");
	}

	active.add(key);
	try {
		if (action === "initiative") {
			if (!impact.initiative) throw new Error("Initiative has not been resolved yet.");
			const roll = boundedInteger(extra.value, 1, 100, "Initiative d100");
			impact.initiative.roll = roll;
			impact.initiative.success = roll <= Number(impact.initiative.target);
			return recalculate(source, impact, target, caster, requester);
		}
		if (action === "d10") {
			if (!impact.damage) throw new Error("Fire Ball damage has not been rolled yet.");
			impact.damage.damageRoll = boundedInteger(extra.value, 1, 10, "Fire Ball d10");
			return recalculate(source, impact, target, caster, requester);
		}
		if (action === "d8") {
			if (!impact.flammable || !impact.damage) throw new Error("Flammable damage is not active.");
			impact.damage.flammableRoll = boundedInteger(extra.value, 1, 8, "Flammable d8");
			return recalculate(source, impact, target, caster, requester);
		}
		if (action === "roll-d8") {
			if (!impact.flammable || !impact.damage || !impact.initiative) throw new Error("Flammable damage is not ready.");
			const roll = await new Roll("1d8").evaluate({ allowInteractive: false });
			await showRollAnimation(roll, requester);
			impact.damage.flammableRoll = boundedInteger(roll.total, 1, 8, "Flammable d8");
			return recalculate(source, impact, target, caster, requester);
		}
		if (action === "vulnerability") {
			const kind = String(extra.kind ?? "");
			const value = extra.value === true;
			if (kind === "fearOfFire") {
				await reconcileFear(impact, target, value);
				impact.fearOfFire = value;
				await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
				return impact;
			}
			if (kind !== "flammable") throw new Error("Unknown Fire Ball vulnerability.");
			if (impact.flammable === value) return impact;
			impact.flammable = value;
			if (!impact.damage) {
				await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
				return impact;
			}
			if (value) {
				impact.status = "awaiting-flammable-damage";
				impact.damage.flammableRoll = null;
				impact.damage.finalDamage = null;
				await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
				await ensureDamageView(source);
				return impact;
			}
			impact.damage.flammableRoll = 0;
			return recalculate(source, impact, target, caster, requester);
		}
		throw new Error(`Unknown Fire Ball damage-view action '${action}'.`);
	} finally {
		active.delete(key);
	}
}

async function recalculate(source, impact, target, caster, requester) {
	if (!impact.initiative || !impact.damage) throw new Error("Initiative and base damage must already exist.");
	const d10 = boundedInteger(impact.damage.damageRoll, 1, 10, "Fire Ball d10");
	const d8 = impact.flammable
		? boundedInteger(impact.damage.flammableRoll, 1, 8, "Flammable d8")
		: 0;
	const fullDamage = STRENGTH + d10 + d8;
	const afterInitiative = impact.initiative.success ? Math.floor(fullDamage / 2) : fullDamage;
	const toughness = nonNegativeInteger(target.getCharacteristicValue("t"));
	const current = source.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const packet = new DamagePacket({
		id: current?.packet?.id ?? null,
		rawAmount: afterInitiative,
		targetActorUuid: target.uuid,
		source: current?.packet?.source ?? {
			kind: "spell-fire-ball",
			id: `${impact.castId || impact.spellUuid}-ball-${impact.ballNumber}-${target.id}`,
			uuid: String(impact.spellUuid ?? ""),
			label: String(impact.spellName ?? localize("Fire Ball", "Ognista Kula")),
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.APPLY,
		criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
	});
	const resolution = DamageResolver.resolve(packet, { toughness: { value: toughness } });
	await DamageChat.attach(source, { packet, resolution });
	impact.status = "resolved";
	impact.damage = {
		...impact.damage,
		packetId: packet.id,
		damageRoll: d10,
		flammableRoll: d8,
		fullDamage,
		afterInitiative,
		toughness,
		finalDamage: resolution.finalAmount,
		updatedAt: Date.now(),
		updatedBy: String(requester?.id ?? ""),
	};
	await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
	await ensureDamageView(source);
	void ui.chat?.render?.({ force: true });
	return impact;
}

async function reconcileFear(impact, target, nextValue) {
	const existing = fearRequest(impact);
	if (nextValue) {
		if (existing) return;
		const message = await ActorTestRequestWorkflow.create({
			actor: target,
			testId: "fear",
			title: localize("Fear of Fire", "Strach przed ogniem"),
			description: localize(
				`${target.name} is subject to fear of fire from ${impact.spellName}.`,
				`${target.name} podlega strachowi przed ogniem wywołanemu przez ${impact.spellName}.`,
			),
			source: {
				kind: "spell-fire-ball",
				spellUuid: String(impact.spellUuid ?? ""),
				castId: String(impact.castId ?? ""),
				targetUuid: String(target.uuid ?? ""),
			},
		});
		impact.fearRequestMessageId = String(message?.id ?? "");
		return;
	}
	if (!existing) {
		impact.fearRequestMessageId = null;
		return;
	}
	const state = existing.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	if (state?.status === "resolved") {
		throw new Error(localize(
			"Fear of Fire has already been resolved and cannot be removed from this cast.",
			"Strach przed ogniem został już rozstrzygnięty i nie można go usunąć z tego czaru.",
		));
	}
	await existing.delete();
	impact.fearRequestMessageId = null;
}

function fearRequest(impact) {
	const id = String(impact?.fearRequestMessageId ?? "").trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function targetRow(impact) {
	return htmlRow(localize("Target", "Cel"), String(impact.targetName ?? "—"), true);
}

function vulnerabilityRow(impact) {
	const row = document.createElement("div");
	row.className = "wfrp-fireball-vulnerability-row";
	row.append(
		checkbox(localize("Flammable", "Łatwopalny"), "flammable", impact.flammable === true),
		checkbox(localize("Fear of Fire", "Strach przed ogniem"), "fearOfFire", impact.fearOfFire === true),
	);
	return row;
}

function initiativeOutcomeRow(impact) {
	return htmlRow(
		localize("Initiative", "Inicjatywa"),
		impact.initiative?.success
			? localize("success — half damage", "sukces — połowa obrażeń")
			: localize("failure — full damage", "porażka — pełne obrażenia"),
		true,
	);
}

function initiativeRollRow(impact) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = localize("Initiative Test", "Test Inicjatywy");
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "100";
	input.step = "1";
	input.value = String(impact.initiative?.roll ?? "");
	input.className = "wfrp1e-damage-roll__total";
	input.dataset.fireBallInitiativeRoll = "";
	row.append(label, input);
	return row;
}

function damageDieRow({ kind, label, faces, value }) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row wfrp1e-damage-card__roll-row";
	const text = document.createElement("span");
	text.textContent = label;
	const roll = document.createElement("div");
	roll.className = "wfrp1e-damage-roll";
	const dice = document.createElement("ol");
	dice.className = "dice-rolls wfrp-fireball-native-die";
	const die = document.createElement("li");
	die.className = `roll die d${faces}`;
	die.textContent = String(value ?? "—");
	die.title = `d${faces}: ${value}`;
	die.setAttribute("aria-label", `d${faces}: ${value}`);
	dice.append(die);
	const equals = document.createElement("span");
	equals.className = "wfrp1e-damage-roll__operator";
	equals.textContent = "=";
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = String(faces);
	input.step = "1";
	input.value = String(value ?? "");
	input.className = "wfrp1e-damage-roll__total";
	input.dataset.fireBallDamageDie = kind;
	roll.append(dice, equals, input);
	row.append(text, roll);
	return row;
}

function checkbox(labelText, kind, checked) {
	const label = document.createElement("label");
	label.className = "wfrp1ed-checkbox";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.checked = checked;
	input.dataset.fireBallViewVulnerability = kind;
	label.append(input, document.createTextNode(labelText));
	return label;
}

function htmlRow(labelText, valueText, strong = false) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement(strong ? "strong" : "span");
	value.textContent = valueText;
	row.append(label, value);
	return row;
}

function detailRow(labelText, valueText) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = valueText;
	row.append(label, value);
	return row;
}

function insertBefore(parent, child, before) {
	if (before) parent.insertBefore(child, before);
	else parent.append(child);
}

function findView(sourceMessageId) {
	const id = String(sourceMessageId ?? "");
	return [...(game.messages ?? [])].find((message) =>
		String(message.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY)?.sourceImpactMessageId ?? "") === id,
	) ?? null;
}

function hasAppliedDamage(source, target) {
	const damage = source?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	return Boolean(
		target &&
		damage?.packet?.id &&
		DamageApplication.transactionFor(target, damage.packet.id)?.state === "applied"
	);
}

async function showRollAnimation(roll, user) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, user ?? game.user, true);
	} catch (_error) {
		/* Dice animation is presentation-only. */
	}
}

function boundedInteger(value, minimum, maximum, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : 0;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Fire Ball shared damage result failed.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to update the Fire Ball damage result.",
		"Nie udało się zaktualizować wyniku obrażeń Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
