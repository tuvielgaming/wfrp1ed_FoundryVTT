import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";

const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "loot-pile-request";
const RESPONSE_TYPE = "loot-pile-response";
const FLAG_SCOPE = "wfrp1ed";
const MESSAGE_FLAG_KEY = "lootPile";
const ITEM_ORIGIN_FLAG_KEY = "lootOrigin";
const SUPPORTED_ITEM_TYPES = new Set(["weapon", "armour", "equipment"]);
const pending = new Map();
const SOCKET_TIMEOUT_MS = 10000;

/**
 * Authoritative physical Item transfer service.
 *
 * Chat cards are presentation only. A Loot Pile is a native Actor containing
 * normal embedded physical Items. Every destructive move is serialized by the
 * primary active GM when one exists so a player can drop/pick up Items without
 * requiring ownership of the pile document itself.
 *
 * Automatic Critical drops start at revision 0. Any later add/take increments
 * the revision. A rollback is allowed only while the original pile is untouched;
 * this preserves the same LIFO transaction rule used by damage/defence rollback.
 */
export class LootPileService {
	static isLootPile(actor) {
		return actor instanceof foundry.documents.Actor && actor.type === "lootPile";
	}

	static isPhysicalItem(item) {
		return item instanceof foundry.documents.Item && SUPPORTED_ITEM_TYPES.has(item.type);
	}

	static async createFromActorItems({
		sourceActor,
		items,
		reason = "",
		sourceLabel = "",
	} = {}) {
		if (!(sourceActor instanceof foundry.documents.Actor)) {
			throw new Error("Creating a Loot Pile from held Items requires a source Actor.");
		}
		const itemIds = normalizeOwnedPhysicalItems(sourceActor, items).map((item) => item.id);
		if (!itemIds.length) return null;

		return this.#dispatch("create", {
			sourceActorUuid: sourceActor.uuid,
			itemIds,
			reason: text(reason),
			sourceLabel: text(sourceLabel) || String(sourceActor.name ?? ""),
		});
	}

	static async addItem(pile, item, { move = true } = {}) {
		if (!this.isLootPile(pile)) throw new Error("The target is not a WFRP Loot Pile.");
		if (!this.isPhysicalItem(item)) {
			throw new Error("Only physical Weapon, Armour, or Equipment Items can be placed in loot.");
		}
		return this.#dispatch("add", {
			pileUuid: pile.uuid,
			itemUuid: item.uuid,
			move: move === true,
		});
	}

	static async takeItem(pile, item, targetActor) {
		if (!this.isLootPile(pile) || item?.parent?.uuid !== pile.uuid) {
			throw new Error("The selected Item does not belong to this Loot Pile.");
		}
		if (!(targetActor instanceof foundry.documents.Actor) || this.isLootPile(targetActor)) {
			throw new Error("Loot must be transferred to a normal Actor.");
		}
		return this.#dispatch("take", {
			pileUuid: pile.uuid,
			itemId: item.id,
			targetActorUuid: targetActor.uuid,
		});
	}

	static async restoreUntouchedPile(pile, sourceActor) {
		if (!this.isLootPile(pile)) throw new Error("The Loot Pile is unavailable.");
		if (!(sourceActor instanceof foundry.documents.Actor) || this.isLootPile(sourceActor)) {
			throw new Error("Loot rollback requires the original Actor.");
		}
		return this.#dispatch("restore", {
			pileUuid: pile.uuid,
			sourceActorUuid: sourceActor.uuid,
		});
	}

	static async deletePile(pile) {
		if (!this.isLootPile(pile)) return false;
		return this.#dispatch("delete", { pileUuid: pile.uuid });
	}

	static messagesForPile(pileUuid) {
		const uuid = text(pileUuid);
		return [...(game.messages ?? [])].filter((message) =>
			text(message.getFlag?.(FLAG_SCOPE, MESSAGE_FLAG_KEY)?.pileUuid) === uuid,
		);
	}

	static async pileFromMessage(message) {
		const uuid = text(message?.getFlag?.(FLAG_SCOPE, MESSAGE_FLAG_KEY)?.pileUuid);
		if (!uuid) return null;
		try {
			const pile = await foundry.utils.fromUuid(uuid);
			return this.isLootPile(pile) ? pile : null;
		} catch (_error) {
			return null;
		}
	}

	static async #dispatch(action, data) {
		const authority = primaryActiveGm();
		if (!authority || authority.id === game.user?.id) {
			return handleAuthorityRequest({
				action,
				data,
				requesterUserId: game.user?.id ?? "",
			});
		}
		if (!game.socket) throw new Error("The Foundry system socket is unavailable for Loot transfer.");

		const requestId = foundry.utils.randomID();
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(localize(
					"The GM did not resolve the Loot action in time.",
					"MG nie rozstrzygnął operacji łupu w wymaganym czasie.",
				)));
			}, SOCKET_TIMEOUT_MS);
			pending.set(requestId, { resolve, reject, timeoutId });
			game.socket.emit(SOCKET_CHANNEL, {
				type: REQUEST_TYPE,
				requestId,
				requesterUserId: game.user?.id ?? "",
				action,
				data,
			});
		});
	}
}

Hooks.once("ready", () => {
	if (!game.socket) return;
	game.socket.on(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
});

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (text(payload.requesterUserId) !== text(game.user?.id)) return;
		const requestId = text(payload.requestId);
		const entry = pending.get(requestId);
		if (!entry) return;
		pending.delete(requestId);
		clearTimeout(entry.timeoutId);
		if (payload.ok) entry.resolve(payload.result ?? null);
		else entry.reject(new Error(text(payload.error) || "Loot action failed."));
		return;
	}

	if (payload.type !== REQUEST_TYPE || !isPrimaryActiveGm()) return;
	const response = {
		type: RESPONSE_TYPE,
		requestId: text(payload.requestId),
		requesterUserId: text(payload.requesterUserId),
		ok: false,
		result: null,
		error: "",
	};
	try {
		response.result = await handleAuthorityRequest(payload);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | Loot action failed.", error);
		response.error = error?.message ?? "Loot action failed.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function handleAuthorityRequest({ action, data = {}, requesterUserId = "" } = {}) {
	const requester = game.users?.get(text(requesterUserId)) ?? game.user;
	if (!requester) throw new Error("Loot action requester is unavailable.");
	switch (text(action)) {
		case "create": return createPileAsAuthority(data, requester);
		case "add": return addItemAsAuthority(data, requester);
		case "take": return takeItemAsAuthority(data, requester);
		case "restore": return restorePileAsAuthority(data, requester);
		case "delete": return deletePileAsAuthority(data, requester);
		default: throw new Error(`Unknown Loot action '${text(action)}'.`);
	}
}

async function createPileAsAuthority(data, requester) {
	const sourceActor = await actorFromUuid(data.sourceActorUuid);
	assertActorEditPermission(sourceActor, requester);
	const items = normalizeOwnedPhysicalItems(
		sourceActor,
		(data.itemIds ?? []).map((id) => sourceActor.items?.get?.(text(id))),
	);
	if (!items.length) return null;

	const sourceLabel = text(data.sourceLabel) || String(sourceActor.name ?? "");
	const [pile] = await foundry.documents.Actor.createDocuments([{
		name: localize(`Loot — ${sourceLabel}`, `Łup — ${sourceLabel}`),
		type: "lootPile",
		img: "icons/svg/chest.svg",
		ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
		system: {
			sourceActorUuid: sourceActor.uuid,
			sourceLabel,
			reason: text(data.reason),
			exhausted: false,
			revision: 0,
			initialItemCount: items.length,
			createdAt: Date.now(),
		},
	}]);
	if (!LootPileService.isLootPile(pile)) throw new Error("Foundry did not create the Loot Pile Actor.");

	try {
		await copyItemsIntoPile(pile, items, sourceActor);
		await sourceActor.deleteEmbeddedDocuments("Item", items.map((item) => item.id));
		await createLootMessage(pile);
	} catch (error) {
		await pile.delete().catch(() => {});
		throw error;
	}
	return { pileUuid: pile.uuid, moved: items.length, revision: 0 };
}

async function addItemAsAuthority(data, requester) {
	const pile = await lootPileFromUuid(data.pileUuid);
	const item = await itemFromUuid(data.itemUuid);
	if (!LootPileService.isPhysicalItem(item)) throw new Error("Only physical Items can be added to Loot.");

	const sourceActor = item.parent instanceof foundry.documents.Actor ? item.parent : null;
	const destructiveMove = data.move === true && sourceActor && !LootPileService.isLootPile(sourceActor);
	if (destructiveMove) assertActorEditPermission(sourceActor, requester);
	else if (
		!requester.isGM && item.pack == null && sourceActor &&
		!item.testUserPermission?.(requester, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)
	) throw new Error("You cannot access that Item.");

	const [created] = await pile.createEmbeddedDocuments("Item", [pileItemSource(item, sourceActor)]);
	if (!created) throw new Error("The Item could not be added to the Loot Pile.");
	if (destructiveMove) {
		try {
			await sourceActor.deleteEmbeddedDocuments("Item", [item.id]);
		} catch (error) {
			await pile.deleteEmbeddedDocuments("Item", [created.id]).catch(() => {});
			throw error;
		}
	}
	await mutatePileState(pile, { exhausted: false });
	refreshLootPresentation(pile.uuid);
	return { pileUuid: pile.uuid, itemId: created.id, revision: Number(pile.system?.revision ?? 0) };
}

async function takeItemAsAuthority(data, requester) {
	const pile = await lootPileFromUuid(data.pileUuid);
	const target = await actorFromUuid(data.targetActorUuid);
	if (LootPileService.isLootPile(target)) throw new Error("A Loot Pile cannot loot another Loot Pile through this action.");
	assertActorEditPermission(target, requester);

	const item = pile.items?.get?.(text(data.itemId));
	if (!LootPileService.isPhysicalItem(item)) throw new Error("That Loot Item no longer exists.");
	const [created] = await target.createEmbeddedDocuments("Item", [characterItemSource(item)]);
	if (!created) throw new Error("The Loot Item could not be added to the target Actor.");
	try {
		await pile.deleteEmbeddedDocuments("Item", [item.id]);
	} catch (error) {
		await target.deleteEmbeddedDocuments("Item", [created.id]).catch(() => {});
		throw error;
	}
	await mutatePileState(pile, { exhausted: pile.items.size <= 0 });
	refreshLootPresentation(pile.uuid);
	return { pileUuid: pile.uuid, targetActorUuid: target.uuid, itemId: created.id, revision: Number(pile.system?.revision ?? 0) };
}

async function restorePileAsAuthority(data, requester) {
	const pile = await lootPileFromUuid(data.pileUuid);
	const sourceActor = await actorFromUuid(data.sourceActorUuid);
	if (!requester.isGM) throw new Error("Only the GM may roll back an automatic Loot Pile.");
	if (text(pile.system?.sourceActorUuid) !== sourceActor.uuid) {
		throw new Error("This Loot Pile no longer belongs to the Actor being rolled back.");
	}
	if (Number(pile.system?.revision ?? 0) !== 0) {
		throw new Error(localize(
			"This Loot Pile was changed after the Critical Wound. Revert newer Loot transfers first.",
			"Ten stos łupu został zmieniony po Ranie Krytycznej. Najpierw cofnij późniejsze transfery łupu.",
		));
	}
	const expectedCount = Number(pile.system?.initialItemCount ?? 0);
	const items = [...(pile.items ?? [])].filter(LootPileService.isPhysicalItem);
	if (items.length !== expectedCount) {
		throw new Error(localize(
			"The automatic Loot Pile contents changed outside the transfer service; it cannot be rolled back safely.",
			"Zawartość automatycznego stosu łupu została zmieniona poza mechanizmem transferu; nie można go bezpiecznie cofnąć.",
		));
	}

	const created = await sourceActor.createEmbeddedDocuments("Item", items.map(characterItemSource));
	if (created.length !== items.length) {
		if (created.length) await sourceActor.deleteEmbeddedDocuments("Item", created.map((item) => item.id)).catch(() => {});
		throw new Error("Not every dropped Item could be restored to the original Actor.");
	}
	try {
		for (const message of LootPileService.messagesForPile(pile.uuid)) await message.delete();
		await pile.delete();
	} catch (error) {
		await sourceActor.deleteEmbeddedDocuments("Item", created.map((item) => item.id)).catch(() => {});
		throw error;
	}
	return { restored: created.length, sourceActorUuid: sourceActor.uuid };
}

async function deletePileAsAuthority(data, requester) {
	if (!requester.isGM) throw new Error("Only the GM may delete a Loot Pile.");
	const pile = await lootPileFromUuid(data.pileUuid);
	for (const message of LootPileService.messagesForPile(pile.uuid)) await message.delete();
	await pile.delete();
	return { deleted: true };
}

async function copyItemsIntoPile(pile, items, sourceActor) {
	const sources = items.map((item) => pileItemSource(item, sourceActor));
	const created = await pile.createEmbeddedDocuments("Item", sources);
	if (created.length !== sources.length) throw new Error("Not every dropped Item was copied into the Loot Pile.");
	return created;
}

function pileItemSource(item, sourceActor = null) {
	const source = item.toObject();
	delete source._id;
	delete source.folder;
	delete source.ownership;
	if (source.system?.state) {
		source.system.state.mode = INVENTORY_MODE.CARRIED;
		source.system.state.hand = INVENTORY_HAND.NONE;
	}
	const origin = sourceActor instanceof foundry.documents.Actor ? sourceActor : item.parent;
	source.flags ??= {};
	source.flags[FLAG_SCOPE] ??= {};
	source.flags[FLAG_SCOPE][ITEM_ORIGIN_FLAG_KEY] = {
		version: 1,
		sourceActorUuid: origin instanceof foundry.documents.Actor && !LootPileService.isLootPile(origin) ? origin.uuid : "",
		sourceItemId: String(item.id ?? ""),
		movedAt: Date.now(),
	};
	return source;
}

function characterItemSource(item) {
	const source = item.toObject();
	delete source._id;
	delete source.folder;
	delete source.ownership;
	if (source.system?.state) {
		source.system.state.mode = INVENTORY_MODE.CARRIED;
		source.system.state.hand = INVENTORY_HAND.NONE;
	}
	if (source.flags?.[FLAG_SCOPE]) delete source.flags[FLAG_SCOPE][ITEM_ORIGIN_FLAG_KEY];
	return source;
}

async function createLootMessage(pile) {
	return ChatMessage.create({
		speaker: { alias: String(pile.name ?? localize("Loot", "Łup")) },
		content: `<section class="wfrp1ed-loot-card" data-wfrp-loot-card data-pile-uuid="${escapeAttribute(pile.uuid)}"></section>`,
		flags: {
			[FLAG_SCOPE]: {
				[MESSAGE_FLAG_KEY]: { version: 1, pileUuid: pile.uuid },
			},
		},
	});
}

async function mutatePileState(pile, { exhausted } = {}) {
	const revision = Number(pile.system?.revision ?? 0) + 1;
	const update = { "system.revision": revision };
	if (exhausted !== undefined) update["system.exhausted"] = Boolean(exhausted);
	await pile.update(update);
	return revision;
}

function refreshLootPresentation(pileUuid) {
	for (const message of LootPileService.messagesForPile(pileUuid)) void message.render?.({ force: true });
	void ui.chat?.render?.({ force: true });
}

function normalizeOwnedPhysicalItems(actor, values) {
	const seen = new Set();
	const result = [];
	for (const item of values ?? []) {
		if (!LootPileService.isPhysicalItem(item) || item.parent?.uuid !== actor.uuid) continue;
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		result.push(item);
	}
	return result;
}

async function actorFromUuid(uuid) {
	const actor = await foundry.utils.fromUuid(text(uuid));
	if (!(actor instanceof foundry.documents.Actor)) throw new Error("Actor is unavailable.");
	return actor;
}

async function lootPileFromUuid(uuid) {
	const pile = await actorFromUuid(uuid);
	if (!LootPileService.isLootPile(pile)) throw new Error("Loot Pile is unavailable.");
	return pile;
}

async function itemFromUuid(uuid) {
	const item = await foundry.utils.fromUuid(text(uuid));
	if (!(item instanceof foundry.documents.Item)) throw new Error("Item is unavailable.");
	return item;
}

function assertActorEditPermission(actor, user) {
	if (user?.isGM) return;
	if (actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) return;
	throw new Error("You do not own the Actor involved in this Item transfer.");
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return Boolean(game.user?.isGM && primaryActiveGm()?.id === game.user.id);
}

function text(value) {
	return value == null ? "" : String(value).trim();
}

function escapeAttribute(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
