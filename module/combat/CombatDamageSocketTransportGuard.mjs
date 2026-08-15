const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_DAMAGE_REQUEST_TYPE = "combat-damage-roll-request";
const SOCKET_PARRY_REQUEST_TYPE = "combat-parry-damage-roll-request";
const SOCKET_OVERRIDE_REQUEST_TYPE = "combat-damage-total-override-request";
const SOCKET_RESPONSE_TYPE = "combat-damage-action-response";
const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const PATCH_MARKER = Symbol.for("wfrp1ed.combatDamageSocketTransportGuard");

/**
 * Combat damage is authoritative through persisted Foundry Documents. The
 * requester's socket response is only an acknowledgement that the GM-side action
 * completed; returning the complete damage-resolution snapshot is unnecessary.
 *
 * Normalize this response to a tiny JSON-safe ACK. A second, state-observing GM
 * listener supplies the same ACK if the normal response is lost after the
 * authoritative document updates have already succeeded. Duplicate ACKs are
 * harmless because CombatDamageIntegration removes a pending request after the
 * first matching response.
 */
Hooks.once("ready", () => {
	const socket = game.socket;
	if (!socket || socket[PATCH_MARKER]) return;

	const originalEmit = socket.emit;
	if (typeof originalEmit !== "function") return;

	try {
		Object.defineProperty(socket, PATCH_MARKER, {
			value: true,
			configurable: false,
			enumerable: false,
			writable: false,
		});

		socket.emit = function wfrpCombatDamageSafeEmit(channel, payload, ...rest) {
			let outgoing = payload;
			if (
				channel === SOCKET_CHANNEL &&
				payload?.type === SOCKET_RESPONSE_TYPE &&
				payload?.ok === true
			) {
				outgoing = acknowledgement(payload);
			}
			return originalEmit.call(this, channel, outgoing, ...rest);
		};
	} catch (error) {
		console.warn("WFRP1ED | Could not normalize combat damage socket responses.", error);
	}

	/* Register after CombatDamageIntegration's ready listener. */
	socket.on(SOCKET_CHANNEL, (payload) => {
		if (!isCombatDamageRequest(payload) || !isPrimaryActiveGm()) return;
		const baseline = requestStateFingerprint(payload);
		void acknowledgeWhenPersisted(payload, baseline);
	});
});

async function acknowledgeWhenPersisted(payload, baseline) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 9000) {
		await delay(100);
		if (!requestReachedPersistedState(payload, baseline)) continue;
		game.socket?.emit?.(SOCKET_CHANNEL, acknowledgement(payload));
		return;
	}
}

function requestReachedPersistedState(payload, baseline) {
	const message = game.messages?.get(String(payload?.messageId ?? ""));
	if (!message) return false;
	const damage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const roll = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);

	switch (payload.type) {
		case SOCKET_DAMAGE_REQUEST_TYPE:
			return currentFingerprint(damage, roll) !== baseline && Boolean(
				damage?.packet?.id ||
				roll?.status === "awaiting-parry" ||
				roll?.status === "resolved"
			);
		case SOCKET_PARRY_REQUEST_TYPE:
			return Boolean(
				damage?.packet?.id &&
				roll?.status === "resolved" &&
				Number.isInteger(Number(roll?.parry?.reduction)) &&
				Number(roll.parry.reduction) >= 1 &&
				Number(roll.parry.reduction) <= 6
			);
		case SOCKET_OVERRIDE_REQUEST_TYPE:
			return Boolean(
				damage?.packet?.id &&
				Number(roll?.diceTotal) === Number(payload.total)
			);
		default:
			return false;
	}
}

function requestStateFingerprint(payload) {
	const message = game.messages?.get(String(payload?.messageId ?? ""));
	if (!message) return "missing";
	return currentFingerprint(
		message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY),
		message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY),
	);
}

function currentFingerprint(damage, roll) {
	return [
		String(damage?.packet?.id ?? ""),
		String(damage?.application?.state ?? ""),
		String(roll?.status ?? ""),
		String(roll?.rolledAt ?? ""),
		String(roll?.resolvedAt ?? ""),
		String(roll?.updatedAt ?? ""),
		String(roll?.parry?.reduction ?? ""),
		String(roll?.diceTotal ?? ""),
	].join("|");
}

function acknowledgement(payload) {
	return {
		type: SOCKET_RESPONSE_TYPE,
		requestId: String(payload?.requestId ?? ""),
		requestUserId: String(payload?.requestUserId ?? ""),
		ok: true,
		result: true,
		error: null,
	};
}

function isCombatDamageRequest(payload) {
	return [
		SOCKET_DAMAGE_REQUEST_TYPE,
		SOCKET_PARRY_REQUEST_TYPE,
		SOCKET_OVERRIDE_REQUEST_TYPE,
	].includes(payload?.type);
}

function isPrimaryActiveGm() {
	const primary = [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
	return Boolean(game.user?.isGM && primary?.id === game.user.id);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
