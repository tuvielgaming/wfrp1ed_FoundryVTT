import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	canEditCombatDamageDiceTotal,
	requestCombatDamageDiceTotalUpdate,
} from "./CombatDamageIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_PARRY_OVERRIDE_REQUEST_TYPE = "combat-parry-physical-die-request";
const SOCKET_PARRY_OVERRIDE_RESPONSE_TYPE = "combat-parry-physical-die-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/*
 * Physical-dice UI for melee damage dice.
 *
 * CombatDamageIntegration already owns the authoritative adjudication path for
 * damage recalculation. This module exposes that path in the chat card and adds
 * the defender-owned physical d6 editor for a successful parry. The generated
 * Foundry values remain audit data while the adjudicated values drive the pending
 * DamagePacket. Once a damage transaction exists, the corresponding generation
 * is immutable and both editors become read-only.
 *
 * Additional Damage may create an exploding sequence of several d6 rolls. That
 * sequence has different semantics and is deliberately not flattened into the
 * ordinary one-die editor; it is handled as a separate physical-dice audit item.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		decorateBaseDamageDie(message, html);
		decorateParryReductionDie(message, html);
	});
});

Hooks.once("ready", () => registerSocket());

function decorateBaseDamageDie(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		!damageState?.packet?.id
	) return;

	const damageDice = Array.isArray(rollState.damageDice)
		? rollState.damageDice.map(Number).filter(Number.isFinite)
		: [];
	if (damageDice.length !== 1) return;

	const root = asElement(html);
	if (!root) return;

	for (const details of root.querySelectorAll?.(".combat-damage-context__resolved") ?? []) {
		const row = findDetailRow(details, localize("Roll", "Rzut"));
		if (!row) continue;
		const valueHost = row.querySelector?.(":scope > strong");
		if (!valueHost || valueHost.querySelector?.("[data-wfrp-base-damage-d6]")) {
			continue;
		}

		const editable = canEditCombatDamageDiceTotal(message, game.user);
		const current = clampD6(rollState.diceTotal);
		const generated = clampD6(rollState.diceTotalOriginal ?? damageDice[0]);

		valueHost.textContent = "";
		const editor = buildD6Editor({
			current,
			generated,
			editable,
			dataAttribute: "wfrpBaseDamageD6",
			inputDataAttribute: "wfrpBaseDamageD6Input",
			editableTitle: localize(
				"Enter the physical d6 result. Damage is recalculated immediately.",
				"Wpisz wynik fizycznej K6. Obrażenia zostaną natychmiast przeliczone.",
			),
			lockedTitle: localize(
				"This damage die is locked because its damage transaction already exists.",
				"Ta kość obrażeń jest zablokowana, ponieważ transakcja obrażeń już istnieje.",
			),
			auditTitle: localize(
				`Foundry generated ${generated}; the adjudicated physical-die result is shown in the input.`,
				`Foundry wygenerował ${generated}; w polu znajduje się rozstrzygający wynik fizycznej kości.`,
			),
		});
		const input = editor.querySelector("input");
		input?.addEventListener("change", () => {
			void commitBaseDamageDie(message, input, current);
		});
		valueHost.append(editor);
	}
}

function decorateParryReductionDie(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		rollState?.parry?.succeeded !== true ||
		!isD6(rollState?.parry?.reduction) ||
		!damageState?.packet?.id
	) return;

	const root = asElement(html);
	if (!root) return;

	const current = clampD6(rollState.parry.reduction);
	const generated = clampD6(
		rollState.parry.reductionOriginal ?? rollState.parry.reduction,
	);
	const editable = canEditCombatParryReduction(message, game.user);
	const absorbed = nonNegativeInteger(
		damageState?.resolution?.breakdown?.parry?.absorbed,
	);
	const itemName = String(rollState.parry?.itemName ?? "").trim();

	for (const details of root.querySelectorAll?.(".combat-damage-context__resolved") ?? []) {
		const row = findDetailRow(details, localize("Parry", "Parowanie"));
		if (!row) continue;
		const valueHost = row.querySelector?.(":scope > strong");
		if (!valueHost || valueHost.querySelector?.("[data-wfrp-parry-reduction-d6]")) {
			continue;
		}

		valueHost.textContent = "";
		const editor = buildD6Editor({
			current,
			generated,
			editable,
			dataAttribute: "wfrpParryReductionD6",
			inputDataAttribute: "wfrpParryReductionD6Input",
			editableTitle: localize(
				"Enter the defender's physical d6 parry reduction. Pending damage is recalculated immediately.",
				"Wpisz wynik fizycznej K6 redukcji parowania obrońcy. Oczekujące obrażenia zostaną natychmiast przeliczone.",
			),
			lockedTitle: localize(
				"This parry die is locked because its damage transaction already exists.",
				"Ta kość parowania jest zablokowana, ponieważ transakcja obrażeń już istnieje.",
			),
			auditTitle: localize(
				`Foundry generated ${generated}; the adjudicated physical-die result is shown in the input.`,
				`Foundry wygenerował ${generated}; w polu znajduje się rozstrzygający wynik fizycznej kości.`,
			),
		});

		const meta = document.createElement("span");
		meta.className = "wfrp1e-combat-damage-die-editor__meta";
		meta.textContent = localize(
			`→ stopped ${absorbed}${itemName ? ` · ${itemName}` : ""}`,
			`→ zatrzymano ${absorbed}${itemName ? ` · ${itemName}` : ""}`,
		);
		editor.append(meta);

		const input = editor.querySelector("input");
		input?.addEventListener("change", () => {
			void commitParryReductionDie(message, input, current);
		});
		valueHost.append(editor);
	}
}

function buildD6Editor({
	current,
	generated,
	editable,
	dataAttribute,
	inputDataAttribute,
	editableTitle,
	lockedTitle,
	auditTitle,
}) {
	const editor = document.createElement("span");
	editor.className = "wfrp1e-combat-damage-die-editor";
	editor.dataset[dataAttribute] = "";

	const dieLabel = document.createElement("span");
	dieLabel.className = "wfrp1e-combat-damage-die-editor__label";
	dieLabel.textContent = game.i18n.lang === "pl" ? "K6" : "d6";
	editor.append(dieLabel);

	if (generated !== current) {
		const audit = document.createElement("span");
		audit.className = "wfrp1e-combat-damage-die-editor__audit";
		audit.textContent = `${generated} →`;
		audit.title = auditTitle;
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
	input.dataset[inputDataAttribute] = "";
	input.readOnly = !editable;
	input.setAttribute("aria-readonly", editable ? "false" : "true");
	input.title = editable ? editableTitle : lockedTitle;
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") input.blur();
	});

	editor.append(input);
	return editor;
}

async function commitBaseDamageDie(message, input, previousValue) {
	const value = Number(input.value);
	if (!isD6(value)) {
		input.value = String(previousValue);
		ui.notifications.warn(localize(
			"Damage d6 must be an integer from 1 to 6.",
			"Wynik K6 obrażeń musi być liczbą całkowitą od 1 do 6.",
		));
		return;
	}
	if (value === previousValue) return;

	input.readOnly = true;
	try {
		await requestCombatDamageDiceTotalUpdate(message, value);
	} catch (error) {
		input.value = String(previousValue);
		console.error("WFRP1ED | Unable to adjudicate physical melee damage d6.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the damage die.",
				"Nie udało się zmienić wyniku kości obrażeń.",
			),
		);
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditCombatDamageDiceTotal(message, game.user);
		}
	}
}

async function commitParryReductionDie(message, input, previousValue) {
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
		await requestCombatParryReductionUpdate(message, value);
	} catch (error) {
		input.value = String(previousValue);
		console.error("WFRP1ED | Unable to adjudicate physical parry reduction d6.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the parry reduction die.",
				"Nie udało się zmienić wyniku kości redukcji parowania.",
			),
		);
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditCombatParryReduction(message, game.user);
		}
	}
}

async function requestCombatParryReductionUpdate(message, value) {
	const normalized = d6Strict(value, "Parry reduction d6");
	if (!canEditCombatParryReduction(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to edit this parry reduction roll.",
			"Nie masz uprawnień do edycji tego rzutu redukcji parowania.",
		));
	}
	if (game.user?.isGM) {
		return applyParryReductionAsAuthority(message, normalized, game.user);
	}
	return requestGmParryOverride(message, normalized);
}

function canEditCombatParryReduction(message, user = game.user) {
	if (!message?.id || !user) return false;
	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
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

async function applyParryReductionAsAuthority(message, value, requestingUser) {
	if (!canEditCombatParryReduction(message, requestingUser)) {
		throw new Error("The requesting user may not edit this parry reduction roll.");
	}
	const normalized = d6Strict(value, "Parry reduction d6");
	const previous = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? {},
	);
	const current = d6Strict(previous?.parry?.reduction, "Current parry reduction d6");
	if (normalized === current) return previous;

	const updated = foundry.utils.deepClone(previous);
	const generated = d6Strict(
		updated?.parry?.reductionOriginal ?? current,
		"Original parry reduction d6",
	);
	updated.parry = {
		...(updated.parry ?? {}),
		reduction: normalized,
		reductionOriginal: generated,
		reductionOverridden: normalized !== generated,
		reductionOverriddenBy: normalized !== generated
			? String(requestingUser?.id ?? "")
			: null,
		reductionOverriddenAt: normalized !== generated ? Date.now() : null,
	};
	updated.updatedBy = String(requestingUser?.id ?? "");
	updated.updatedAt = Date.now();

	/*
	 * Reuse CombatDamageIntegration's canonical packet/resolver path by replacing
	 * only the persisted parry adjudication and asking it to re-resolve the same
	 * already-adjudicated damage-dice total. No damage formula is duplicated here.
	 */
	await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, updated);
	try {
		await requestCombatDamageDiceTotalUpdate(message, Number(updated.diceTotal));
		const finalState = foundry.utils.deepClone(
			message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? updated,
		);
		preserveDamageOverrideAudit(finalState, updated);
		finalState.updatedBy = String(requestingUser?.id ?? "");
		finalState.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, finalState);
		void ui.chat?.render?.({ force: true });
		return foundry.utils.deepFreeze(foundry.utils.deepClone(finalState));
	} catch (error) {
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, previous).catch(() => {});
		throw error;
	}
}

function preserveDamageOverrideAudit(target, source) {
	if (!target || !source) return;
	target.diceTotalOverridden = source.diceTotalOverridden === true;
	target.diceTotalOverriddenBy = source.diceTotalOverriddenBy ?? null;
	target.diceTotalOverriddenAt = source.diceTotalOverriddenAt ?? null;
}

function registerSocket() {
	if (!game.socket) return;
	game.socket.on(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
}

async function requestGmParryOverride(message, value) {
	if (!game.socket) {
		throw new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		));
	}
	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to edit the parry reduction.",
			"Do edycji redukcji parowania wymagany jest aktywny MG.",
		));
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
			type: SOCKET_PARRY_OVERRIDE_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			value,
		});
	});
}

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === SOCKET_PARRY_OVERRIDE_RESPONSE_TYPE) {
		handleSocketResponse(payload);
		return;
	}
	if (payload.type !== SOCKET_PARRY_OVERRIDE_REQUEST_TYPE || !isPrimaryActiveGM()) {
		return;
	}

	const response = {
		type: SOCKET_PARRY_OVERRIDE_RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		const requester = game.users?.get(String(payload.requestUserId ?? ""));
		const message = game.messages?.get(String(payload.messageId ?? ""));
		if (!requester?.active) throw new Error("The requesting user is not active.");
		if (!message) throw new Error("The requested attack message is unavailable.");
		response.result = await applyParryReductionAsAuthority(
			message,
			payload.value,
			requester,
		);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected physical parry reduction edit.", error);
		response.error = error?.message ?? "Unable to edit the parry reduction.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleSocketResponse(payload) {
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
}

function findDetailRow(details, expectedLabel) {
	return [...(details.querySelectorAll?.(".combat-damage-context__row") ?? [])]
		.find((row) => String(row.querySelector?.(":scope > span")?.textContent ?? "").trim() === expectedLabel) ?? null;
}

function damageTransactionFor(damageState) {
	if (!damageState?.packet?.id) return null;
	const actor = actorFromUuidSync(damageState.packet.targetActorUuid);
	if (!actor) return null;
	return DamageApplication.transactionFor(actor, damageState.packet.id);
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

function isPrimaryActiveGM() {
	return Boolean(game.user?.isGM && primaryActiveGM()?.id === game.user.id);
}

function d6Strict(value, label) {
	const number = Number(value);
	if (!isD6(number)) {
		throw new Error(`${label} must be an integer from 1 to 6.`);
	}
	return number;
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}

function clampD6(value) {
	return isD6(value) ? Number(value) : 1;
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
