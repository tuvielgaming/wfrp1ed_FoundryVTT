import { DAMAGE_MITIGATION_POLICY, DamagePacket } from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";

const LEATHER_ARMOUR_CLASS = "leather";
const PARRY_SPECIAL_KEY = "parry";
const ARMOUR_PENETRATION_SPECIAL_KEY = "armourPenetration";

/**
 * Resolve already-generated WFRP damage without mutating an Actor.
 *
 * The DamagePacket declares which mitigation rules apply. Callers which request
 * APPLY must provide immutable snapshots of the target values used for this
 * resolution. The resulting DamageResolution persists those snapshots in its
 * breakdown, so applying the result later never re-reads live Actor/equipment
 * state.
 *
 * Combat damage order used by this system:
 *   generated damage -> successful Parry reduction -> Toughness -> armour at
 *   hit location -> unmitigated additions declared by the source -> Wounds.
 *
 * Parry therefore changes the amount which reaches the ordinary defensive
 * reductions. The `toughness.before` snapshot is the authoritative
 * "Before Toughness" value presented in chat.
 *
 * Leather is the Core 0/1 exception: it reduces a blow by 1 only when the
 * post-Toughness, pre-armour damage is 1-3. A blow causing 4+ ignores leather.
 */
export class DamageResolver {
	/**
	 * @param {DamagePacket|Object} packet
	 * @param {Object} [snapshots]
	 * @param {number|Object} [snapshots.toughness]
	 * @param {Object} [snapshots.armour]
	 * @returns {DamageResolution}
	 */
	static resolve(packet, snapshots = {}) {
		const normalized = packet instanceof DamagePacket
			? packet
			: DamagePacket.fromJSON(packet);

		const special = normalizeSpecialMitigation(
			normalized.mitigation.special,
		);

		let remaining = normalized.rawAmount;
		const parry = resolveParry(special.parry, remaining);
		remaining = parry.after;

		const toughness = resolveToughness(
			normalized.mitigation.toughness,
			snapshots.toughness,
			remaining,
		);
		remaining = toughness.after;

		const armour = resolveArmour(
			normalized.mitigation.armour,
			snapshots.armour,
			remaining,
			special.armourPenetration,
		);
		remaining = armour.after;

		const unmitigated = resolveUnmitigated(
			normalized.unmitigatedAmount,
			remaining,
		);
		remaining = unmitigated.after;

		return DamageResolution.forPacket(normalized, {
			finalAmount: remaining,
			breakdown: {
				toughness,
				armour,
				parry,
				unmitigated,
			},
		});
	}
}

function resolveUnmitigated(value, before) {
	const amount = nonNegativeInteger(value, "Unmitigated damage");
	return {
		before,
		value: amount,
		after: before + amount,
	};
}

function resolveToughness(policy, snapshot, before) {
	if (policy === DAMAGE_MITIGATION_POLICY.IGNORE) {
		return {
			policy,
			before,
			value: 0,
			absorbed: 0,
			after: before,
		};
	}

	if (policy !== DAMAGE_MITIGATION_POLICY.APPLY) {
		throw new Error(`Unsupported Toughness mitigation policy '${policy}'.`);
	}

	const raw = snapshot && typeof snapshot === "object"
		? snapshot.value
		: snapshot;
	const value = nonNegativeInteger(raw, "Toughness snapshot");
	const after = Math.max(0, before - value);

	return {
		policy,
		before,
		value,
		absorbed: before - after,
		after,
	};
}

function resolveArmour(policy, snapshot, before, armourPenetration) {
	const requestedPenetration = nonNegativeInteger(
		armourPenetration?.value ?? 0,
		"Armour penetration",
	);
	if (policy === DAMAGE_MITIGATION_POLICY.IGNORE) {
		return {
			policy,
			before,
			value: 0,
			absorbed: 0,
			after: before,
			location: null,
			sources: [],
			leather: {
				authoredPoints: 0,
				appliedPoints: 0,
				ignoredByHighDamage: false,
			},
			penetration: {
				requested: requestedPenetration,
				applied: 0,
			},
		};
	}

	if (policy !== DAMAGE_MITIGATION_POLICY.APPLY) {
		throw new Error(`Unsupported Armour mitigation policy '${policy}'.`);
	}

	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		throw new Error(
			"Armour mitigation requires an immutable armour snapshot.",
		);
	}

	const location = optionalText(snapshot.location);
	const sources = normalizeArmourSources(snapshot.sources);
	const fallbackTotal = nonNegativeInteger(
		snapshot.total ?? 0,
		"Armour snapshot total",
	);

	let fixedPoints = 0;
	let leatherPoints = 0;
	if (sources.length > 0) {
		for (const source of sources) {
			if (source.armourClass === LEATHER_ARMOUR_CLASS) {
				leatherPoints += source.points;
			} else {
				fixedPoints += source.points;
			}
		}
	} else {
		/* Legacy/custom snapshots without source metadata behave as fixed AP. */
		fixedPoints = fallbackTotal;
	}

	const leatherApplies = before > 0 && before <= 3;
	const leatherApplied = leatherApplies ? leatherPoints : 0;
	const beforePenetration = fixedPoints + leatherApplied;
	const value = Math.max(0, beforePenetration - requestedPenetration);
	const penetrationApplied = beforePenetration - value;
	const after = Math.max(0, before - value);

	return {
		policy,
		before,
		value,
		absorbed: before - after,
		after,
		location,
		authoredTotal: sources.length > 0
			? fixedPoints + leatherPoints
			: fallbackTotal,
		beforePenetration,
		fixedPoints,
		sources,
		leather: {
			authoredPoints: leatherPoints,
			appliedPoints: leatherApplied,
			ignoredByHighDamage: leatherPoints > 0 && before >= 4,
		},
		penetration: {
			requested: requestedPenetration,
			applied: penetrationApplied,
		},
	};
}

function resolveParry(parry, before) {
	if (!parry) {
		return {
			applied: false,
			before,
			rolledReduction: 0,
			absorbed: 0,
			after: before,
			itemUuid: null,
			itemName: null,
		};
	}

	const rolledReduction = nonNegativeInteger(
		parry.reduction,
		"Parry damage reduction",
	);
	const after = Math.max(0, before - rolledReduction);

	return {
		applied: true,
		before,
		rolledReduction,
		absorbed: before - after,
		after,
		itemUuid: optionalText(parry.itemUuid),
		itemName: optionalText(parry.itemName),
	};
}

function normalizeSpecialMitigation(value) {
	const source = value ?? {};
	if (typeof source !== "object" || Array.isArray(source)) {
		throw new Error("Special mitigation flags must be an object.");
	}

	const unknown = Object.keys(source).filter(
		(key) => ![
			PARRY_SPECIAL_KEY,
			ARMOUR_PENETRATION_SPECIAL_KEY,
		].includes(key),
	);
	if (unknown.length > 0) {
		throw new Error(
			`Unregistered special mitigation flags cannot be resolved: ${unknown.join(", ")}.`,
		);
	}

	const rawParry = source[PARRY_SPECIAL_KEY];
	let parry = null;
	if (rawParry !== undefined && rawParry !== null) {
		if (typeof rawParry !== "object" || Array.isArray(rawParry)) {
			throw new Error("Parry special mitigation must be an object.");
		}
		parry = {
			reduction: nonNegativeInteger(
				rawParry.reduction ?? 0,
				"Parry damage reduction",
			),
			itemUuid: optionalText(rawParry.itemUuid),
			itemName: optionalText(rawParry.itemName),
		};
	}

	const rawPenetration = source[ARMOUR_PENETRATION_SPECIAL_KEY];
	let armourPenetration = null;
	if (rawPenetration !== undefined && rawPenetration !== null) {
		if (
			typeof rawPenetration !== "object" ||
			Array.isArray(rawPenetration)
		) {
			throw new Error("Armour penetration special mitigation must be an object.");
		}
		armourPenetration = {
			value: nonNegativeInteger(
				rawPenetration.value ?? 0,
				"Armour penetration",
			),
		};
	}

	return { parry, armourPenetration };
}

function normalizeArmourSources(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new Error("Armour snapshot sources must be an array.");
	}

	return value.map((source, index) => {
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new Error(`Armour source ${index} must be an object.`);
		}
		return {
			itemUuid: optionalText(source.itemUuid),
			itemName: optionalText(source.itemName),
			armourClass: optionalText(source.armourClass) ?? "other",
			points: nonNegativeInteger(
				source.points ?? 0,
				`Armour source ${index} points`,
			),
		};
	});
}

function nonNegativeInteger(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return number;
}

function optionalText(value) {
	if (value === undefined || value === null) return null;
	const normalized = String(value).trim();
	return normalized || null;
}
