import { DamagePacket } from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";

/**
 * Explicit application boundary for already-resolved WFRP damage.
 *
 * Damage calculation and damage application are intentionally separate. This
 * class mutates remaining Wounds only after a caller explicitly requests the
 * application and the current user has permission over the damage target.
 */
export class DamageApplication {
	static VERSION = 1;

	/**
	 * Whether a User may apply damage to the target Actor.
	 *
	 * @param {Actor} actor
	 * @param {User} user
	 * @returns {boolean}
	 */
	static canApply(actor, user = game.user) {
		if (!actor || !user) {
			return false;
		}

		if (user.isGM) {
			return true;
		}

		return actor.testUserPermission(
			user,
			CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
		);
	}

	/**
	 * Apply one resolved damage amount to remaining Wounds.
	 *
	 * This method does not update any ChatMessage. The chat integration layer is
	 * responsible for preventing double application before calling this method
	 * and for persisting the returned transaction after a successful Actor
	 * update.
	 *
	 * @param {Object} input
	 * @returns {Promise<Object>}
	 */
	static async apply({
		packet,
		resolution,
		targetActor = null,
		user = game.user,
	} = {}) {
		const normalizedPacket = packet instanceof DamagePacket
			? packet
			: DamagePacket.fromJSON(packet);
		const normalizedResolution = resolution instanceof DamageResolution
			? resolution
			: DamageResolution.fromJSON(resolution);

		validatePair(normalizedPacket, normalizedResolution);

		const actor = targetActor ?? await foundry.utils.fromUuid(
			normalizedPacket.targetActorUuid,
		);

		if (!(actor instanceof Actor)) {
			throw new Error(
				`Damage target '${normalizedPacket.targetActorUuid}' is not an Actor.`,
			);
		}

		if (actor.uuid !== normalizedPacket.targetActorUuid) {
			throw new Error(
				"The supplied target Actor does not match the DamagePacket target.",
			);
		}

		if (!this.canApply(actor, user)) {
			throw new Error(
				"You do not have permission to apply damage to this Actor.",
			);
		}

		const woundsBefore = readRemainingWounds(actor);
		const amountApplied = normalizedResolution.finalAmount;
		const woundsAfter = woundsBefore - amountApplied;

		await actor.update({
			"system.status.wounds.value": woundsAfter,
		});

		return Object.freeze({
			version: DamageApplication.VERSION,
			id: foundry.utils.randomID(),
			packetId: normalizedPacket.id,
			targetActorUuid: actor.uuid,
			amountApplied,
			woundsBefore,
			woundsAfter,
			userId: user?.id ?? "",
			appliedAt: Date.now(),
			state: "applied",
		});
	}
}

function validatePair(packet, resolution) {
	if (resolution.packetId !== packet.id) {
		throw new Error(
			"DamageResolution does not belong to the supplied DamagePacket.",
		);
	}

	if (resolution.targetActorUuid !== packet.targetActorUuid) {
		throw new Error(
			"DamageResolution target does not match the DamagePacket target.",
		);
	}

	if (resolution.rawAmount !== packet.rawAmount) {
		throw new Error(
			"DamageResolution raw amount does not match the DamagePacket.",
		);
	}
}

function readRemainingWounds(actor) {
	const value = Number(actor.system?.status?.wounds?.value);

	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new Error(
			`Actor '${actor.name ?? actor.id}' has no valid remaining Wounds value.`,
		);
	}

	return value;
}
