import { DamagePacket } from "./DamagePacket.mjs";

/**
 * Immutable, JSON-safe result of resolving one DamagePacket.
 *
 * A DamageResolution is deliberately separate from DamageApplication. It
 * records the already-calculated amount that should be removed from remaining
 * Wounds, but does not mutate the target Actor.
 */
export class DamageResolution {
	static VERSION = 1;

	constructor({
		packetId,
		targetActorUuid,
		rawAmount,
		finalAmount,
		breakdown = {},
		resolvedAt = Date.now(),
	} = {}) {
		this.version = DamageResolution.VERSION;
		this.packetId = identifier(packetId, "Damage packet id");
		this.targetActorUuid = identifier(
			targetActorUuid,
			"Target Actor UUID",
		);
		this.rawAmount = nonNegativeInteger(
			rawAmount,
			"Raw damage amount",
		);
		this.finalAmount = nonNegativeInteger(
			finalAmount,
			"Final damage amount",
		);
		this.breakdown = foundry.utils.deepFreeze(
			cloneJsonObject(breakdown, "Damage resolution breakdown"),
		);
		this.resolvedAt = finiteInteger(
			resolvedAt,
			"Damage resolution timestamp",
		);

		Object.freeze(this);
	}

	/**
	 * Construct and validate a resolution against its source packet.
	 *
	 * The final amount is intentionally supplied by the caller. DamageResolver
	 * will own WFRP-specific mitigation math once the relevant combat rules have
	 * been audited; this contract prevents DamageApplication from needing to
	 * know how the amount was calculated.
	 *
	 * @param {DamagePacket|Object} packet
	 * @param {Object} input
	 * @returns {DamageResolution}
	 */
	static forPacket(packet, input = {}) {
		const normalizedPacket = packet instanceof DamagePacket
			? packet
			: DamagePacket.fromJSON(packet);

		return new DamageResolution({
			packetId: normalizedPacket.id,
			targetActorUuid: normalizedPacket.targetActorUuid,
			rawAmount: normalizedPacket.rawAmount,
			finalAmount: input.finalAmount,
			breakdown: input.breakdown,
			resolvedAt: input.resolvedAt,
		});
	}

	/**
	 * Rehydrate a resolution stored in a ChatMessage flag.
	 *
	 * @param {Object} data
	 * @returns {DamageResolution}
	 */
	static fromJSON(data) {
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new Error("Damage resolution data must be an object.");
		}

		return new DamageResolution(data);
	}

	/** @returns {Object} */
	toJSON() {
		return {
			version: this.version,
			packetId: this.packetId,
			targetActorUuid: this.targetActorUuid,
			rawAmount: this.rawAmount,
			finalAmount: this.finalAmount,
			breakdown: foundry.utils.deepClone(this.breakdown),
			resolvedAt: this.resolvedAt,
		};
	}
}

function identifier(value, label) {
	const normalized = String(value ?? "").trim();

	if (!normalized) {
		throw new Error(`${label} must not be empty.`);
	}

	return normalized;
}

function cloneJsonObject(value, label) {
	if (value === undefined || value === null) {
		return {};
	}

	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}

	const cloned = foundry.utils.deepClone(value);

	try {
		JSON.stringify(cloned);
	}
	catch (_error) {
		throw new Error(`${label} must be JSON-serializable.`);
	}

	return cloned;
}

function nonNegativeInteger(value, label) {
	const number = finiteInteger(value, label);

	if (number < 0) {
		throw new Error(`${label} must not be negative.`);
	}

	return number;
}

function finiteInteger(value, label) {
	const number = Number(value);

	if (!Number.isFinite(number) || !Number.isInteger(number)) {
		throw new Error(`${label} must be a finite integer.`);
	}

	return number;
}
