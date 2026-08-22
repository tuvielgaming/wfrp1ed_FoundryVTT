import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";

const SOCKET_CHANNEL = "system.wfrp1ed";
/*
 * This request is intentionally the same one owned by
 * CombatDamagePhysicalDiceIntegration. That module remains the single
 * authoritative parry-adjudication path; this file is only a view adapter for
 * the dedicated Damage card.
 */
const SOCKET_REQUEST_TYPE = "combat-parry-physical-die-request";
const SOCKET_RESPONSE_TYPE = "combat-parry-physical-die-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateDedicatedParryDie(message, html));
});

Hooks.once("ready", () => registerSocketResponse());

function decorateDedicatedParryDie(viewMessage, html) {
	const view = viewMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.sourceAttackMessageId) return;

	const sourceMessage = game.messages?.get(String(view.sourceAttackMessageId));
	if (!sourceMessage) return;

	const attack = sourceMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		rollState?.parry?.succeeded !== true ||
		!isD6(rollState?.parry?.reduction) ||
		!damageState?.packet?.id
	) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!card) return;

	const row = findRow(card, localize("Parry", "Parowanie"));
	if (!row) return;
	const valueHost = row.querySelector?.(":scope > strong");
	if (!valueHost || valueHost.querySelector?.("[data-wfrp-dedicated-parry-d6]")) {
		return;
	}

	const current = Number(rollState.parry.reduction);
	const generated = isD6(rollState.parry.reductionOriginal)
		? Number(rollState.parry.reductionOriginal)
		: current;
	const editable = canEditParry(sourceMessage, game.user);
	const absorbed = nonNegativeInteger(
		damageState?.resolution?.breakdown?.parry?.absorbed,
	);
	const itemName = String(rollState.parry?.itemName ?? "").trim();

	valueHost.textContent = "";
	const editor = document.createElement("span");
	editor.className = "wfrp1e-combat-damage-die-editor";
	editor.dataset.wfrpDedicatedParryD6 = "";

	const label = document.createElement("span");
	label.className = "wfrp1e-combat-damage-die-editor__label";
	label.textContent = game.i18n.lang === "pl" ? "K6" : "d6";
	editor.append(label);

	if (generated !== current) {
		const audit = document.createElement("span");
		audit.className = "wfrp1e-combat-damage-die-editor__audit";
		audit.textContent = `${generated} →`;
		audit.title = localize(
			`Foundry generated ${generated}; the adjudicated physical-die result is shown in the input.`,
			`Foundry wygenerował ${generated}; w polu znajduje się rozstrzygający wynik fizycznej kości.`,
		);
		editor.append(audit);
	}

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "6";
	input.step = "1";
	input.inputMode = "numeric";
	input.value = String(current);
	input.className = "wfrp1e-combat-damage-die-editor__input";
	input.dataset.wfrpDedicatedParryD6Input = "";
	input.readOnly = !editable;
	input.setAttribute("aria-readonly", editable ? "false" : "true");
	input.title = editable
		? localize(
			"Enter the defender's physical d6 parry reduction. Pending damage is recalculated immediately.",
			"Wpisz wynik fizycznej K6 redukcji parowania obrońcy. Oczekujące obrażenia zostaną natychmiast przeliczone.",
		)
		: localize(
			"This parry die is locked because its damage transaction already exists or you do not own the defender.",
			"Ta kość parowania jest zablokowana, ponieważ transakcja obrażeń już istnieje albo nie jesteś właścicielem obrońcy.",
		);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") input.blur();
	});
	input.addEventListener("change", () => {
		void commitParry(sourceMessage, input, current);
	});
	editor.append(input);

	const meta = document.createElement("span");
	meta.className = "wfrp1e-combat-damage-die-editor__meta";
	meta.textContent = `→ ${absorbed}${itemName ? ` (${itemName})` : ""}`;
	meta.title = localize(
		"Amount actually stopped by the successful parry after the current adjudication.",
		"Liczba obrażeń faktycznie zatrzymanych przez udane parowanie po bieżącym rozstrzygnięciu.",
	);
	editor.append(meta);

	valueHost.append(editor);
}

async function commitParry(sourceMessage, input, previousValue) {
	const value = Number(input.value);
	if (!isD6(value)) {
		input.value = String(previousValue);
		ui.notifications.warn(localize(
			"Parry reduction d6 must be an integer from 1 to 6.",
			"Wynik K6 redukcji parowania musi być liczbą całkowitą od 1 do 6.",
		));
		return;
	}
	if (value === previousValue) return;

	input.readOnly = true;
	try {
		await requestAuthoritativeParryEdit(sourceMessage, value);
		if (input.isConnected) input.value = String(value);
	} catch (error) {
		if (input.isConnected) input.value = String(previousValue);
		console.error("WFRP1ED | Unable to adjudicate dedicated Damage-card parry d6.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the parry reduction die.",
				"Nie udało się zmienić wyniku kości redukcji parowania.",
			),
		);
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditParry(sourceMessage, game.user);
			input.setAttribute("aria-readonly", input.readOnly ? "true" : "false");
		}
	}
}

function requestAuthoritativeParryEdit(sourceMessage, value) {
	if (!canEditParry(sourceMessage, game.user)) {
		return Promise.reject(new Error(localize(
			"You are not allowed to edit this parry reduction roll.",
			"Nie masz uprawnień do edycji tego rzutu redukcji parowania.",
		)));
	}
	if (!game.socket) {
		return Promise.reject(new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		)));
	}
	const gm = primaryActiveGM();
	if (!gm) {
		return Promise.reject(new Error(localize(
			"An active GM is required to edit the parry reduction.",
			"Do edycji redukcji parowania wymagany jest aktywny MG.",
		)));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the parry edit in time.",
				"MG nie rozstrzygnął edycji parowania w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(sourceMessage?.id ?? ""),
			value,
		});
	});
}

function registerSocketResponse() {
	if (!game.socket) return;
	game.socket.on(SOCKET_CHANNEL, (payload) => {
		if (payload?.type !== SOCKET_RESPONSE_TYPE) return;
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const requestId = String(payload.requestId ?? "");
		const pending = pendingRequests.get(requestId);
		if (!pending) return;
		pendingRequests.delete(requestId);
		clearTimeout(pending.timeout);
		if (!payload.ok) {
			pending.reject(new Error(String(payload.error ?? "Unable to edit the parry reduction.")));
			return;
		}
		pending.resolve(payload.result ?? null);
	});
}

function canEditParry(sourceMessage, user) {
	if (!sourceMessage?.id || !user) return false;
	const attack = sourceMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		rollState?.parry?.succeeded !== true ||
		!isD6(rollState?.parry?.reduction) ||
		!damageState?.packet?.id ||
		damageTransactionFor(damageState)
	) return false;
	if (user.isGM) return true;
	const defender = actorFromUuidSync(attack?.target?.uuid);
	return hasOwnerPermission(defender, user);
}

function damageTransactionFor(damageState) {
	if (!damageState?.packet?.id) return null;
	const actor = actorFromUuidSync(damageState.packet.targetActorUuid);
	return actor ? DamageApplication.transactionFor(actor, damageState.packet.id) : null;
}

function findRow(card, expectedLabel) {
	return [...(card.querySelectorAll?.(".wfrp1e-damage-card__row") ?? [])]
		.find((row) => String(row.querySelector?.(":scope > span")?.textContent ?? "").trim() === expectedLabel) ?? null;
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function hasOwnerPermission(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
