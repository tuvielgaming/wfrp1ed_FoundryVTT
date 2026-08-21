import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";
import { LootPileService } from "../loot/LootPileService.mjs";
import { HeldItemsCheck } from "./HeldItemsCheck.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "heldItemsCheck";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "held-items-drop-apply-request";
const RESPONSE_TYPE = "held-items-drop-apply-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

const CONSEQUENCE_KIND = "drop-held-items";
const CONSEQUENCE_STATE = Object.freeze({
	PENDING: "pending",
	APPLYING: "applying",
	APPLIED: "applied",
	NO_ITEMS: "no-items",
});

/*
 * Complete the physical consequence of the Core Jump/Fall held-items check.
 *
 * HeldItemsCheck owns the d100, manual/physical-dice editing, and Luck semantics.
 * LootPileService owns authoritative Item moves, GM socket routing, and ground-
 * pile chat. This integration connects the two contracts only after the d100 has
 * been accepted:
 *
 *   d100 <= 50 -> user explicitly resolves the pending physical Item drop.
 *
 * The previous implementation moved Items immediately after Foundry generated
 * the d100. That made physical dice unsafe: if Foundry rolled 01-50 first, the
 * world state changed before the player had a chance to type the real tabletop
 * result. The drop is now a visible pending consequence. The GM/Actor owner may
 * edit the d100 first, then apply the Item move only if the final result still
 * says DROP.
 *
 * Applying the world mutation is GM-authoritative and has an explicit APPLYING
 * phase. Manual edits and Luck are locked during that phase and after an APPLIED
 * physical move, preventing the chat snapshot from diverging from world state.
 * A failed check with no held physical Items remains adjustable because no
 * external mutation occurred.
 */
installHeldItemsLootIntegration();

function installHeldItemsLootIntegration() {
	if (HeldItemsCheck.__wfrpLootIntegrationInstalled === true) return;

	const originalLuckOptions = HeldItemsCheck.luckOptions;
	const originalRollEditLockReason = HeldItemsCheck._rollEditLockReason;

	HeldItemsCheck.luckOptions = function heldItemsLuckAfterPhysicalConsequence(message) {
		const state = this.stateFor(message);
		const consequenceState = String(state?.consequence?.state ?? "");
		if (
			state?.consequence?.kind === CONSEQUENCE_KIND &&
			[
				CONSEQUENCE_STATE.APPLYING,
				CONSEQUENCE_STATE.APPLIED,
			].includes(consequenceState)
		) {
			return [];
		}
		return originalLuckOptions.call(this, message);
	};

	HeldItemsCheck._rollEditLockReason = function heldItemsWorldStateRollLock(state) {
		if (
			state?.consequence?.kind === CONSEQUENCE_KIND &&
			state?.consequence?.state === CONSEQUENCE_STATE.APPLYING
		) {
			return localize(
				"The physical held-item drop is being resolved. Wait for that world-state transaction to finish before changing the d100 result.",
				"Trwa rozstrzyganie fizycznego upuszczenia trzymanych przedmiotów. Poczekaj na zakończenie tej zmiany stanu świata przed zmianą wyniku K100.",
			);
		}
		return originalRollEditLockReason.call(this, state);
	};

	Hooks.on("renderChatMessageHTML", (message, html) => {
		decorateDropConsequence(message, html);
	});

	Hooks.once("ready", () => {
		if (game.socket) {
			game.socket.on(
				SOCKET_CHANNEL,
				(payload) => void handleSocketPayload(payload),
			);
		}
	});

	Object.defineProperty(
		HeldItemsCheck,
		"__wfrpLootIntegrationInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function decorateDropConsequence(message, html) {
	const state = HeldItemsCheck.stateFor(message);
	if (!state) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-held-items-card]")
		? root
		: root?.querySelector?.("[data-wfrp-held-items-card]");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-held-items-drop-action]")?.remove();

	if (String(state.outcome ?? "") !== "drop") return;
	if (state?.consequence?.kind !== CONSEQUENCE_KIND) return;

	const block = document.createElement("section");
	block.className = "wfrp1e-movement-consequence";
	block.dataset.wfrpHeldItemsDropAction = "";

	const consequenceState = String(state.consequence?.state ?? "");
	if (consequenceState === CONSEQUENCE_STATE.APPLYING) {
		block.append(statusElement(localize(
			"Resolving the held-item drop…",
			"Trwa rozstrzyganie upuszczenia trzymanych przedmiotów…",
		)));
		card.append(block);
		return;
	}

	if (consequenceState === CONSEQUENCE_STATE.APPLIED) {
		block.append(statusElement(localize(
			"Held items have been moved to a Loot Pile. This d100 is now read-only until that world-state consequence is reversed.",
			"Trzymane przedmioty przeniesiono do Stosu Łupów. Ten wynik K100 jest teraz tylko do odczytu, dopóki ta zmiana stanu świata nie zostanie cofnięta.",
		)));
		card.append(block);
		return;
	}

	if (consequenceState === CONSEQUENCE_STATE.NO_ITEMS) {
		block.append(statusElement(localize(
			"The result says DROP, but the Actor had no physical held Items to move when the consequence was resolved.",
			"Wynik oznacza UPUSZCZA, ale podczas rozstrzygania konsekwencji Aktor nie miał żadnych fizycznych trzymanych przedmiotów do przeniesienia.",
		)));
		card.append(block);
		return;
	}

	if (consequenceState !== CONSEQUENCE_STATE.PENDING) return;

	const actor = actorFromStateSync(state);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1e-movement-consequence__action";
	button.textContent = localize(
		"Resolve dropped held items",
		"Rozstrzygnij upuszczenie trzymanych przedmiotów",
	);
	button.title = localize(
		"Use this only after accepting the d100 result. If physical dice were used, enter that result above first.",
		"Użyj dopiero po zaakceptowaniu wyniku K100. Jeśli użyto fizycznych kości, najpierw wpisz ich wynik powyżej.",
	);

	if (!canRequestApply(actor)) {
		button.disabled = true;
		button.title = localize(
			"Only the GM or an OWNER of this Actor can resolve the Item drop.",
			"Tylko MG albo Właściciel tego Aktora może rozstrzygnąć upuszczenie przedmiotów.",
		);
	} else {
		button.addEventListener("click", (event) => {
			event.preventDefault();
			button.disabled = true;
			void requestApplyPendingDrop(message)
				.catch((error) => {
					console.error(
						"WFRP1ED | Held-items physical drop failed.",
						error,
					);
					ui.notifications.error(
						error?.message ?? localize(
							"Unable to resolve the held-item drop.",
							"Nie udało się rozstrzygnąć upuszczenia trzymanych przedmiotów.",
						),
					);
				})
				.finally(() => {
					button.disabled = false;
				});
		});
	}

	block.append(button);
	card.append(block);
}

async function requestApplyPendingDrop(message) {
	const state = HeldItemsCheck.stateFor(message);
	const actor = actorFromStateSync(state);
	if (!canRequestApply(actor)) {
		throw new Error(localize(
			"Only the GM or an OWNER of this Actor can resolve the Item drop.",
			"Tylko MG albo Właściciel tego Aktora może rozstrzygnąć upuszczenie przedmiotów.",
		));
	}

	const authority = primaryActiveGM();
	if (!authority || authority.id === game.user?.id) {
		return applyPendingDropAsAuthority(
			String(message?.id ?? ""),
			String(game.user?.id ?? ""),
		);
	}
	if (!game.socket) {
		throw new Error(localize(
			"The Foundry system socket is unavailable for the held-item drop.",
			"Systemowy kanał Foundry jest niedostępny dla upuszczania przedmiotów.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the held-item drop in time.",
				"MG nie rozstrzygnął upuszczenia przedmiotów w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);

		pendingRequests.set(requestId, { resolve, reject, timeoutId });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requesterUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
		});
	});
}

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;

	if (payload.type === RESPONSE_TYPE) {
		if (
			String(payload.requesterUserId ?? "") !==
			String(game.user?.id ?? "")
		) return;

		const requestId = String(payload.requestId ?? "");
		const pending = pendingRequests.get(requestId);
		if (!pending) return;
		pendingRequests.delete(requestId);
		clearTimeout(pending.timeoutId);

		if (payload.ok) pending.resolve(payload.result ?? null);
		else pending.reject(new Error(
			String(payload.error ?? "") || "Held-item drop failed.",
		));
		return;
	}

	if (payload.type !== REQUEST_TYPE || !isPrimaryActiveGM()) return;

	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requesterUserId: String(payload.requesterUserId ?? ""),
		ok: false,
		result: null,
		error: "",
	};

	try {
		response.result = await applyPendingDropAsAuthority(
			String(payload.messageId ?? ""),
			String(payload.requesterUserId ?? ""),
		);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | Held-item drop authority failed.", error);
		response.error = error?.message ?? "Held-item drop failed.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

async function applyPendingDropAsAuthority(messageId, requesterUserId) {
	const message = game.messages?.get(String(messageId ?? ""));
	if (!(message instanceof foundry.documents.ChatMessage)) {
		throw new Error("Held-items ChatMessage is unavailable.");
	}

	const requester = game.users?.get(String(requesterUserId ?? "")) ?? game.user;
	if (!requester) {
		throw new Error("Held-item drop requester is unavailable.");
	}

	const state = HeldItemsCheck.stateFor(message);
	if (!state) {
		throw new Error("Held-items state is unavailable.");
	}
	if (String(state.outcome ?? "") !== "drop") {
		throw new Error(localize(
			"The held-items result no longer requires a drop.",
			"Wynik testu utrzymania przedmiotów nie wymaga już upuszczenia.",
		));
	}
	if (
		state?.consequence?.kind !== CONSEQUENCE_KIND ||
		state?.consequence?.state !== CONSEQUENCE_STATE.PENDING
	) {
		throw new Error(localize(
			"This held-item drop is not pending.",
			"To upuszczenie przedmiotów nie oczekuje na rozstrzygnięcie.",
		));
	}

	const actor = await actorFromState(state);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(localize(
			"The Actor for this held-items result is unavailable.",
			"Aktor dla tego wyniku utrzymania przedmiotów jest niedostępny.",
		));
	}
	if (!canUserManageActor(actor, requester)) {
		throw new Error(localize(
			"Only the GM or an OWNER of this Actor can resolve the Item drop.",
			"Tylko MG albo Właściciel tego Aktora może rozstrzygnąć upuszczenie przedmiotów.",
		));
	}

	const applying = foundry.utils.deepClone(state);
	applying.consequence = {
		...(applying.consequence ?? {}),
		kind: CONSEQUENCE_KIND,
		state: CONSEQUENCE_STATE.APPLYING,
		requestedBy: String(requester.id ?? ""),
		startedAt: Date.now(),
	};
	applying.updatedBy = String(game.user?.id ?? "");
	applying.updatedAt = Date.now();
	await message.update({
		[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: applying,
	});

	try {
		const heldItems = [...(actor.items ?? [])].filter((item) =>
			LootPileService.isPhysicalItem(item) &&
			String(item.system?.state?.mode ?? "") === INVENTORY_MODE.HELD,
		);

		let lootResult = null;
		if (heldItems.length > 0) {
			lootResult = await LootPileService.createFromActorItems({
				sourceActor: actor,
				items: heldItems,
				reason: "held-items-check",
				sourceLabel: actor.name,
			});
		}

		const current = HeldItemsCheck.stateFor(message);
		if (
			!current ||
			String(current.outcome ?? "") !== "drop" ||
			current?.consequence?.state !== CONSEQUENCE_STATE.APPLYING
		) {
			throw new Error(localize(
				"The held-items result changed while the world-state drop was being resolved.",
				"Wynik utrzymania przedmiotów zmienił się podczas rozstrzygania upuszczenia w stanie świata.",
			));
		}

		const updated = foundry.utils.deepClone(current);
		updated.consequence = {
			kind: CONSEQUENCE_KIND,
			state: lootResult?.pileUuid
				? CONSEQUENCE_STATE.APPLIED
				: CONSEQUENCE_STATE.NO_ITEMS,
			pileUuid: String(lootResult?.pileUuid ?? ""),
			moved: Number(lootResult?.moved ?? 0),
			requestedBy: String(requester.id ?? ""),
			appliedAt: lootResult?.pileUuid ? Date.now() : null,
			resolvedAt: Date.now(),
		};
		updated.updatedBy = String(game.user?.id ?? "");
		updated.updatedAt = Date.now();

		await message.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});

		return {
			messageId: String(message.id ?? ""),
			state: updated.consequence.state,
			pileUuid: updated.consequence.pileUuid,
			moved: updated.consequence.moved,
		};
	} catch (error) {
		const current = HeldItemsCheck.stateFor(message);
		if (current?.consequence?.state === CONSEQUENCE_STATE.APPLYING) {
			const restored = foundry.utils.deepClone(current);
			restored.consequence = {
				kind: CONSEQUENCE_KIND,
				state: CONSEQUENCE_STATE.PENDING,
			};
			restored.updatedBy = String(game.user?.id ?? "");
			restored.updatedAt = Date.now();
			await message.update({
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: restored,
			}).catch(() => {});
		}
		throw error;
	}
}

function statusElement(text) {
	const status = document.createElement("div");
	status.className = "wfrp1e-movement-consequence__status";
	status.textContent = text;
	return status;
}

function canRequestApply(actor) {
	return canUserManageActor(actor, game.user);
}

function canUserManageActor(actor, user) {
	if (!user || !(actor instanceof foundry.documents.Actor)) return false;
	return user.isGM || actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

async function actorFromState(state) {
	try {
		const actor = await foundry.utils.fromUuid(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function actorFromStateSync(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function isPrimaryActiveGM() {
	return primaryActiveGM()?.id === game.user?.id;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}