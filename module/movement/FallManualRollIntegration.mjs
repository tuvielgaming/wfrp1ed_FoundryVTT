import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "fall-roll-edit-request";
const RESPONSE_TYPE = "fall-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/*
 * Physical-dice support for WFRP 1e Falling / Upadek.
 *
 * FallMovementIntegration owns the audited Core rule. This module changes only
 * how its visible reduction d6 may be adjudicated:
 * - the native Foundry Roll attached to the ChatMessage remains the audit roll;
 * - the persisted movement snapshot is the mechanical/adjudicated result;
 * - GM or Actor OWNER may enter a physical d6 result from 1 to 6;
 * - Actor-owner edits are committed by the primary active GM over the system
 *   socket;
 * - pending Fall damage is rebuilt immediately from the entered result;
 * - applied damage locks the d6 until the damage is invalidated/reverted;
 * - once the dependent held-items check has started/resolved, the source Fall
 *   roll is locked so an already-created consequence cannot be orphaned;
 * - a Fall cancelled by its source climbing lifecycle is immutable history.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	activateFallEditor(message, html);
});

Hooks.once("ready", () => {
	registerSocket();
});

function activateFallEditor(message, html) {
	const state = movementState(message);
	if (state?.kind !== "fall") return;

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	const section = card.querySelector(".wfrp1e-test-card__breakdown-section");
	const rows = section
		? [...section.querySelectorAll(".wfrp1e-test-card__breakdown-row")]
		: [];
	/* FallMovementIntegration owns this layout: row 3 is the audited d6 row. */
	const value = rows[3]?.querySelector("strong");
	if (!(value instanceof HTMLElement)) return;

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "6";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(state.die ?? "");
	input.dataset.wfrpMovementRollValue = "";
	input.dataset.wfrpMovementKind = "fall";
	input.classList.add("wfrp1e-test-card__modifier-input");
	value.replaceWith(input);

	const lockReason = editLockReason(message, state);
	if (lockReason || !canEdit(message, game.user)) {
		input.readOnly = true;
		input.tabIndex = -1;
		input.classList.add("is-readonly");
		input.title = lockReason || localize(
			"Only the GM or an OWNER of this Actor can replace the Fall d6 result.",
			"Tylko MG albo Właściciel tego Aktora może zmienić wynik K6 Upadku.",
		);
		return;
	}

	input.classList.add("is-editable");
	input.title = localize(
		"Enter the physical d6 result (1-6), then press Enter or leave the field. Fall damage is recalculated without rerolling.",
		"Wprowadź wynik fizycznego K6 (1-6), a następnie naciśnij Enter lub opuść pole. Obrażenia od Upadku zostaną przeliczone bez ponownego rzutu.",
	);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
	input.addEventListener("change", () => {
		void setFallRollValue(message, input);
	});
}

async function setFallRollValue(message, input) {
	try {
		const state = movementState(message);
		if (state?.kind !== "fall") {
			throw new Error("This ChatMessage has no Fall result.");
		}
		if (!canEdit(message, game.user)) {
			throw new Error(editDeniedMessage(message, state));
		}

		const raw = String(input?.value ?? "").trim();
		const requested = Number(raw);
		if (!raw || !Number.isInteger(requested) || requested < 1 || requested > 6) {
			throw new Error(localize(
				"Enter a whole d6 result from 1 to 6.",
				"Wprowadź całkowity wynik K6 od 1 do 6.",
			));
		}

		if (game.user?.isGM) {
			await commitFallRollValue(message, requested, game.user);
			return;
		}
		await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit Fall d6.", error);
		const current = movementState(message);
		if (input) input.value = String(current?.die ?? "");
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the Fall d6 result.",
				"Nie można zmienić wyniku K6 Upadku.",
			),
		);
	}
}

async function commitFallRollValue(message, value, requestingUser) {
	if (!game.user?.isGM) {
		throw new Error("Fall roll edits require GM authority.");
	}

	const state = movementState(message);
	if (state?.kind !== "fall") {
		throw new Error("This ChatMessage has no editable Fall roll.");
	}
	if (!canEdit(message, requestingUser)) {
		throw new Error(editDeniedMessage(message, state));
	}

	const die = Number(value);
	if (!Number.isInteger(die) || die < 1 || die > 6) {
		throw new Error("Fall d6 must be a whole value from 1 to 6.");
	}

	const updated = foundry.utils.deepClone(state);
	const originalDie = normalizedOriginalDie(state);
	updated.version = Math.max(2, Number(updated.version) || 0);
	updated.originalDie = originalDie;
	updated.die = die;
	updated.rollEdited = die !== originalDie;
	updated.rollEditedBy = updated.rollEdited
		? String(requestingUser?.id ?? "")
		: "";
	updated.rollEditedAt = updated.rollEdited ? Date.now() : null;
	updated.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
	updated.updatedAt = Date.now();

	await MovementStandardTest._updateMessageState(message, updated);
	await synchronizeFallDamage(message, updated);

	return Object.freeze({
		messageId: String(message.id ?? ""),
		die,
		originalDie,
		rollEdited: updated.rollEdited,
	});
}

async function synchronizeFallDamage(message, state) {
	const existingDamage = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	if (state?.cancelled === true) {
		if (existingDamage) await message.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
		return;
	}

	const wounds = fallWounds(state);
	if (wounds <= 0) {
		if (existingDamage) await message.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
		return;
	}

	const actor = actorForState(state);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The Actor for this Fall result is unavailable.");
	}

	const packet = new DamagePacket({
		rawAmount: wounds,
		targetActorUuid: actor.uuid,
		source: {
			kind: "movement-procedure",
			id: "fall",
			uuid: String(message?.uuid ?? ""),
			label: localize("Fall", "Upadek"),
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
	});
	const resolution = DamageResolver.resolve(packet);
	await DamageChat.attach(message, { packet, resolution });
}

function canEdit(message, user = game.user) {
	const state = movementState(message);
	if (state?.kind !== "fall" || !user) return false;
	if (editLockReason(message, state)) return false;
	if (user.isGM) return true;

	const actor = actorForState(state);
	return actor?.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function editLockReason(message, state = movementState(message)) {
	if (state?.kind !== "fall") return "";
	if (state.cancelled === true) {
		return localize(
			"This Fall was cancelled by its source climbing lifecycle and is read-only history.",
			"Ten Upadek został anulowany przez źródłową sekwencję wspinaczki i jest historią tylko do odczytu.",
		);
	}

	if (
		String(state?.heldItemsPhase ?? "pending") !== "pending" ||
		String(state?.heldItemsCheckMessageId ?? "").trim()
	) {
		return localize(
			"The dependent held-items check has already started or resolved. Resolve/invalidate that dependent consequence before changing the source Fall roll.",
			"Zależny test utrzymania przedmiotów został już rozpoczęty lub rozstrzygnięty. Przed zmianą źródłowego rzutu Upadku trzeba najpierw cofnąć lub unieważnić tę zależną konsekwencję.",
		);
	}

	const transaction = attachedDamageTransaction(message, state);
	if (transaction?.state === "applied") {
		return localize(
			"Fall damage has already been applied. Revert or invalidate that damage transaction before changing the d6 result.",
			"Obrażenia od Upadku zostały już zastosowane. Przed zmianą wyniku K6 cofnij lub unieważnij tę transakcję obrażeń.",
		);
	}
	return "";
}

function attachedDamageTransaction(message, state) {
	const damage = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const packetId = String(damage?.packet?.id ?? "").trim();
	if (!packetId) return null;
	const actor = actorForState(state);
	return actor instanceof foundry.documents.Actor
		? DamageApplication.transactionFor(actor, packetId)
		: null;
}

function editDeniedMessage(message, state) {
	return editLockReason(message, state) || localize(
		"Only the GM or an OWNER of this Actor can change the Fall d6 result.",
		"Tylko MG albo Właściciel tego Aktora może zmienić wynik K6 Upadku.",
	);
}

function fallWounds(state) {
	const doubledHeight = finiteNumber(state?.doubledHeight, "fall doubled height");
	const die = finiteNumber(state?.die, "fall d6");
	const acrobaticsBonus = finiteNumber(
		state?.acrobaticsBonus ?? 0,
		"fall Acrobatics bonus",
	);
	return Math.max(0, doubledHeight - (die + acrobaticsBonus));
}

function movementState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function actorForState(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function normalizedOriginalDie(state) {
	const value = Number(state?.originalDie ?? state?.die);
	if (!Number.isInteger(value) || value < 1 || value > 6) {
		throw new Error(`Invalid original Fall d6 value: ${String(value)}.`);
	}
	return value;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be finite: ${String(value)}.`);
	}
	return number;
}

async function requestOwnerEdit(message, die) {
	if (!canEdit(message, game.user)) {
		throw new Error(editDeniedMessage(message, movementState(message)));
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to save an Actor owner's manual Fall d6 result.",
			"MG musi być połączony, aby zapisać ręczny wynik K6 Upadku wprowadzony przez właściciela Aktora.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Fall roll edit request timed out."));
		}, SOCKET_TIMEOUT_MS);

		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			die,
		});
	});
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (payload) => {
		if (!payload || typeof payload !== "object") return;
		if (payload.type === RESPONSE_TYPE) {
			handleResponse(payload);
			return;
		}
		if (payload.type !== REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			requestUserId: String(payload.requestUserId ?? ""),
		};
		try {
			const message = game.messages?.get(String(payload.messageId ?? ""));
			const user = game.users?.get(String(payload.requestUserId ?? ""));
			if (!message) throw new Error("Requested Fall ChatMessage is unavailable.");
			if (!user?.active) throw new Error("Requesting user is not active.");
			response.result = await commitFallRollValue(message, payload.die, user);
		} catch (error) {
			response.error = error instanceof Error ? error.message : String(error);
		}
		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleResponse(payload) {
	if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;

	clearTimeout(pending.timeout);
	pendingRequests.delete(requestId);
	if (payload.error) {
		pending.reject(new Error(String(payload.error)));
		return;
	}
	pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
