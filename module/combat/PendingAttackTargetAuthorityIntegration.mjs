import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PENDING_FLAG_KEYS = Object.freeze([
	"pendingCombatAttack",
	"pendingRangedCombatAttack",
]);
const TARGET_SELECTION_PENDING = "__pending__";
const TARGET_SELECTION_NONE = "__none__";
const TARGET_MODE_PENDING = "pending";
const TARGET_MODE_NONE = "none";
const TARGET_MODE_DEFENDER = "defender";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "pending-attack-target-selection-request";
const RESPONSE_TYPE = "pending-attack-target-selection-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingRequests = new Map();
let socketRegistered = false;

Hooks.once("ready", () => registerSocket());
Hooks.on("renderChatMessageHTML", (message, html) => {
	installPlayerAuthorityBridge(message, asElement(html));
});

/**
 * Foundry ChatMessages are not writable merely because a player owns the Actor
 * represented by the card. Pending attack cards are often GM-authored, so an
 * Actor owner changing the target must ask an active GM client to persist the
 * ChatMessage update. GM users keep the existing direct update path.
 *
 * Capture-phase listeners intercept only non-GM target changes before the
 * PendingCombatAttack/PendingRangedCombatAttack bubble listeners can call
 * ChatMessage.update locally and trigger Foundry's permission error.
 */
function installPlayerAuthorityBridge(message, rendered) {
	if (game.user?.isGM) return;
	const card = pendingCardFromElement(rendered);
	if (!card) return;

	const entry = pendingEntry(message);
	if (!entry) return;
	const actor = ActorTargetResolver.actorFromUuidSync(entry.request.actorUuid);
	if (!canResolveActor(actor, game.user)) return;

	const select = card.querySelector("[data-pending-attack-scene-target]");
	if (select instanceof HTMLSelectElement) {
		select.addEventListener("change", (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			select.blur();
			void requestSelectionChange(message, select.value).catch(reportPlayerError);
		}, true);
	}

	card.addEventListener("click", (event) => {
		const button = event.target?.closest?.(
			'[data-pending-attack-action="clear-target"]',
		);
		if (!(button instanceof HTMLButtonElement) || !card.contains(button)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		button.blur();
		void requestSelectionChange(message, TARGET_SELECTION_PENDING).catch(reportPlayerError);
	}, true);
}

function registerSocket() {
	if (socketRegistered || !game.socket) return;
	socketRegistered = true;
	game.socket.on(SOCKET_CHANNEL, (payload) => {
		void handleSocketPayload(payload);
	});
}

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;

	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.userId ?? "") !== String(game.user?.id ?? "")) return;
		const requestId = String(payload.requestId ?? "");
		const pending = pendingRequests.get(requestId);
		if (!pending) return;
		pendingRequests.delete(requestId);
		clearTimeout(pending.timeoutId);
		if (payload.ok === true) pending.resolve(true);
		else pending.reject(new Error(String(payload.error ?? localize(
			"Unable to change the pending attack target.",
			"Nie udało się zmienić celu oczekującego ataku.",
		))));
		return;
	}

	if (payload.type !== REQUEST_TYPE || !game.user?.isGM) return;
	if (String(payload.gmUserId ?? "") !== String(game.user?.id ?? "")) return;

	let response;
	try {
		await applySelectionAsGM(payload);
		response = {
			type: RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			userId: String(payload.requestingUserId ?? ""),
			ok: true,
		};
	} catch (error) {
		console.error("WFRP1ED | Unable to persist player pending-attack target selection.", error);
		response = {
			type: RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			userId: String(payload.requestingUserId ?? ""),
			ok: false,
			error: String(error?.message ?? error ?? "Unknown pending target error"),
		};
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function requestSelectionChange(message, value) {
	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A connected GM is required to change the target of this pending attack.",
			"Do zmiany celu tego oczekującego ataku wymagany jest połączony MG.",
		));
	}

	const entry = pendingEntry(message);
	if (!entry) {
		throw new Error(localize(
			"This pending attack is no longer available.",
			"Ten oczekujący atak nie jest już dostępny.",
		));
	}

	const requestId = foundry.utils.randomID();
	const promise = new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not confirm the target change in time.",
				"MG nie potwierdził zmiany celu w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeoutId });
	});

	game.socket.emit(SOCKET_CHANNEL, {
		type: REQUEST_TYPE,
		requestId,
		gmUserId: String(gm.id ?? ""),
		requestingUserId: String(game.user?.id ?? ""),
		messageId: String(message?.id ?? ""),
		flagKey: entry.flagKey,
		value: String(value ?? TARGET_SELECTION_PENDING),
		sceneId: String(canvas?.scene?.id ?? ""),
	});

	return promise;
}

async function applySelectionAsGM(payload) {
	const messageId = String(payload.messageId ?? "");
	const message = game.messages?.get(messageId);
	if (!message) throw new Error("The pending attack ChatMessage no longer exists.");

	const entry = pendingEntry(message);
	if (!entry || entry.flagKey !== String(payload.flagKey ?? "")) {
		throw new Error("The pending attack state no longer matches the target request.");
	}

	const requestingUser = game.users?.get(String(payload.requestingUserId ?? ""));
	const actor = ActorTargetResolver.actorFromUuidSync(entry.request.actorUuid);
	if (!requestingUser || !canResolveActor(actor, requestingUser)) {
		throw new Error(localize(
			"Only the attacker owner or a GM can change this target.",
			"Tylko właściciel atakującego albo MG może zmienić ten cel.",
		));
	}

	const selection = validatedSelection(
		String(payload.value ?? TARGET_SELECTION_PENDING),
		String(payload.sceneId ?? ""),
	);
	const updated = foundry.utils.deepClone(entry.request);
	updated.selection = selection;
	updated.updatedBy = String(requestingUser.id ?? "");
	updated.updatedAt = Date.now();

	await message.update({
		content: updatePendingCardContent(message.content, selection),
		[`flags.${FLAG_SCOPE}.${entry.flagKey}`]: updated,
	});
}

function validatedSelection(value, sceneId) {
	if (value === TARGET_SELECTION_PENDING) {
		return {
			targetMode: TARGET_MODE_PENDING,
			targetUuid: "",
			targetName: "",
		};
	}
	if (value === TARGET_SELECTION_NONE) {
		return {
			targetMode: TARGET_MODE_NONE,
			targetUuid: "",
			targetName: localize("No defender / object", "Bez obrońcy / obiekt"),
		};
	}

	const target = visibleSceneTarget(sceneId, value);
	if (!target) {
		throw new Error(localize(
			"The selected scene token is no longer available to target.",
			"Wybrany token ze sceny nie jest już dostępny jako cel.",
		));
	}
	return {
		targetMode: TARGET_MODE_DEFENDER,
		targetUuid: target.actorUuid,
		targetName: target.name,
	};
}

function visibleSceneTarget(sceneId, actorUuid) {
	const scene = game.scenes?.get(String(sceneId ?? ""));
	if (!scene) return null;
	const requestedUuid = String(actorUuid ?? "");
	for (const token of scene.tokens?.contents ?? []) {
		if (token?.hidden === true) continue;
		const actor = token?.actor;
		if (String(actor?.uuid ?? "") !== requestedUuid) continue;
		return {
			actorUuid: requestedUuid,
			name: String(token.name ?? actor?.name ?? "—"),
		};
	}
	return null;
}

function updatePendingCardContent(content, selection) {
	const wrapper = document.createElement("div");
	wrapper.innerHTML = String(content ?? "");
	const card = pendingCardFromElement(wrapper);
	if (!card) throw new Error("The pending attack ChatMessage content is invalid.");

	const status = card.querySelector(".pending-combat-attack__target-status span");
	if (status) {
		status.textContent = selection.targetMode === TARGET_MODE_PENDING
			? localize("Not selected", "Nie wybrano")
			: String(selection.targetName || "—");
	}

	const resolved = selection.targetMode === TARGET_MODE_DEFENDER ||
		selection.targetMode === TARGET_MODE_NONE;
	const roll = card.querySelector('[data-pending-attack-action="roll"]');
	if (roll instanceof HTMLButtonElement) {
		roll.dataset.targetResolved = String(resolved);
	}
	return wrapper.innerHTML;
}

function pendingEntry(message) {
	for (const flagKey of PENDING_FLAG_KEYS) {
		const request = message?.getFlag?.(FLAG_SCOPE, flagKey);
		if (request?.status === "pending") return { flagKey, request };
	}
	return null;
}

function canResolveActor(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function primaryActiveGM() {
	return [...(game.users?.contents ?? [])]
		.filter((user) => user?.active === true && user?.isGM === true)
		.sort((first, second) => String(first.id ?? "").localeCompare(String(second.id ?? "")))
		.at(0) ?? null;
}

function pendingCardFromElement(rendered) {
	return rendered?.matches?.("[data-wfrp-pending-combat-attack]")
		? rendered
		: rendered?.querySelector?.("[data-wfrp-pending-combat-attack]") ?? null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportPlayerError(error) {
	console.error("WFRP1ED | Unable to resolve pending attack target through GM authority.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to change the pending attack target.",
		"Nie udało się zmienić celu oczekującego ataku.",
	));
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
		? polish
		: english;
}
