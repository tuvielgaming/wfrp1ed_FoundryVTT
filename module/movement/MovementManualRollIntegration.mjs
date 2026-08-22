import { DamageApplication } from "../damage/DamageApplication.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "movement-roll-edit-request";
const RESPONSE_TYPE = "movement-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/*
 * Physical-dice policy for primary movement procedure rolls.
 *
 * Jump (Zeskok) uses 1d6. Leap (Skok) uses either 1d6 with a run-up or 2d6
 * without one. Foundry's native Roll remains attached to the ChatMessage as the
 * audit roll; the persisted movement snapshot becomes the adjudicated result.
 *
 * Manual editing is intentionally lifecycle-aware:
 * - GM or OWNER of the represented Actor may enter a physical result;
 * - Actor-owner writes are committed by the primary active GM over the system
 *   socket, matching other editable mechanical rolls;
 * - Jump damage is recalculated immediately while it is still pending;
 * - an applied Jump damage transaction locks the source roll until the damage is
 *   reverted/invalidated;
 * - once the dependent held-items check has started/resolved, Jump is locked so
 *   changing its source roll cannot orphan an already-created consequence;
 * - Leap has no materialized world-state consequence in this subsystem, so its
 *   total remains editable within the physical range of its original formula.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	activateMovementRollEditor(message, html);
});

Hooks.once("ready", () => {
	registerSocket();
});

function activateMovementRollEditor(message, html) {
	const state = movementState(message);
	if (!state || !new Set(["jump", "leap"]).has(String(state.kind ?? ""))) {
		return;
	}

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	const input = state.kind === "jump"
		? installJumpEditor(card, state)
		: installLeapEditor(card, state);
	if (!(input instanceof HTMLInputElement)) return;

	const lockReason = editLockReason(message, state);
	if (lockReason || !canEdit(message, game.user)) {
		input.readOnly = true;
		input.tabIndex = -1;
		input.classList.remove("is-editable");
		input.classList.add("is-readonly");
		input.title = lockReason || localize(
			"Only the GM or an OWNER of this Actor can replace this movement roll.",
			"Tylko MG albo Właściciel tego Aktora może zmienić wynik tego rzutu ruchowego.",
		);
		return;
	}

	input.readOnly = false;
	input.classList.remove("is-readonly");
	input.classList.add("is-editable");
	input.title = editorHint(state);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
	input.addEventListener("change", () => {
		void setMovementRollValue(message, input);
	});
}

function installJumpEditor(card, state) {
	const metric = card.querySelector(".wfrp1e-test-card__metric");
	const value = metric?.querySelector("strong");
	if (!(value instanceof HTMLElement)) return null;

	const input = rollInput(state, state.die, 1, 6);
	value.replaceWith(input);
	return input;
}

function installLeapEditor(card, state) {
	const section = card.querySelector(".wfrp1e-test-card__breakdown-section");
	const rows = section
		? [...section.querySelectorAll(".wfrp1e-test-card__breakdown-row")]
		: [];
	/* MovementStandardTest owns this layout: row 2 is the audited Dice row. */
	const value = rows[2]?.querySelector("strong");
	if (!(value instanceof HTMLElement)) return null;

	const min = state.runUp === true ? 1 : 2;
	const max = state.runUp === true ? 6 : 12;
	const wrapper = document.createElement("span");
	wrapper.classList.add("wfrp1e-movement-roll-editor");

	const formula = document.createElement("span");
	formula.classList.add("wfrp1e-movement-roll-editor__formula");
	formula.textContent = `${localizedDiceFormula(state.diceFormula)}:`;

	const input = rollInput(state, state.dice, min, max);
	wrapper.append(formula, input);
	value.replaceWith(wrapper);
	return input;
}

function rollInput(state, value, min, max) {
	const input = document.createElement("input");
	input.type = "number";
	input.min = String(min);
	input.max = String(max);
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.value = String(value ?? "");
	input.dataset.wfrpMovementRollValue = "";
	input.dataset.wfrpMovementKind = String(state.kind ?? "");
	input.classList.add("wfrp1e-test-card__modifier-input");
	return input;
}

async function setMovementRollValue(message, input) {
	try {
		const state = movementState(message);
		if (!state) throw new Error("This message has no movement result state.");
		if (!canEdit(message, game.user)) {
			throw new Error(editDeniedMessage(message, state));
		}

		const range = physicalRange(state);
		const raw = String(input?.value ?? "").trim();
		const requested = Number(raw);
		if (
			!raw ||
			!Number.isInteger(requested) ||
			requested < range.min ||
			requested > range.max
		) {
			throw new Error(rangeError(state, range));
		}

		if (game.user?.isGM) {
			await commitMovementRollValue(message, requested, game.user);
			return;
		}

		await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit movement roll.", error);
		const current = movementState(message);
		if (input) {
			input.value = String(
				current?.kind === "jump" ? current?.die ?? "" : current?.dice ?? "",
			);
		}
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the movement roll.",
				"Nie można zmienić wyniku rzutu ruchowego.",
			),
		);
	}
}

async function commitMovementRollValue(message, value, requestingUser) {
	if (!game.user?.isGM) {
		throw new Error("Movement roll edits require GM authority.");
	}

	const state = movementState(message);
	if (!state || !new Set(["jump", "leap"]).has(String(state.kind ?? ""))) {
		throw new Error("This ChatMessage has no editable Jump/Leap roll.");
	}
	if (!canEdit(message, requestingUser)) {
		throw new Error(editDeniedMessage(message, state));
	}

	const range = physicalRange(state);
	const requested = Number(value);
	if (
		!Number.isInteger(requested) ||
		requested < range.min ||
		requested > range.max
	) {
		throw new Error(rangeError(state, range));
	}

	const updated = foundry.utils.deepClone(state);
	updated.version = Math.max(4, Number(updated.version) || 0);
	const original = originalRoll(state);

	if (state.kind === "jump") {
		updated.originalDie = original;
		updated.die = requested;
	} else {
		updated.originalDice = original;
		updated.dice = requested;
	}

	updated.rollEdited = requested !== original;
	updated.rollEditedBy = updated.rollEdited
		? String(requestingUser?.id ?? "")
		: "";
	updated.rollEditedAt = updated.rollEdited ? Date.now() : null;
	updated.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
	updated.updatedAt = Date.now();

	await MovementStandardTest._updateMessageState(message, updated);
	if (updated.kind === "jump") {
		await MovementStandardTest._synchronizeJumpDamage(message, updated);
	}

	return Object.freeze({
		messageId: String(message.id ?? ""),
		kind: String(updated.kind),
		roll: requested,
		originalRoll: original,
		rollEdited: updated.rollEdited,
	});
}

function canEdit(message, user = game.user) {
	const state = movementState(message);
	if (!state || !user) return false;
	if (editLockReason(message, state)) return false;
	if (user.isGM) return true;

	const actor = actorForState(state);
	return actor?.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function editLockReason(message, state = movementState(message)) {
	if (state?.kind !== "jump") return "";

	if (
		String(state?.heldItemsPhase ?? "pending") !== "pending" ||
		String(state?.heldItemsCheckMessageId ?? "").trim()
	) {
		return localize(
			"The dependent held-items check has already started or resolved. Resolve/invalidate that dependent consequence before changing the source Jump roll.",
			"Zależny test utrzymania przedmiotów został już rozpoczęty lub rozstrzygnięty. Przed zmianą źródłowego rzutu Zeskoku trzeba najpierw cofnąć lub unieważnić tę zależną konsekwencję.",
		);
	}

	const transaction = attachedDamageTransaction(message, state);
	if (transaction?.state === "applied") {
		return localize(
			"Jump damage has already been applied. Revert or invalidate that damage transaction before changing the d6 result.",
			"Obrażenia z Zeskoku zostały już zastosowane. Przed zmianą wyniku K6 cofnij lub unieważnij tę transakcję obrażeń.",
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
		"Only the GM or an OWNER of this Actor can change this movement roll.",
		"Tylko MG albo Właściciel tego Aktora może zmienić wynik tego rzutu ruchowego.",
	);
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

function physicalRange(state) {
	if (state?.kind === "jump") return { min: 1, max: 6 };
	if (state?.kind === "leap" && state.runUp === true) return { min: 1, max: 6 };
	if (state?.kind === "leap") return { min: 2, max: 12 };
	throw new Error(`Unsupported movement roll kind '${String(state?.kind)}'.`);
}

function originalRoll(state) {
	const value = Number(
		state?.kind === "jump"
			? state?.originalDie ?? state?.die
			: state?.originalDice ?? state?.dice,
	);
	const range = physicalRange(state);
	if (!Number.isInteger(value) || value < range.min || value > range.max) {
		throw new Error(`Invalid original movement roll value: ${String(value)}.`);
	}
	return value;
}

function editorHint(state) {
	const range = physicalRange(state);
	const dice = state?.kind === "jump"
		? localizedDiceFormula("1d6")
		: localizedDiceFormula(state?.diceFormula);
	return localize(
		`Enter the physical ${dice} result (${range.min}-${range.max}), then press Enter or leave the field. The movement result is recalculated without rerolling.`,
		`Wprowadź wynik fizycznego rzutu ${dice} (${range.min}-${range.max}), a następnie naciśnij Enter lub opuść pole. Wynik ruchu zostanie przeliczony bez ponownego rzutu.`,
	);
}

function rangeError(state, range) {
	const dice = state?.kind === "jump"
		? localizedDiceFormula("1d6")
		: localizedDiceFormula(state?.diceFormula);
	return localize(
		`Enter a whole ${dice} result from ${range.min} to ${range.max}.`,
		`Wprowadź całkowity wynik ${dice} od ${range.min} do ${range.max}.`,
	);
}

function localizedDiceFormula(formula) {
	const text = String(formula ?? "");
	return game.i18n.lang === "pl"
		? text.replaceAll("d", "K")
		: text;
}

async function requestOwnerEdit(message, roll) {
	if (!canEdit(message, game.user)) {
		throw new Error(editDeniedMessage(message, movementState(message)));
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to save an Actor owner's manual movement roll.",
			"MG musi być połączony, aby zapisać ręczny wynik rzutu ruchowego wprowadzony przez właściciela Aktora.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Movement roll edit request timed out."));
		}, SOCKET_TIMEOUT_MS);

		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			roll,
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
			if (!message) throw new Error("Requested movement ChatMessage is unavailable.");
			if (!user?.active) throw new Error("Requesting user is not active.");
			response.result = await commitMovementRollValue(message, payload.roll, user);
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
