import { DamagePacket } from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";

const APPLICATION_FLAG_SCOPE = "wfrp1ed";
const APPLICATION_FLAG_KEY = "damageApplications";
const WOUNDS_INITIALIZED_FLAG_KEY = "woundsInitialized";

/**
 * Explicit application boundary for already-resolved WFRP damage.
 *
 * Damage calculation and damage application are intentionally separate. This
 * class mutates remaining Wounds only after a caller explicitly requests the
 * application and the current user has permission over the damage target.
 *
 * The target Actor stores the authoritative application transaction keyed by
 * DamagePacket id. This allows a target owner to apply damage even when they do
 * not own the originating ChatMessage, and prevents normal repeated use of the
 * same damage packet.
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
	 * Return the stored application transaction for one damage packet.
	 *
	 * @param {Actor} actor
	 * @param {DamagePacket|string} packetOrId
	 * @returns {Object|null}
	 */
	static transactionFor(actor, packetOrId) {
		if (!(actor instanceof foundry.documents.Actor)) {
			return null;
		}

		const packetId = packetOrId instanceof DamagePacket
			? packetOrId.id
			: String(packetOrId ?? "").trim();

		if (!packetId) {
			return null;
		}

		const applications = actor.getFlag?.(
			APPLICATION_FLAG_SCOPE,
			APPLICATION_FLAG_KEY,
		);
		const transaction = applications &&
			typeof applications === "object" &&
			!Array.isArray(applications)
				? applications[packetId]
				: null;

		return transaction && typeof transaction === "object"
			? foundry.utils.deepClone(transaction)
			: null;
	}

	/**
	 * Whether this packet already has an applied transaction on the target.
	 *
	 * @param {Actor} actor
	 * @param {DamagePacket|string} packetOrId
	 * @returns {boolean}
	 */
	static isApplied(actor, packetOrId) {
		return this.transactionFor(actor, packetOrId)?.state === "applied";
	}

	/**
	 * Apply one resolved damage amount to remaining Wounds.
	 *
	 * Remaining Wounds and the packet transaction are written by the same Actor
	 * update. The Actor transaction is authoritative; a ChatMessage may mirror
	 * it for presentation when the applying user has permission to edit that
	 * message.
	 *
	 * Actors created before the in-play Wounds workflow may still contain the
	 * schema default 0. Until the per-Actor initialization flag exists, the
	 * Wounds characteristic maximum is treated as the undamaged starting value.
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

		if (!(actor instanceof foundry.documents.Actor)) {
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

		if (this.isApplied(actor, normalizedPacket.id)) {
			throw new Error(
				"This damage packet has already been applied to the target Actor.",
			);
		}

		const woundsBefore = readRemainingWounds(actor);
		const amountApplied = normalizedResolution.finalAmount;
		const woundsAfter = woundsBefore - amountApplied;
		const transaction = {
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
		};
		const existingApplications = actor.getFlag?.(
			APPLICATION_FLAG_SCOPE,
			APPLICATION_FLAG_KEY,
		);
		const applications = existingApplications &&
			typeof existingApplications === "object" &&
			!Array.isArray(existingApplications)
				? foundry.utils.deepClone(existingApplications)
				: {};

		applications[normalizedPacket.id] = foundry.utils.deepClone(transaction);

		await actor.update({
			"system.status.wounds.value": woundsAfter,
			[`flags.${APPLICATION_FLAG_SCOPE}.${APPLICATION_FLAG_KEY}`]:
				applications,
			[`flags.${APPLICATION_FLAG_SCOPE}.${WOUNDS_INITIALIZED_FLAG_KEY}`]:
				true,
		});

		return foundry.utils.deepFreeze(transaction);
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
	if (
		actor.getFlag?.(
			APPLICATION_FLAG_SCOPE,
			WOUNDS_INITIALIZED_FLAG_KEY,
		) !== true
	) {
		const maximum = Number(actor.woundsMaximum);

		if (Number.isFinite(maximum) && Number.isInteger(maximum)) {
			return maximum;
		}
	}

	const value = Number(actor.system?.status?.wounds?.value);

	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new Error(
			`Actor '${actor.name ?? actor.id}' has no valid remaining Wounds value.`,
		);
	}

	return value;
}
