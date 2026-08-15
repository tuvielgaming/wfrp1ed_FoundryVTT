const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_RESPONSE_TYPE = "combat-damage-action-response";
const PATCH_MARKER = Symbol.for("wfrp1ed.combatDamageSocketTransportGuard");

/**
 * Combat damage is authoritative through persisted Foundry Documents. The
 * requester's socket response is only an acknowledgement that the GM-side action
 * completed; returning the complete damage-resolution snapshot is unnecessary
 * and has proved unreliable across clients.
 *
 * Normalize only this one response type to a tiny JSON-safe ACK before Socket.IO
 * serializes it. Existing CombatDamageIntegration response handling continues to
 * own request ids, errors and timeouts; this module changes transport shape only.
 */
Hooks.once("ready", () => {
	const socket = game.socket;
	if (!socket || socket[PATCH_MARKER]) return;

	const originalEmit = socket.emit;
	if (typeof originalEmit !== "function") return;

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
			outgoing = {
				type: SOCKET_RESPONSE_TYPE,
				requestId: String(payload.requestId ?? ""),
				requestUserId: String(payload.requestUserId ?? ""),
				ok: true,
				result: true,
				error: null,
			};
		}
		return originalEmit.call(this, channel, outgoing, ...rest);
	};
});
