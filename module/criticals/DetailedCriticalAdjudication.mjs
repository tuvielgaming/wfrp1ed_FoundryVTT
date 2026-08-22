import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	detailedCriticalEffectText,
	DETAILED_CRITICAL_OUTCOME,
	isCoreDetailedEffectProvider,
} from "./CoreDetailedCriticalTables.mjs";
import { CriticalWoundApplication } from "./CriticalWoundApplication.mjs";
import { DetailedCriticalResolver } from "./DetailedCriticalResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const ROLL_SELECTOR = "[data-wfrp-detailed-critical-roll-input]";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "detailed-critical-roll-edit-request";
const RESPONSE_TYPE = "detailed-critical-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const activeEdits = new Set();
const pendingRequests = new Map();

/*
 * Physical-dice support for the detailed Critical Hit d100.
 *
 * CriticalBootstrap/DetailedCriticalIntegration own the initial random Roll and
 * publish it as a normal roll-bearing ChatMessage. This layer changes only the
 * adjudicated table total:
 * - the GM or the same player who was allowed to resolve the source damage's
 *   detailed Critical may enter a physical d100 result;
 * - player edits are committed by the primary active GM because the authoritative
 *   criticalResolution belongs to the target Actor's damage transaction;
 * - the original Foundry Roll remains untouched for audit;
 * - dependent table text/outcome are recalculated from the fixed entered value;
 * - once the result has materialized a persistent Critical Wound, an applied
 *   fatal consequence, or Fate expenditure, the d100 locks. Those are world-state
 *   transaction boundaries and must be invalidated/reverted through their own
 *   lifecycle before another critical result can be chosen safely.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const state = detailedResultState(message);
		if (!state) return;

		const root = asElement(html);
		const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
			? root
			: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
		if (!card) return;

		installCriticalRollEditor(message, state, card);
	});
});

/* Actor-side fatal/Fate transactions and persistent Critical Wound creation can
 * change the edit lock without rewriting the result ChatMessage. Refresh visible
 * editors at those boundaries so the UI follows the authoritative state. */
Hooks.on("updateActor", (actor) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	requestAnimationFrame(() => refreshActorDetailedEditors(actor));
});

for (const hookName of ["createItem", "deleteItem"]) {
	Hooks.on(hookName, (item) => {
		if (item?.type !== "criticalWound") return;
		const actor = item.parent;
		if (!(actor instanceof foundry.documents.Actor)) return;
		requestAnimationFrame(() => refreshActorDetailedEditors(actor));
	});
}

Hooks.once("ready", () => registerSocket());

function installCriticalRollEditor(message, state, card) {
	const host = card.querySelector("[data-wfrp-detailed-roll]");
	if (!(host instanceof HTMLElement)) return;

	let input = host.querySelector(ROLL_SELECTOR);
	if (!(input instanceof HTMLInputElement)) {
		host.textContent = "";
		host.classList.add("wfrp1e-critical-result__roll-editor");

		const label = document.createElement("span");
		label.className = "wfrp1e-critical-result__roll-label";
		label.textContent = game.i18n.lang === "pl" ? "K100" : "d100";

		input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "100";
		input.step = "1";
		input.inputMode = "numeric";
		input.autocomplete = "off";
		input.dataset.wfrpDetailedCriticalRollInput = "";
		input.className = "wfrp1e-critical-result__roll-input";

		host.append(label, input);
	}

	const context = detailedCriticalContext(message, state);
	input.value = String(state.resolution?.roll?.total ?? "");
	const lockReason = editLockReason(context);
	const editable = Boolean(context && !lockReason && canEdit(context, game.user));
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;
	input.classList.toggle("is-editable", editable);
	input.classList.toggle("is-readonly", !editable);
	input.title = editable
		? localize(
			"Enter a physical d100 result from 1 to 100. The detailed critical table result will be recalculated without rerolling.",
			"Wprowadź wynik fizycznego K100 od 1 do 100. Wynik szczegółowej tabeli trafień krytycznych zostanie przeliczony bez ponownego rzutu.",
		)
		: lockReason || localize(
			"Only the GM or the player who caused the source damage may replace this detailed critical d100 result.",
			"Tylko MG albo gracz, który spowodował źródłowe obrażenia, może zmienić ten wynik K100 szczegółowego trafienia krytycznego.",
		);

	if (!editable || input.dataset.wfrpCriticalEditorBound === "true") return;
	input.dataset.wfrpCriticalEditorBound = "true";

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});

	input.addEventListener("change", () => {
		void adjudicateCriticalRoll(message, input);
	});
}

async function adjudicateCriticalRoll(message, input) {
	try {
		const context = detailedCriticalContext(message);
		if (!context) {
			throw new Error(localize(
				"This ChatMessage has no active detailed critical result.",
				"Ta wiadomość nie zawiera aktywnego szczegółowego trafienia krytycznego.",
			));
		}
		if (!canEdit(context, game.user)) {
			throw new Error(editLockReason(context) || localize(
				"You may not change this detailed critical d100 result.",
				"Nie możesz zmienić tego wyniku K100 szczegółowego trafienia krytycznego.",
			));
		}

		const raw = String(input?.value ?? "").trim();
		const requested = Number(raw);
		if (
			!raw ||
			!Number.isInteger(requested) ||
			requested < 1 ||
			requested > 100
		) {
			throw new Error(localize(
				"Enter a whole d100 result from 1 to 100.",
				"Wprowadź całkowity wynik K100 od 1 do 100.",
			));
		}

		if (Number(context.result.resolution?.roll?.total) === requested) return;

		input.disabled = true;
		if (game.user?.isGM) {
			await commitDetailedCriticalRoll(message, requested, game.user);
			return;
		}

		await requestOwnerEdit(message, requested);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to adjudicate detailed critical d100.",
			error,
		);
		const current = detailedResultState(message);
		if (input) input.value = String(current?.resolution?.roll?.total ?? "");
		ui.notifications.error(error?.message ?? localize(
			"Unable to change the detailed critical result.",
			"Nie udało się zmienić wyniku szczegółowego trafienia krytycznego.",
		));
	} finally {
		if (input?.isConnected) input.disabled = false;
	}
}

async function commitDetailedCriticalRoll(message, value, requestingUser) {
	if (!game.user?.isGM) {
		throw new Error("Detailed critical roll edits require GM authority.");
	}

	const messageId = String(message?.id ?? "");
	if (!messageId) throw new Error("The detailed critical result message is unavailable.");
	if (activeEdits.has(messageId)) {
		throw new Error("This detailed critical result is already being edited.");
	}

	const context = detailedCriticalContext(message);
	if (!context) {
		throw new Error("This ChatMessage has no detailed critical result.");
	}
	if (!canEdit(context, requestingUser)) {
		throw new Error(editLockReason(context) ||
			"The requesting user may not change this detailed critical result.");
	}

	const requested = Number(value);
	if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
		throw new Error("Detailed critical d100 must be a whole value from 1 to 100.");
	}
	if (Number(context.result.resolution?.roll?.total) === requested) {
		return Object.freeze({
			messageId,
			roll: requested,
			unchanged: true,
		});
	}

	activeEdits.add(messageId);
	try {
		const generated = await DetailedCriticalResolver.resolve(
			Number(context.transaction.criticalValue),
			String(context.damage?.packet?.hitLocation ?? ""),
			{
				/* Fixed adjudicated value: this is not another random Roll. */
				roll: {
					formula: "1d100",
					total: requested,
				},
			},
		);
		const resolution = foundry.utils.deepClone(generated);
		/* The primary GM performs the authoritative write for a player request, but
		 * audit fields identify the user who actually entered the physical die. */
		resolution.resolvedBy = String(requestingUser?.id ?? game.user?.id ?? "");
		resolution.resolvedAt = Date.now();

		await DamageApplication.replaceCriticalResolution({
			actor: context.actor,
			packetId: context.packetId,
			criticalResolution: resolution,
			user: game.user,
		});

		const updatedState = foundry.utils.deepClone(context.result);
		const originalRoll = normalizedOriginalRoll(context.result);
		updatedState.version = Math.max(3, Number(updatedState.version) || 0);
		updatedState.originalRoll = originalRoll;
		updatedState.rollEdited = requested !== originalRoll;
		updatedState.rollEditedBy = updatedState.rollEdited
			? String(requestingUser?.id ?? "")
			: "";
		updatedState.rollEditedAt = updatedState.rollEdited ? Date.now() : null;
		updatedState.resolution = foundry.utils.deepClone(resolution);
		updatedState.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
		updatedState.updatedAt = Date.now();

		await message.setFlag(
			FLAG_SCOPE,
			CRITICAL_RESULT_FLAG_KEY,
			updatedState,
		);

		void ui.chat?.render?.({ force: true });
		return Object.freeze({
			messageId,
			roll: requested,
			originalRoll,
			rollEdited: updatedState.rollEdited,
			outcome: String(resolution?.outcome ?? ""),
		});
	} finally {
		activeEdits.delete(messageId);
	}
}

function detailedCriticalContext(message, knownState = detailedResultState(message)) {
	const result = knownState;
	if (!result) return null;

	const sourceMessage = game.messages?.get(String(result.sourceMessageId ?? ""));
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const actor = actorFromDamageState(damage);
	if (!(actor instanceof foundry.documents.Actor)) return null;

	const packetId = String(result.packetId ?? damage?.packet?.id ?? "").trim();
	if (!packetId) return null;

	return {
		message,
		result,
		sourceMessage,
		damage,
		actor,
		packetId,
		transaction: DamageApplication.transactionFor(actor, packetId),
		wound: CriticalWoundApplication.existingForResolution(
			actor,
			{ resultMessageId: message.id },
		),
		fatalApplication: applicationMap(actor, FATAL_APPLICATIONS_FLAG_KEY)[packetId] ?? null,
		fateIntervention: applicationMap(actor, FATE_INTERVENTIONS_FLAG_KEY)[packetId] ?? null,
	};
}

function canEdit(context, user) {
	if (!context || !user || editLockReason(context)) return false;
	if (user.isGM) return true;

	const sourceUser = sourceUserId(context.sourceMessage, context.damage);
	return Boolean(sourceUser && sourceUser === String(user.id ?? ""));
}

function editLockReason(context) {
	if (!context) return "";
	if (
		context.transaction?.state !== "applied" ||
		!context.transaction?.criticalResolution
	) {
		return localize(
			"The source damage transaction no longer has an active detailed critical resolution.",
			"Źródłowa transakcja obrażeń nie ma już aktywnego rozstrzygnięcia szczegółowego trafienia krytycznego.",
		);
	}
	if (context.fateIntervention) {
		return localize(
			"A Fate Point has already been spent for this critical result. Its d100 is now immutable history.",
			"Dla tego trafienia krytycznego wydano już Punkt Przeznaczenia. Jego K100 jest teraz niezmienną historią.",
		);
	}
	if (context.fatalApplication?.state === "applied") {
		return localize(
			"This fatal critical has already been applied. Invalidate/revert that fatal consequence before changing its d100.",
			"To śmiertelne trafienie krytyczne zostało już zastosowane. Unieważnij/cofnij tę śmiertelną konsekwencję przed zmianą jej K100.",
		);
	}
	if (context.wound) {
		return localize(
			"This detailed result has already been applied as a persistent Critical Wound. Invalidate that critical first so its world-state consequences can be reverted safely.",
			"Ten szczegółowy wynik został już zastosowany jako trwała Rana Krytyczna. Najpierw unieważnij trafienie krytyczne, aby bezpiecznie cofnąć jego konsekwencje w świecie.",
		);
	}
	return "";
}

function normalizedOriginalRoll(result) {
	const value = Number(result?.originalRoll ?? result?.resolution?.roll?.total);
	if (!Number.isInteger(value) || value < 1 || value > 100) {
		throw new Error(`Invalid original detailed critical d100 value: ${String(value)}.`);
	}
	return value;
}

function sourceUserId(message, state) {
	return String(
		state?.createdBy ??
		message?.user?.id ??
		message?.author?.id ??
		"",
	).trim();
}

async function requestOwnerEdit(message, roll) {
	const context = detailedCriticalContext(message);
	if (!canEdit(context, game.user)) {
		throw new Error(editLockReason(context) ||
			"You may not change this detailed critical result.");
	}

	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to save a player's physical detailed-critical d100 result.",
			"MG musi być połączony, aby zapisać fizyczny wynik K100 szczegółowego trafienia krytycznego wprowadzony przez gracza.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Detailed critical roll edit request timed out."));
		}, SOCKET_TIMEOUT_MS);

		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requesterUserId: String(game.user?.id ?? ""),
			resultMessageId: String(message?.id ?? ""),
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
		if (String(payload.requesterUserId ?? "") !== String(game.user?.id ?? "")) {
			return;
		}
		const pending = pendingRequests.get(String(payload.requestId ?? ""));
		if (!pending) return;
		pendingRequests.delete(String(payload.requestId ?? ""));
		clearTimeout(pending.timeout);
		if (payload.ok) pending.resolve(payload.result ?? null);
		else pending.reject(new Error(String(payload.error ?? "Unable to edit detailed critical d100.")));
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
		if (!requester?.active) {
			throw new Error("The requesting user is no longer active.");
		}
		const message = game.messages?.get(String(payload.resultMessageId ?? ""));
		if (!message) throw new Error("The detailed critical result message is no longer available.");

		const context = detailedCriticalContext(message);
		if (!canEdit(context, requester)) {
			throw new Error(editLockReason(context) ||
				"The requesting user may not change this detailed critical result.");
		}

		response.result = await commitDetailedCriticalRoll(
			message,
			Number(payload.roll),
			requester,
		);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected detailed critical roll edit request.", error);
		response.error = error?.message ?? "Unable to edit detailed critical d100.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function refreshActorDetailedEditors(actor) {
	for (const message of game.messages ?? []) {
		const context = detailedCriticalContext(message);
		if (context?.actor?.uuid !== actor.uuid) continue;

		for (const hostDocument of renderedHostDocuments()) {
			const entry = hostDocument.querySelector?.(
				`[data-message-id="${cssEscape(String(message.id ?? ""))}"]`,
			);
			if (!entry) continue;
			const card = entry.matches?.("[data-wfrp-detailed-critical-card]")
				? entry
				: entry.querySelector?.("[data-wfrp-detailed-critical-card]");
			if (card) installCriticalRollEditor(message, context.result, card);
		}
	}
}

function renderedHostDocuments() {
	const documents = new Set([document]);
	const instances = foundry.applications?.instances;
	if (instances?.values) {
		for (const application of instances.values()) {
			const hostDocument = application?.element?.ownerDocument;
			if (hostDocument?.querySelector) documents.add(hostDocument);
		}
	}
	return documents;
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

function applicationMap(actor, key) {
	const existing = actor?.getFlag?.(FLAG_SCOPE, key);
	return existing && typeof existing === "object" && !Array.isArray(existing)
		? foundry.utils.deepClone(existing)
		: {};
}

function detailedResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		state.kind === "detailed" &&
		state.resolution
		? state
		: null;
}

function actorFromDamageState(state) {
	try {
		const document = foundry.utils.fromUuidSync(
			String(state?.packet?.targetActorUuid ?? ""),
		);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
		return null;
	} catch (_error) {
		return null;
	}
}

function effectTextForClient(resolution) {
	if (
		isCoreDetailedEffectProvider(resolution?.effect?.providerId) &&
		resolution?.effectLocation &&
		Number.isInteger(Number(resolution?.effectNumber))
	) {
		return detailedCriticalEffectText(
			String(resolution.effectLocation),
			Number(resolution.effectNumber),
			game.i18n.lang,
		);
	}
	return String(resolution?.effect?.text ?? "").trim();
}

function woundName(resolution) {
	return `${localize("Critical Wound", "Rana krytyczna")} — ${hitLocationLabel(
		resolution?.hitLocation,
	)} ${resolution?.effectNumber ?? ""}`.trim();
}

function hitLocationLabel(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "head": return localize("Head", "Głowa");
		case "rightArm": return localize("Right Arm", "Prawa ręka");
		case "leftArm": return localize("Left Arm", "Lewa ręka");
		case "body": return localize("Body", "Korpus");
		case "rightLeg": return localize("Right Leg", "Prawa noga");
		case "leftLeg": return localize("Left Leg", "Lewa noga");
		default: return localize("Unknown location", "Nieznana lokacja");
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape
		? CSS.escape(text)
		: text.replace(/["\\]/g, "\\$&");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
