import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const INITIATIVE_LINK_FLAG_KEY = "fireBallInitiativeLink";
const DAMAGE_FLAG_KEY = "damageState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "fire-ball-impact-action-request";
const RESPONSE_TYPE = "fire-ball-impact-action-response";
const SOCKET_TIMEOUT_MS = 30000;
const STRENGTH = 3;
const pendingRequests = new Map();
const activeActions = new Set();
const queuedAutomatic = new Set();
let installed = false;

/** Pending Initiative -> Damage workflow for one Fire Ball hit. */
export class FireBallImpactWorkflow {
	static install() {
		if (installed) return;
		installed = true;
		Hooks.on("renderChatMessageHTML", (message, html) => {
			requestAnimationFrame(() => decorate(message, html));
		});
		Hooks.on("updateChatMessage", (message, changes) => {
			void reconcileInitiativeChange(message, changes);
		});
		Hooks.on("preUpdateChatMessage", (message, changes) =>
			guardAppliedImpactAdjudication(message, changes));
		Hooks.once("ready", () => {
			game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload));
		});
	}

	static async create({ caster, spell, target, ballIndex, flammable = false } = {}) {
		if (!(caster instanceof foundry.documents.Actor)) throw new Error("Fire Ball impact requires a caster Actor.");
		if (!(target?.actor instanceof foundry.documents.Actor)) throw new Error("Fire Ball impact requires a target Actor.");
		const state = {
			version: 1,
			status: "awaiting-initiative",
			casterUuid: String(caster.uuid),
			casterName: String(caster.name ?? ""),
			spellUuid: String(spell?.uuid ?? ""),
			spellName: String(spell?.name ?? localize("Fire Ball", "Ognista Kula")),
			ballNumber: Number(ballIndex) + 1,
			targetUuid: String(target.actor.uuid),
			targetTokenUuid: String(target.tokenUuid ?? ""),
			targetName: String(target.name ?? target.actor.name ?? ""),
			flammable: flammable === true,
			initiativeMessageId: null,
			initiativeSuccess: null,
			damage: null,
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
		};
		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor: caster }),
			content: `<section class="wfrp1ed wfrp-fireball-impact-workflow" data-wfrp-fireball-impact-workflow></section>`,
			flags: { [FLAG_SCOPE]: { [IMPACT_FLAG_KEY]: state } },
		});
	}
}

function decorate(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-impact-workflow]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	if (!(panel instanceof HTMLElement)) return;
	panel.replaceChildren();

	const header = document.createElement("div");
	header.className = "combat-damage-context__heading";
	header.textContent = `${state.spellName} ${state.ballNumber} — ${state.targetName}`;
	panel.append(header);

	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!target || !caster) {
		panel.append(statusText(localize("The caster or target is no longer available.", "Rzucający czar lub cel nie jest już dostępny.")));
		return;
	}

	if (state.status === "awaiting-initiative") {
		panel.append(statusText(localize(
			`${target.name} must make an Initiative Test. Success halves Fire Ball damage.`,
			`${target.name} musi wykonać Test Inicjatywy. Sukces zmniejsza obrażenia Ognistej Kuli o połowę.`,
		)));
		const button = actionButton(localize("Roll Initiative", "Rzuć Inicjatywę"));
		button.disabled = !ActorRollPolicy.canAdjudicate(target, game.user);
		button.title = button.disabled
			? localize("Only the GM or an OWNER of the target may roll this Test.", "Tylko MG albo Właściciel celu może wykonać ten Test.")
			: "";
		button.addEventListener("click", () => void requestAction(message, "initiative").catch(reportError));
		panel.append(button);
		maybeQueueAutomatic(message, "initiative", target);
		return;
	}

	if (state.initiativeSuccess !== null) {
		panel.append(detailRow(
			localize("Initiative", "Inicjatywa"),
			state.initiativeSuccess
				? localize("success — damage halved", "sukces — obrażenia o połowę")
				: localize("failure — full damage", "porażka — pełne obrażenia"),
		));
	}

	if (state.status === "awaiting-damage") {
		const button = actionButton(localize("Roll Damage", "Rzuć obrażenia"));
		button.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user);
		button.title = button.disabled
			? localize("Only the GM or an OWNER of the caster may roll this damage.", "Tylko MG albo Właściciel rzucającego czar może rzucić te obrażenia.")
			: localize("Roll the spell-specific 1d10 damage; Fire Ball does not use exploding Additional Damage.", "Rzuć właściwe dla czaru obrażenia 1k10; Ognista Kula nie używa eksplodujących Obrażeń Dodatkowych.");
		button.addEventListener("click", () => void requestAction(message, "damage").catch(reportError));
		panel.append(button);
		maybeQueueAutomatic(message, "damage", caster);
		return;
	}

	if (state.status === "resolved" && state.damage) {
		panel.append(buildResolvedPanel(message, state, target, caster));
	}
}

function buildResolvedPanel(message, state, target, caster) {
	const details = document.createElement("details");
	details.className = "combat-damage-context__resolved";
	const summary = document.createElement("summary");
	const title = document.createElement("strong");
	title.textContent = localize("Damage", "Obrażenia");
	const amount = document.createElement("span");
	amount.textContent = String(state.damage.finalDamage ?? 0);
	summary.append(title, amount);
	details.append(summary);

	const body = document.createElement("div");
	body.className = "combat-damage-context__details-body";
	body.append(
		detailRow(localize("Fire Ball d10", "Ognista Kula k10"), String(state.damage.damageRoll)),
		detailRow(localize("Strength", "Siła"), `+${STRENGTH}`),
	);
	if (state.flammable) {
		body.append(detailRow(localize("Flammable d8", "Łatwopalny k8"), String(state.damage.flammableRoll)));
	}
	body.append(
		detailRow(localize("Before Initiative", "Przed Inicjatywą"), String(state.damage.fullDamage)),
		detailRow(localize("After Initiative", "Po Inicjatywie"), String(state.damage.afterInitiative)),
		detailRow(localize("Toughness", "Wytrzymałość"), `−${state.damage.toughness}`),
		detailRow(localize("Armour", "Pancerz"), localize("ignored", "pominięty")),
		detailRow(localize("Final damage", "Końcowe obrażenia"), String(state.damage.finalDamage)),
	);

	const transaction = damageTransaction(message, target);
	const status = statusText(transaction?.state === "applied"
		? localize(
			`Applied · Wounds ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
			`Zastosowano · Żywotność ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
		)
		: transaction?.state === "reverted"
			? localize("Damage application reverted.", "Zastosowanie obrażeń cofnięto.")
			: localize("Damage resolved — ready to apply.", "Obrażenia rozstrzygnięte — gotowe do zastosowania."));
	body.append(status);

	if (!transaction && Number(state.damage.finalDamage) > 0) {
		const apply = actionButton(localize("Apply Damage", "Zastosuj obrażenia"));
		apply.disabled = !DamageChat.canApplyMessage(message, game.user);
		apply.addEventListener("click", () => {
			void DamageChat.applyMessage(message)
				.then(() => ui.chat?.render?.({ force: true }))
				.catch(reportError);
		});
		body.append(apply);
	}

	const diceTotal = Number(state.damage.diceTotal);
	const editor = document.createElement("label");
	editor.className = "combat-damage-context__row";
	const editorLabel = document.createElement("span");
	editorLabel.textContent = localize("Damage dice total", "Suma kości obrażeń");
	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.step = "1";
	input.value = String(diceTotal);
	input.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user) || Boolean(transaction);
	input.addEventListener("change", () => void requestAction(message, "override", { total: input.value }).catch(reportError));
	editor.append(editorLabel, input);
	body.append(editor);

	details.append(body);
	return details;
}

async function requestAction(message, action, extra = {}) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!state) throw new Error("This Fire Ball impact is no longer available.");
	const actor = action === "initiative"
		? ActorRollPolicy.actorFromUuidSync(state.targetUuid)
		: ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!ActorRollPolicy.canAdjudicate(actor, game.user)) {
		throw new Error(localize("You may not resolve this roll.", "Nie masz uprawnień do rozstrzygnięcia tego rzutu."));
	}
	if (game.user?.isGM) return resolveAsAuthority(message, action, game.user, extra);
	return requestGmAction(message, action, extra);
}

async function requestGmAction(message, action, extra) {
	const gm = ActorRollPolicy.primaryActiveGM();
	if (!gm || !game.socket) throw new Error(localize("An active GM is required.", "Wymagany jest aktywny MG."));
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize("The GM did not resolve the action in time.", "MG nie rozstrzygnął akcji w wymaganym czasie.")));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
			action: String(action),
			extra,
		});
	});
}

async function handleSocket(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const entry = pendingRequests.get(String(payload.requestId ?? ""));
		if (!entry) return;
		pendingRequests.delete(String(payload.requestId ?? ""));
		clearTimeout(entry.timeout);
		if (payload.ok) entry.resolve(payload.result ?? null);
		else entry.reject(new Error(String(payload.error ?? "Unable to resolve Fire Ball impact.")));
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
		if (!requester || !message) throw new Error("The requesting user or impact message is unavailable.");
		response.result = await resolveAsAuthority(message, String(payload.action ?? ""), requester, payload.extra ?? {});
		response.ok = true;
	} catch (error) {
		response.error = error?.message ?? "Unable to resolve Fire Ball impact.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function resolveAsAuthority(message, action, requestingUser, extra = {}) {
	const key = `${message.id}:${action}`;
	if (activeActions.has(key)) return null;
	const state = foundry.utils.deepClone(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {});
	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(state.casterUuid);
	if (!target || !caster) throw new Error("The caster or target is unavailable.");
	const ownedActor = action === "initiative" ? target : caster;
	if (!ActorRollPolicy.canAdjudicate(ownedActor, requestingUser)) throw new Error("The requesting user does not own this roll.");

	activeActions.add(key);
	try {
		if (action === "initiative") {
			if (state.status !== "awaiting-initiative") return state;
			const result = await target.rollCharacteristic("i", { modifier: 0 });
			if (!result?.chatMessage) throw new Error("Initiative Test did not produce a result message.");
			await result.chatMessage.setFlag(FLAG_SCOPE, INITIATIVE_LINK_FLAG_KEY, { impactMessageId: String(message.id) });
			state.initiativeMessageId = String(result.chatMessage.id);
			state.initiativeSuccess = result.success === true;
			state.status = "awaiting-damage";
			state.updatedAt = Date.now();
			await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
			return state;
		}

		if (action === "damage") {
			if (state.status !== "awaiting-damage") return state;
			const damageRoll = await new Roll("1d10").evaluate({ allowInteractive: false });
			await showRollAnimation(damageRoll, requestingUser);
			const d10 = boundedInteger(damageRoll.total, 1, 10, "Fire Ball d10");
			let d8 = 0;
			if (state.flammable) {
				const flammableRoll = await new Roll("1d8").evaluate({ allowInteractive: false });
				await showRollAnimation(flammableRoll, requestingUser);
				d8 = boundedInteger(flammableRoll.total, 1, 8, "Flammable d8");
			}
			return finalizeDamage(message, state, target, d10, d8, requestingUser);
		}

		if (action === "override") {
			if (state.status !== "resolved" || !state.damage) throw new Error("Damage is not resolved yet.");
			if (damageTransaction(message, target)) throw new Error("Applied damage must be reverted before editing its dice total.");
			const total = nonNegativeInteger(extra.total, "Damage dice total");
			const d10 = Math.min(10, total);
			const d8 = Math.max(0, total - d10);
			return finalizeDamage(message, state, target, d10, d8, requestingUser, { overriddenTotal: total });
		}
		throw new Error(`Unknown Fire Ball impact action '${action}'.`);
	} finally {
		activeActions.delete(key);
	}
}

async function finalizeDamage(message, state, target, d10, d8, requestingUser, { overriddenTotal = null } = {}) {
	const diceTotal = overriddenTotal ?? (d10 + d8);
	const fullDamage = STRENGTH + diceTotal;
	const afterInitiative = state.initiativeSuccess ? Math.floor(fullDamage / 2) : fullDamage;
	const toughness = nonNegativeInteger(target.getCharacteristicValue("t"), "Toughness");
	const existingDamage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const packet = new DamagePacket({
		id: existingDamage?.packet?.id ?? null,
		rawAmount: afterInitiative,
		targetActorUuid: target.uuid,
		source: {
			kind: "spell-fire-ball",
			id: `${state.spellUuid || "fire-ball"}-${state.ballNumber}-${message.id}`,
			uuid: state.spellUuid || String(message.uuid ?? ""),
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
		damageRoll: d10,
		flammableRoll: state.flammable ? d8 : 0,
		diceTotal,
		diceTotalOverridden: overriddenTotal !== null,
		fullDamage,
		afterInitiative,
		toughness,
		finalDamage: resolution.finalAmount,
		rolledBy: String(requestingUser?.id ?? ""),
		rolledAt: Date.now(),
	};
	state.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
	void ui.chat?.render?.({ force: true });
	return state;
}

async function reconcileInitiativeChange(message, changes) {
	const link = message?.getFlag?.(FLAG_SCOPE, INITIATIVE_LINK_FLAG_KEY);
	if (!link?.impactMessageId || !testStateChanged(changes)) return;
	const impactMessage = game.messages?.get(String(link.impactMessageId));
	const state = foundry.utils.deepClone(impactMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {});
	const testState = message.getFlag?.(FLAG_SCOPE, "testResultState");
	if (!impactMessage || !state?.targetUuid || !testState) return;
	const target = ActorRollPolicy.actorFromUuidSync(state.targetUuid);
	if (!target) return;
	if (damageTransaction(impactMessage, target)) return;

	state.initiativeSuccess = TestResultChat._templateContext(testState).result.success === true;
	if (state.damage) {
		await finalizeDamage(
			impactMessage,
			state,
			target,
			Number(state.damage.damageRoll),
			Number(state.damage.flammableRoll ?? 0),
			game.user,
			{ overriddenTotal: state.damage.diceTotalOverridden ? Number(state.damage.diceTotal) : null },
		);
	} else {
		state.updatedAt = Date.now();
		await impactMessage.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, state);
	}
}

function guardAppliedImpactAdjudication(message, changes) {
	const link = message?.getFlag?.(FLAG_SCOPE, INITIATIVE_LINK_FLAG_KEY);
	if (!link?.impactMessageId || !testStateChanged(changes)) return;
	const impactMessage = game.messages?.get(String(link.impactMessageId));
	const state = impactMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	const target = ActorRollPolicy.actorFromUuidSync(state?.targetUuid);
	if (!impactMessage || !target) return;
	if (damageTransaction(impactMessage, target)) {
		ui.notifications.warn(localize(
			"Revert the applied Fire Ball damage before changing its Initiative result.",
			"Cofnij zastosowane obrażenia Ognistej Kuli przed zmianą wyniku Inicjatywy.",
		));
		return false;
	}
}

function maybeQueueAutomatic(message, action, actor) {
	if (!ActorRollPolicy.shouldAutomaticallyRoll(actor, game.user)) return;
	const key = `${message.id}:auto:${action}`;
	if (queuedAutomatic.has(key)) return;
	queuedAutomatic.add(key);
	queueMicrotask(() => {
		void resolveAsAuthority(message, action, game.user)
			.catch(reportError)
			.finally(() => setTimeout(() => queuedAutomatic.delete(key), 250));
	});
}

function damageTransaction(message, target) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!damageState?.packet?.id || !(target instanceof foundry.documents.Actor)) return null;
	return DamageApplication.transactionFor(target, damageState.packet.id);
}

function actionButton(text) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button";
	button.textContent = text;
	return button;
}

function detailRow(labelText, valueText) {
	const row = document.createElement("div");
	row.className = "combat-damage-context__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = String(valueText ?? "—");
	row.append(label, value);
	return row;
}

function statusText(text) {
	const element = document.createElement("div");
	element.className = "combat-damage-context__status";
	element.textContent = text;
	return element;
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.testResultState`;
	return Object.hasOwn(changes, path) || foundry.utils.getProperty?.(changes, path) !== undefined;
}

async function showRollAnimation(roll, requestingUser) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, requestingUser ?? game.user, true);
	} catch (_error) {}
}

function boundedInteger(value, minimum, maximum, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label} is invalid.`);
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
	console.error("WFRP1ED | Fire Ball impact resolution failed.", error);
	ui.notifications.error(error?.message ?? localize("Unable to resolve Fire Ball impact.", "Nie udało się rozstrzygnąć trafienia Ognistej Kuli."));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

FireBallImpactWorkflow.install();
