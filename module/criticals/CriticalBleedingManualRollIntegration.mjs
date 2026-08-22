import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import { DamagePacket } from "../damage/DamagePacket.mjs";
import { DamageResolution } from "../damage/DamageResolution.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const BLEEDING_ROLL_FLAG_KEY = "criticalBleedingRoll";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "critical-bleeding-roll-edit-request";
const RESPONSE_TYPE = "critical-bleeding-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();
const activeEdits = new Set();
const rearmQueue = new Set();

/*
 * Physical-dice support for periodic Critical-Wound bleeding.
 *
 * CriticalConsequenceEngine still owns the combat clock and the original random
 * roll. For genuinely random periodic formulas (currently Core 1d4 / 1d6), the
 * first DamageChat.applyMessage call is the engine's automatic post-publication
 * call. We intercept exactly that first call, preserve the generated total as
 * audit state, and leave the damage card pending instead of mutating Wounds.
 *
 * The GM or target Actor OWNER may then enter the physical die result and apply
 * the pending damage through the normal DamageChat transaction. Applied damage
 * locks the input. If the GM invalidates that damage, the reverted packet remains
 * immutable audit history and this integration re-arms the same bleeding tick as
 * a fresh packet generation, making both the input and Apply Damage available
 * again without advancing the bleeding clock a second time.
 */
installBleedingApplyDeferral();

Hooks.on("renderChatMessageHTML", (message, html) => {
	installBleedingRollEditor(message, html);
});

Hooks.on("updateChatMessage", (message) => {
	queueRearm(message);
});

Hooks.once("ready", () => {
	registerSocket();
	if (!isPrimaryActiveGm()) return;
	for (const message of game.messages ?? []) queueRearm(message);
});

function installBleedingApplyDeferral() {
	if (DamageChat.__wfrpCriticalBleedingManualInstalled === true) return;

	const originalApplyMessage = DamageChat.applyMessage;
	DamageChat.applyMessage = async function patchedBleedingApplyMessage(message) {
		const state = bleedingDamageState(message);
		const bounds = state ? simpleDiceBounds(state.resolution?.breakdown?.formula) : null;
		const audit = bleedingRollState(message, state);

		/* A random bleeding tick is published and immediately passed back into
		 * DamageChat by CriticalConsequenceEngine. The absence of our audit flag
		 * uniquely identifies that first automatic call for new ticks. Constant
		 * periodic loss (for example 1 Wound/round) remains fully automatic. */
		if (state && bounds && !audit) {
			await initializeBleedingAudit(message, state, bounds);
			return Object.freeze({
				state: "pending-physical-dice",
				packetId: String(state.packet?.id ?? ""),
				amountApplied: 0,
			});
		}

		return originalApplyMessage.call(this, message);
	};

	Object.defineProperty(
		DamageChat,
		"__wfrpCriticalBleedingManualInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

async function initializeBleedingAudit(message, state, bounds) {
	if (!message?.canUserModify?.(game.user, "update")) {
		throw new Error("The authoritative user cannot initialize the bleeding-roll audit state.");
	}
	const generated = Number(state.resolution?.breakdown?.roll ?? state.resolution?.finalAmount);
	if (!Number.isInteger(generated) || generated < bounds.min || generated > bounds.max) {
		throw new Error("The generated bleeding roll is outside its formula range.");
	}

	await message.setFlag(FLAG_SCOPE, BLEEDING_ROLL_FLAG_KEY, {
		version: 1,
		formula: String(state.resolution?.breakdown?.formula ?? ""),
		originalRoll: generated,
		adjudicatedRoll: generated,
		rollEdited: false,
		rollEditedBy: "",
		rollEditedAt: null,
		woundUuid: String(state.resolution?.breakdown?.woundUuid ?? state.packet?.source?.uuid ?? ""),
		effectId: String(state.packet?.source?.id ?? ""),
		cycle: Number(state.resolution?.breakdown?.cycle ?? 0),
		generation: 1,
		originPacketId: String(state.packet?.id ?? ""),
		currentPacketId: String(state.packet?.id ?? ""),
		createdAt: Date.now(),
		createdBy: String(game.user?.id ?? ""),
	});
}

function installBleedingRollEditor(message, html) {
	const state = bleedingDamageState(message);
	if (!state) return;
	const bounds = simpleDiceBounds(state.resolution?.breakdown?.formula);
	if (!bounds) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-critical-bleeding-roll-row]")?.remove();

	const actor = targetActor(state);
	const transaction = actor
		? DamageApplication.transactionFor(actor, state.packet.id)
		: null;
	const editable = Boolean(
		actor &&
		transaction?.state !== "applied" &&
		transaction?.state !== "reverted" &&
		canEditActor(actor, game.user)
	);

	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row wfrp1e-damage-card__roll-row";
	row.dataset.wfrpCriticalBleedingRollRow = "";

	const label = document.createElement("span");
	label.textContent = bleedingRollLabel(state.resolution?.breakdown?.formula);

	const editor = document.createElement("span");
	editor.className = "wfrp1e-damage-roll";

	const dice = document.createElement("span");
	dice.className = "wfrp1e-damage-roll__dice";
	const icon = document.createElement("i");
	icon.className = `fa-solid ${diceIconClass(state.resolution?.breakdown?.formula)} wfrp1e-damage-die`;
	icon.setAttribute("aria-hidden", "true");
	dice.append(icon);

	const input = document.createElement("input");
	input.type = "number";
	input.min = String(bounds.min);
	input.max = String(bounds.max);
	input.step = "1";
	input.inputMode = "numeric";
	input.autocomplete = "off";
	input.className = "wfrp1e-damage-roll__total";
	input.dataset.wfrpCriticalBleedingRollInput = "";
	input.value = String(state.resolution?.finalAmount ?? "");
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;
	input.classList.toggle("is-editable", editable);
	input.classList.toggle("is-readonly", !editable);
	input.title = bleedingInputTitle({ actor, transaction, editable });

	editor.append(dice, input);
	row.append(label, editor);

	const mitigation = card.querySelector(".wfrp1e-damage-card__mitigation");
	if (mitigation) card.insertBefore(row, mitigation);
	else card.append(row);

	if (!editable) return;
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});
	input.addEventListener("change", () => {
		void adjudicateBleedingRoll(message, input);
	});
}

async function adjudicateBleedingRoll(message, input) {
	try {
		const state = bleedingDamageState(message);
		const actor = targetActor(state);
		const bounds = simpleDiceBounds(state?.resolution?.breakdown?.formula);
		if (!state || !actor || !bounds) {
			throw new Error(localize(
				"This bleeding roll is no longer available.",
				"Ten rzut krwawienia nie jest już dostępny.",
			));
		}
		if (!canEditActor(actor, game.user)) {
			throw new Error(localize(
				"Only the GM or an OWNER of the affected Actor may change this bleeding roll.",
				"Tylko MG albo WŁAŚCICIEL poszkodowanego Aktora może zmienić ten rzut krwawienia.",
			));
		}
		const transaction = DamageApplication.transactionFor(actor, state.packet.id);
		if (transaction?.state === "applied") {
			throw new Error(localize(
				"This bleeding damage has already been applied. Invalidate it before changing the roll.",
				"Te obrażenia od krwawienia zostały już zastosowane. Unieważnij je przed zmianą rzutu.",
			));
		}
		if (transaction?.state === "reverted") {
			throw new Error(localize(
				"This reverted bleeding packet is immutable history. Wait for the corrected packet generation.",
				"Ten cofnięty pakiet krwawienia jest niezmienną historią. Poczekaj na nową generację pakietu korekty.",
			));
		}

		const requested = Number(String(input?.value ?? "").trim());
		if (!Number.isInteger(requested) || requested < bounds.min || requested > bounds.max) {
			throw new Error(localize(
				`Enter a whole result from ${bounds.min} to ${bounds.max}.`,
				`Wprowadź całkowity wynik od ${bounds.min} do ${bounds.max}.`,
			));
		}
		if (requested === Number(state.resolution?.finalAmount)) return;

		input.disabled = true;
		if (game.user?.isGM) {
			await commitBleedingRoll(message, requested, game.user);
			return;
		}
		await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error("WFRP1ED | Unable to adjudicate Critical bleeding roll.", error);
		const current = bleedingDamageState(message);
		if (input) input.value = String(current?.resolution?.finalAmount ?? "");
		ui.notifications.error(error?.message ?? localize(
			"Unable to change the bleeding roll.",
			"Nie udało się zmienić rzutu krwawienia.",
		));
	} finally {
		if (input?.isConnected) input.disabled = false;
	}
}

async function commitBleedingRoll(message, value, requestingUser) {
	if (!game.user?.isGM) {
		throw new Error("Critical bleeding roll edits require GM authority.");
	}
	const messageId = String(message?.id ?? "");
	if (!messageId || activeEdits.has(messageId)) {
		throw new Error("This bleeding roll is already being edited.");
	}

	const state = bleedingDamageState(message);
	const actor = targetActor(state);
	const bounds = simpleDiceBounds(state?.resolution?.breakdown?.formula);
	if (!state || !actor || !bounds) throw new Error("The bleeding roll context is unavailable.");
	if (!canEditActor(actor, requestingUser)) {
		throw new Error("The requesting user may not change this bleeding roll.");
	}
	const transaction = DamageApplication.transactionFor(actor, state.packet.id);
	if (transaction?.state === "applied" || transaction?.state === "reverted") {
		throw new Error("This bleeding damage transaction is locked.");
	}

	const requested = Number(value);
	if (!Number.isInteger(requested) || requested < bounds.min || requested > bounds.max) {
		throw new Error("The requested bleeding roll is outside its formula range.");
	}

	activeEdits.add(messageId);
	try {
		const packet = rebuildBleedingPacket(state.packet, requested);
		const breakdown = foundry.utils.deepClone(state.resolution?.breakdown ?? {});
		breakdown.roll = requested;
		breakdown.adjudicatedRoll = requested;
		const resolution = DamageResolution.forPacket(packet, {
			finalAmount: requested,
			breakdown,
			resolvedAt: state.resolution?.resolvedAt,
		});

		const updated = foundry.utils.deepClone(state);
		updated.packet = packet.toJSON();
		updated.resolution = resolution.toJSON();
		updated.application = null;
		updated.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
		updated.updatedAt = Date.now();

		const audit = bleedingRollState(message, state) ?? defaultAuditState(state);
		const originalRoll = Number(audit.originalRoll ?? state.resolution?.breakdown?.roll ?? requested);
		const updatedAudit = {
			...foundry.utils.deepClone(audit),
			version: 1,
			originalRoll,
			adjudicatedRoll: requested,
			rollEdited: requested !== originalRoll,
			rollEditedBy: requested !== originalRoll ? String(requestingUser?.id ?? "") : "",
			rollEditedAt: requested !== originalRoll ? Date.now() : null,
			currentPacketId: packet.id,
			updatedAt: Date.now(),
			updatedBy: String(requestingUser?.id ?? game.user?.id ?? ""),
		};

		const content = await DamageChat._render(updated, actor, null);
		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${DAMAGE_STATE_FLAG_KEY}`]: updated,
			[`flags.${FLAG_SCOPE}.${BLEEDING_ROLL_FLAG_KEY}`]: updatedAudit,
		});
		void ui.chat?.render?.({ force: true });
		return Object.freeze({
			messageId,
			packetId: packet.id,
			roll: requested,
			originalRoll,
		});
	} finally {
		activeEdits.delete(messageId);
	}
}

function rebuildBleedingPacket(packetState, amount, id = null) {
	return new DamagePacket({
		id: id ?? packetState.id,
		rawAmount: amount,
		targetActorUuid: packetState.targetActorUuid,
		source: foundry.utils.deepClone(packetState.source),
		armour: packetState.mitigation?.armour,
		toughness: packetState.mitigation?.toughness,
		hitLocation: packetState.hitLocation,
		specialMitigation: foundry.utils.deepClone(packetState.mitigation?.special ?? {}),
		criticalMode: packetState.critical?.mode,
		createdAt: packetState.createdAt,
	});
}

function queueRearm(message) {
	if (!isPrimaryActiveGm() || !message?.id || rearmQueue.has(message.id)) return;
	const state = bleedingDamageState(message);
	if (!state) return;
	const actor = targetActor(state);
	if (!actor) return;
	const transaction = DamageApplication.transactionFor(actor, state.packet.id);
	if (transaction?.state !== "reverted") return;

	const woundUuid = String(
		bleedingRollState(message, state)?.woundUuid ??
		state.resolution?.breakdown?.woundUuid ??
		state.packet?.source?.uuid ??
		"",
	).trim();
	const wound = documentFromUuidSync(woundUuid);
	if (!(wound instanceof foundry.documents.Item) || wound.type !== "criticalWound") return;

	rearmQueue.add(message.id);
	queueMicrotask(() => {
		void rearmBleedingMessage(message)
			.catch((error) => console.error("WFRP1ED | Unable to re-arm reverted Critical bleeding damage.", error))
			.finally(() => rearmQueue.delete(message.id));
	});
}

async function rearmBleedingMessage(message) {
	const state = bleedingDamageState(message);
	const actor = targetActor(state);
	if (!state || !actor) return false;
	const transaction = DamageApplication.transactionFor(actor, state.packet.id);
	if (transaction?.state !== "reverted") return false;

	const audit = bleedingRollState(message, state) ?? defaultAuditState(state);
	const generation = Math.max(1, Number(audit.generation) || 1) + 1;
	const amount = Number(state.resolution?.finalAmount);
	const nextPacketId = `${String(audit.originPacketId ?? state.packet.id)}-retry-${generation}-${foundry.utils.randomID(6)}`;
	const packet = rebuildBleedingPacket(state.packet, amount, nextPacketId);
	const breakdown = foundry.utils.deepClone(state.resolution?.breakdown ?? {});
	breakdown.roll = amount;
	breakdown.adjudicatedRoll = amount;
	breakdown.rearmedFromPacketId = String(state.packet.id ?? "");
	breakdown.generation = generation;
	const resolution = DamageResolution.forPacket(packet, {
		finalAmount: amount,
		breakdown,
		resolvedAt: Date.now(),
	});

	const updated = DamageChat._state(packet, resolution, "standalone", actor.name);
	updated.createdBy = String(state.createdBy ?? game.user?.id ?? "");
	updated.createdAt = Number(state.createdAt) || Date.now();
	updated.updatedBy = String(game.user?.id ?? "");
	updated.updatedAt = Date.now();
	updated.rearmedFromPacketId = String(state.packet.id ?? "");

	const updatedAudit = {
		...foundry.utils.deepClone(audit),
		generation,
		currentPacketId: packet.id,
		rearmedFromPacketId: String(state.packet.id ?? ""),
		rearmedAt: Date.now(),
		updatedAt: Date.now(),
		updatedBy: String(game.user?.id ?? ""),
	};
	const content = await DamageChat._render(updated, actor, null);
	await message.update({
		content,
		[`flags.${FLAG_SCOPE}.${DAMAGE_STATE_FLAG_KEY}`]: updated,
		[`flags.${FLAG_SCOPE}.${BLEEDING_ROLL_FLAG_KEY}`]: updatedAudit,
	});
	void ui.chat?.render?.({ force: true });
	return true;
}

async function requestOwnerEdit(message, roll) {
	const state = bleedingDamageState(message);
	const actor = targetActor(state);
	if (!actor || !canEditActor(actor, game.user)) {
		throw new Error("You may not change this bleeding roll.");
	}
	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to save a player's physical bleeding roll.",
			"Aktywny MG jest wymagany, aby zapisać fizyczny rzut krwawienia gracza.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Critical bleeding roll edit request timed out."));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requesterUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			roll: Number(roll),
		});
	});
}

function registerSocket() {
	if (!game.socket) return;
	game.socket.on(SOCKET_CHANNEL, (payload) => {
		void handleSocketPayload(payload);
	});
}

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requesterUserId ?? "") !== String(game.user?.id ?? "")) return;
		const pending = pendingRequests.get(String(payload.requestId ?? ""));
		if (!pending) return;
		pendingRequests.delete(String(payload.requestId ?? ""));
		clearTimeout(pending.timeout);
		if (payload.ok) pending.resolve(payload.result ?? null);
		else pending.reject(new Error(String(payload.error ?? "Unable to edit Critical bleeding roll.")));
		return;
	}
	if (payload.type !== REQUEST_TYPE || !isPrimaryActiveGm()) return;

	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requesterUserId: String(payload.requesterUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		const requester = game.users?.get(response.requesterUserId);
		if (!requester?.active) throw new Error("The requesting user is no longer active.");
		const message = game.messages?.get(String(payload.messageId ?? ""));
		if (!message) throw new Error("The bleeding damage message is no longer available.");
		response.result = await commitBleedingRoll(message, Number(payload.roll), requester);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected Critical bleeding roll edit request.", error);
		response.error = error?.message ?? "Unable to edit Critical bleeding roll.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

function bleedingDamageState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		state.packet?.source?.kind === "critical-bleeding" &&
		state.packet &&
		state.resolution
		? state
		: null;
}

function bleedingRollState(message, state = bleedingDamageState(message)) {
	const audit = message?.getFlag?.(FLAG_SCOPE, BLEEDING_ROLL_FLAG_KEY);
	if (audit && typeof audit === "object" && !Array.isArray(audit)) {
		return foundry.utils.deepClone(audit);
	}
	return null;
}

function defaultAuditState(state) {
	const generated = Number(state?.resolution?.breakdown?.roll ?? state?.resolution?.finalAmount ?? 0);
	return {
		version: 1,
		formula: String(state?.resolution?.breakdown?.formula ?? ""),
		originalRoll: generated,
		adjudicatedRoll: Number(state?.resolution?.finalAmount ?? generated),
		rollEdited: false,
		rollEditedBy: "",
		rollEditedAt: null,
		woundUuid: String(state?.resolution?.breakdown?.woundUuid ?? state?.packet?.source?.uuid ?? ""),
		effectId: String(state?.packet?.source?.id ?? ""),
		cycle: Number(state?.resolution?.breakdown?.cycle ?? 0),
		generation: 1,
		originPacketId: String(state?.packet?.id ?? ""),
		currentPacketId: String(state?.packet?.id ?? ""),
	};
}

function targetActor(state) {
	try {
		const document = foundry.utils.fromUuidSync(String(state?.packet?.targetActorUuid ?? ""));
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
		return null;
	} catch (_error) {
		return null;
	}
}

function canEditActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	);
}

function simpleDiceBounds(formula) {
	const normalized = String(formula ?? "").trim().toLowerCase().replaceAll(" ", "");
	const match = /^(\d*)d(\d+)$/.exec(normalized);
	if (!match) return null;
	const count = Number(match[1] || 1);
	const faces = Number(match[2]);
	if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(faces) || faces <= 1) return null;
	return { min: count, max: count * faces, count, faces };
}

function bleedingRollLabel(formula) {
	const bounds = simpleDiceBounds(formula);
	if (!bounds) return localize("Bleeding roll", "Rzut krwawienia");
	const notation = `${bounds.count === 1 ? "" : bounds.count}${game.i18n.lang === "pl" ? "K" : "d"}${bounds.faces}`;
	return localize(`Bleeding roll ${notation}`, `Rzut krwawienia ${notation}`);
}

function bleedingInputTitle({ actor, transaction, editable }) {
	if (editable) {
		return localize(
			"Enter the physical bleeding-die result before applying the damage. The generated total remains in audit history.",
			"Wprowadź wynik fizycznej kości krwawienia przed zastosowaniem obrażeń. Wygenerowany wynik pozostaje w historii audytowej.",
		);
	}
	if (transaction?.state === "applied") {
		return localize(
			"This bleeding damage is applied, so its roll is locked.",
			"Te obrażenia od krwawienia zostały zastosowane, więc rzut jest zablokowany.",
		);
	}
	if (transaction?.state === "reverted") {
		return localize(
			"This packet was reverted and is immutable audit history.",
			"Ten pakiet został cofnięty i stanowi niezmienną historię audytową.",
		);
	}
	return actor
		? localize(
			"Only the GM or an OWNER of the affected Actor may replace this roll.",
			"Tylko MG albo WŁAŚCICIEL poszkodowanego Aktora może zmienić ten rzut.",
		)
		: localize("The target Actor is unavailable.", "Poszkodowany Aktor jest niedostępny.");
}

function diceIconClass(formula) {
	const faces = simpleDiceBounds(formula)?.faces;
	if ([4, 6, 8, 10, 12, 20].includes(faces)) return `fa-dice-d${faces}`;
	return "fa-dice";
}

function documentFromUuidSync(uuid) {
	try {
		return foundry.utils.fromUuidSync(String(uuid ?? ""));
	} catch (_error) {
		return null;
	}
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	const gm = primaryActiveGm();
	return Boolean(game.user?.isGM && gm && String(gm.id) === String(game.user.id));
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
