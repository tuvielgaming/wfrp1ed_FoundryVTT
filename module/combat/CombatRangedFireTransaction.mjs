import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-ranged-fire-request";
const SOCKET_RESPONSE_TYPE = "combat-ranged-fire-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingRequests = new Map();

/**
 * GM-authoritative transport for consuming one ranged shot.
 *
 * CombatRangedState owns the actual readiness/reload/magazine/turn mutation.
 * This class only gives an Actor OWNER the same socket-authoritative path that
 * other combat transactions use, without duplicating the ranged state rules.
 */
export class CombatRangedFireTransaction {
	static async fire(actor, weapon) {
		assertInputs(actor, weapon);

		if (game.user?.isGM) {
			return socketSafeResult(
				await CombatRangedState.commitShot(actor, weapon, game.user),
			);
		}
		assertCanFire(actor, game.user);

		const gm = primaryActiveGM();
		if (!gm) {
			throw new Error(localize(
				"A GM must be connected to commit a ranged shot.",
				"MG musi być połączony, aby zatwierdzić strzał z broni dystansowej.",
			));
		}

		const requestId = foundry.utils.randomID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(requestId);
				reject(new Error("Ranged fire request timed out."));
			}, SOCKET_TIMEOUT_MS);

			pendingRequests.set(requestId, { resolve, reject, timeout });
			game.socket.emit(SOCKET_CHANNEL, {
				type: SOCKET_REQUEST_TYPE,
				requestId,
				requestUserId: String(game.user?.id ?? ""),
				weaponUuid: String(weapon.uuid ?? ""),
			});
		});
	}
}

Hooks.once("ready", () => registerSocket());

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (message) => {
		if (!message || typeof message !== "object") return;

		if (message.type === SOCKET_RESPONSE_TYPE) {
			handleResponse(message);
			return;
		}
		if (message.type !== SOCKET_REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: SOCKET_RESPONSE_TYPE,
			requestId: String(message.requestId ?? ""),
			requestUserId: String(message.requestUserId ?? ""),
		};

		try {
			const user = game.users?.get(String(message.requestUserId ?? ""));
			if (!user?.active) throw new Error("Requesting user is not active.");

			const weapon = await globalThis.fromUuid(String(message.weaponUuid ?? ""));
			if (weapon?.documentName !== "Item") {
				throw new Error("Requested ranged Weapon is unavailable.");
			}
			const actor = weapon.actor ?? weapon.parent;
			assertInputs(actor, weapon);
			assertCanFire(actor, user);

			response.result = socketSafeResult(
				await CombatRangedState.commitShot(actor, weapon, user),
			);
		} catch (error) {
			response.error = error instanceof Error ? error.message : String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleResponse(message) {
	if (String(message.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
	const requestId = String(message.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;

	clearTimeout(pending.timeout);
	pendingRequests.delete(requestId);
	if (message.error) pending.reject(new Error(String(message.error)));
	else pending.resolve(message.result ?? null);
}

function socketSafeResult(value) {
	return Object.freeze({
		available: value?.available === true,
		reason: String(value?.reason ?? ""),
		runtime: foundry.utils.deepClone(value?.runtime ?? null),
		turn: foundry.utils.deepClone(value?.turn ?? null),
		combatantId: String(value?.combatant?.id ?? ""),
	});
}

function assertInputs(actor, weapon) {
	if (actor?.documentName !== "Actor") {
		throw new Error("Ranged fire transaction requires an Actor.");
	}
	if (weapon?.documentName !== "Item" || weapon.type !== "weapon") {
		throw new Error("Ranged fire transaction requires a Weapon Item.");
	}
	if (weapon.parent?.uuid !== actor.uuid) {
		throw new Error("The selected ranged Weapon is not owned by this Actor.");
	}
	if (weapon.system?.kind !== WEAPON_KIND.RANGED) {
		throw new Error("Ranged fire transaction requires a ranged Weapon.");
	}
}

function assertCanFire(actor, user) {
	if (!user) throw new Error("A user is required for a ranged shot.");
	if (user.isGM) return;
	if (actor.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) === true) {
		return;
	}
	throw new Error(localize(
		"Only the GM or an OWNER of this Actor may fire the ranged weapon.",
		"Tylko MG lub WŁAŚCICIEL tego Aktora może strzelać z broni dystansowej.",
	));
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
