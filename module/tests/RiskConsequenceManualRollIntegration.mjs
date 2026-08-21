import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RISK_STATE_FLAG_KEY = "riskConsequenceState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "risk-d3-edit-request";
const RESPONSE_TYPE = "risk-d3-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/*
 * Physical-dice policy for the Risk consequence D3.
 *
 * The generic Risk d100 is already editable through TestResult roll editing.
 * This integration applies the same contract to the secondary D3 which is
 * rolled only after a failed Risk Test:
 * - GM or OWNER of the represented Actor may enter a physical D3 result;
 * - Actor-owner writes are GM-authoritative through the system socket;
 * - the persisted Risk snapshot is the adjudicated value used by mechanics;
 * - the original generated value is retained as `originalDie` for audit;
 * - once the corresponding damage transaction has actually been applied, the
 *   D3 is read-only until that world-state consequence is reverted/invalidated.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	activateRiskD3Editor(message, html);
});

Hooks.once("ready", () => {
	registerSocket();
});

function activateRiskD3Editor(message, html) {
	const state = riskState(message);
	if (!state?.active) return;

	const root = asElement(html);
	const block = root?.matches?.("[data-wfrp-risk-consequence]")
		? root
		: root?.querySelector?.("[data-wfrp-risk-consequence]");
	if (!(block instanceof HTMLElement)) return;

	const value = block.querySelector(".wfrp1e-risk-consequence__value");
	if (!(value instanceof HTMLElement)) return;

	const editor = document.createElement("span");
	editor.classList.add(
		"wfrp1e-risk-consequence__value",
		"wfrp1e-risk-consequence__die-editor",
	);

	const prefix = document.createElement("span");
	prefix.textContent = game.i18n.lang === "pl" ? "K3 =" : "D3 =";

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "3";
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(state.die ?? "");
	input.dataset.wfrpRiskD3Value = "";
	input.classList.add("wfrp1e-test-card__modifier-input");

	const suffix = document.createElement("span");
	suffix.textContent = game.i18n.lang === "pl"
		? "obrażenia"
		: Number(state.die) === 1 ? "Wound" : "Wounds";

	const lockReason = editLockReason(message, state);
	if (lockReason || !canEdit(message, game.user)) {
		input.readOnly = true;
		input.tabIndex = -1;
		input.classList.add("is-readonly");
		input.title = lockReason || localize(
			"Only the GM or an OWNER of this Actor can replace the D3 result.",
			"Tylko MG albo Właściciel tego Aktora może zmienić wynik K3.",
		);
	} else {
		input.classList.add("is-editable");
		input.title = localize(
			"Enter a D3 result from 1 to 3, then press Enter or leave the field. This supports physical dice and recalculates the pending Risk damage.",
			"Wprowadź wynik K3 od 1 do 3, a następnie naciśnij Enter lub opuść pole. Umożliwia to użycie fizycznych kości i przelicza oczekujące obrażenia z Testu Ryzyka.",
		);
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			input.blur();
		});
		input.addEventListener("change", () => {
			void setRiskD3Value(message, input);
		});
	}

	editor.append(prefix, input, suffix);
	value.replaceWith(editor);
}

async function setRiskD3Value(message, input) {
	try {
		const state = riskState(message);
		if (!state?.active) {
			throw new Error(localize(
				"This Risk consequence is no longer active.",
				"Ta konsekwencja Testu Ryzyka nie jest już aktywna.",
			));
		}
		if (!canEdit(message, game.user)) {
			throw new Error(editDeniedMessage(message, state));
		}

		const raw = String(input?.value ?? "").trim();
		const requested = Number(raw);
		if (!raw || !Number.isInteger(requested) || requested < 1 || requested > 3) {
			throw new Error(localize(
				"Enter a whole D3 result from 1 to 3.",
				"Wprowadź całkowity wynik K3 od 1 do 3.",
			));
		}

		if (game.user?.isGM) {
			await commitRiskD3Value(message, requested, game.user);
			return;
		}

		await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit Risk D3.", error);
		const current = riskState(message);
		if (input) input.value = String(current?.die ?? "");
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the Risk D3 result.",
				"Nie można zmienić wyniku K3 Testu Ryzyka.",
			),
		);
	}
}

async function commitRiskD3Value(message, value, requestingUser) {
	if (!game.user?.isGM) {
		throw new Error("Risk D3 edits require GM authority.");
	}

	const state = riskState(message);
	if (!state?.active) {
		throw new Error("This message has no active Risk consequence.");
	}
	if (!canEdit(message, requestingUser)) {
		throw new Error(editDeniedMessage(message, state));
	}

	const die = Number(value);
	if (!Number.isInteger(die) || die < 1 || die > 3) {
		throw new Error("Risk consequence D3 must be a whole value from 1 to 3.");
	}

	const actor = actorForState(state);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The Actor for this Risk consequence is not available.");
	}

	const lockReason = editLockReason(message, state);
	if (lockReason) throw new Error(lockReason);

	const updated = foundry.utils.deepClone(state);
	const originalDie = normalizedOriginalDie(state);
	updated.originalDie = originalDie;
	updated.die = die;
	updated.dieEdited = die !== originalDie;
	updated.dieEditedBy = updated.dieEdited
		? String(requestingUser?.id ?? "")
		: "";
	updated.dieEditedAt = updated.dieEdited ? Date.now() : null;
	updated.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
	updated.updatedAt = Date.now();

	await message.setFlag(
		FLAG_SCOPE,
		RISK_STATE_FLAG_KEY,
		updated,
	);

	/*
	 * Risk damage is attached to the same ChatMessage. Before application it is
	 * safe to replace that immutable packet snapshot with one resolved from the
	 * adjudicated physical D3. Keep the same packet id so the consequence remains
	 * one transaction identity rather than manufacturing a new damage event.
	 */
	const packet = new DamagePacket({
		id: String(updated.packetId ?? ""),
		rawAmount: die,
		targetActorUuid: actor.uuid,
		source: riskDamageSource(message),
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		createdAt: Number(updated.rolledAt) || Date.now(),
	});
	const resolution = DamageResolver.resolve(packet);
	await DamageChat.attach(message, { packet, resolution });

	return Object.freeze({
		messageId: String(message.id ?? ""),
		die,
		originalDie,
		dieEdited: updated.dieEdited,
	});
}

function riskDamageSource(message) {
	const damage = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const source = damage?.packet?.source;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		return foundry.utils.deepClone(source);
	}

	return {
		kind: "standard-test",
		id: "risk",
		uuid: String(message?.uuid ?? ""),
		label: localize("Risk", "Ryzyko"),
	};
}

function canEdit(message, user = game.user) {
	const state = riskState(message);
	if (!state?.active || !user) return false;
	if (editLockReason(message, state)) return false;
	if (user.isGM) return true;

	const actor = actorForState(state);
	return actor?.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function editLockReason(message, state = riskState(message)) {
	const actor = actorForState(state);
	if (!(actor instanceof foundry.documents.Actor)) return "";
	const transaction = DamageApplication.transactionFor(
		actor,
		String(state?.packetId ?? ""),
	);
	return transaction?.state === "applied"
		? localize(
			"Risk damage has already been applied. Revert or invalidate that damage transaction before changing the D3 result.",
			"Obrażenia z Testu Ryzyka zostały już zastosowane. Przed zmianą wyniku K3 cofnij lub unieważnij tę transakcję obrażeń.",
		)
		: "";
}

function editDeniedMessage(message, state) {
	return editLockReason(message, state) || localize(
		"Only the GM or an OWNER of this Actor can change the D3 result.",
		"Tylko MG albo Właściciel tego Aktora może zmienić wynik K3.",
	);
}

function riskState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, RISK_STATE_FLAG_KEY);
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
	if (!Number.isInteger(value) || value < 1 || value > 3) {
		throw new Error(`Invalid original Risk D3 value: ${String(value)}.`);
	}
	return value;
}

async function requestOwnerEdit(message, die) {
	if (!canEdit(message, game.user)) {
		throw new Error(editDeniedMessage(message, riskState(message)));
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to save an Actor owner's manual D3 result.",
			"MG musi być połączony, aby zapisać ręczny wynik K3 wprowadzony przez właściciela Aktora.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Risk D3 edit request timed out."));
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
			if (!message) throw new Error("Requested Risk ChatMessage is unavailable.");
			if (!user?.active) throw new Error("Requesting user is not active.");
			response.result = await commitRiskD3Value(message, payload.die, user);
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
		.filter((user) => user.active && user.isGM)
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
