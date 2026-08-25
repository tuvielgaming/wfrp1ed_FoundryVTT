export const DAMAGE_MITIGATION_POLICY = Object.freeze({
	APPLY: "apply",
	IGNORE: "ignore",
});

export const DAMAGE_CRITICAL_MODE = Object.freeze({
	UNSPECIFIED: "unspecified",
	DETAILED: "detailed",
	SUDDEN_DEATH: "sudden-death",
});

const ALLOWED_MITIGATION_POLICIES = new Set(
	Object.values(DAMAGE_MITIGATION_POLICY),
);
const ALLOWED_CRITICAL_MODES = new Set(
	Object.values(DAMAGE_CRITICAL_MODE),
);

/**
 * Immutable, JSON-safe description of damage calculated by a WFRP action.
 *
 * DamagePacket does not mutate an Actor and does not itself perform WFRP
 * mitigation calculations. It records the mitigated base amount, any separate
 * unmitigated addition and the rule policies a later DamageResolver must obey.
 *
 * Critical routing is also source data rather than application logic. A packet
 * may declare whether overflow should later use the detailed Critical Hit
 * system or the Sudden Death table. Sources which have not yet been audited
 * leave the routing explicitly unspecified.
 */
export class DamagePacket {
	static VERSION = 3;

	constructor({
		id = null,
		rawAmount,
		unmitigatedAmount = 0,
		targetActorUuid,
		source,
		armour = DAMAGE_MITIGATION_POLICY.APPLY,
		toughness = DAMAGE_MITIGATION_POLICY.APPLY,
		hitLocation = null,
		specialMitigation = {},
		criticalMode = DAMAGE_CRITICAL_MODE.UNSPECIFIED,
		createdAt = Date.now(),
	} = {}) {
		this.version = DamagePacket.VERSION;
		this.id = normalizeIdentifier(
			id || foundry.utils.randomID(),
			"Damage packet id",
		);
		this.rawAmount = nonNegativeInteger(
			rawAmount,
			"Raw damage amount",
		);
		this.unmitigatedAmount = nonNegativeInteger(
			unmitigatedAmount,
			"Unmitigated damage amount",
		);
		this.targetActorUuid = normalizeIdentifier(
			targetActorUuid,
			"Target Actor UUID",
		);
		this.source = normalizeSource(source);
		this.mitigation = foundry.utils.deepFreeze({
			armour: normalizeMitigationPolicy(
				armour,
				"Armour mitigation policy",
			),
			toughness: normalizeMitigationPolicy(
				toughness,
				"Toughness mitigation policy",
			),
			special: cloneJsonObject(
				specialMitigation,
				"Special mitigation flags",
			),
		});
		this.critical = Object.freeze({
			mode: normalizeCriticalMode(criticalMode),
		});
		this.hitLocation = normalizeOptionalText(hitLocation);
		this.createdAt = finiteInteger(createdAt, "Damage packet timestamp");

		Object.freeze(this);
	}

	/**
	 * Rehydrate a packet stored in ChatMessage flags or other JSON data.
	 *
	 * Earlier packets predate explicit unmitigated damage and therefore
	 * rehydrate that component as zero. Version 1 packets also predate explicit
	 * critical routing and rehydrate it as "unspecified".
	 *
	 * @param {Object} data
	 * @returns {DamagePacket}
	 */
	static fromJSON(data) {
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			throw new Error("Damage packet data must be an object.");
		}

		const mitigation = data.mitigation ?? {};
		const critical = data.critical ?? {};

		return new DamagePacket({
			id: data.id,
			rawAmount: data.rawAmount,
			unmitigatedAmount: data.unmitigatedAmount,
			targetActorUuid: data.targetActorUuid,
			source: data.source,
			armour: mitigation.armour,
			toughness: mitigation.toughness,
			hitLocation: data.hitLocation,
			specialMitigation: mitigation.special,
			criticalMode:
				critical.mode ??
				DAMAGE_CRITICAL_MODE.UNSPECIFIED,
			createdAt: data.createdAt,
		});
	}

	/**
	 * Return a mutable primitive snapshot safe for Document flags.
	 *
	 * @returns {Object}
	 */
	toJSON() {
		return {
			version: this.version,
			id: this.id,
			rawAmount: this.rawAmount,
			unmitigatedAmount: this.unmitigatedAmount,
			targetActorUuid: this.targetActorUuid,
			source: {
				kind: this.source.kind,
				id: this.source.id,
				uuid: this.source.uuid,
				label: this.source.label,
			},
			mitigation: {
				armour: this.mitigation.armour,
				toughness: this.mitigation.toughness,
				special: foundry.utils.deepClone(
					this.mitigation.special,
				),
			},
			critical: {
				mode: this.critical.mode,
			},
			hitLocation: this.hitLocation,
			createdAt: this.createdAt,
		};
	}
}

function normalizeSource(source) {
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		throw new Error("Damage source must be an object.");
	}

	return Object.freeze({
		kind: normalizeIdentifier(source.kind, "Damage source kind"),
		id: normalizeIdentifier(source.id, "Damage source id"),
		uuid: normalizeOptionalText(source.uuid),
		label: normalizeOptionalText(source.label),
	});
}

function normalizeMitigationPolicy(value, label) {
	const normalized = String(value ?? "").trim().toLowerCase();

	if (!ALLOWED_MITIGATION_POLICIES.has(normalized)) {
		throw new Error(
			`${label} must be '${DAMAGE_MITIGATION_POLICY.APPLY}' or ` +
				`'${DAMAGE_MITIGATION_POLICY.IGNORE}'.`,
		);
	}

	return normalized;
}

function normalizeCriticalMode(value) {
	const normalized = String(
		value ?? DAMAGE_CRITICAL_MODE.UNSPECIFIED,
	).trim().toLowerCase();

	if (!ALLOWED_CRITICAL_MODES.has(normalized)) {
		throw new Error(
			"Critical mode must be " +
				Object.values(DAMAGE_CRITICAL_MODE)
					.map((mode) => `'${mode}'`)
					.join(", ") +
				".",
		);
	}

	return normalized;
}

function normalizeIdentifier(value, label) {
	const normalized = String(value ?? "").trim();

	if (!normalized) {
		throw new Error(`${label} must not be empty.`);
	}

	return normalized;
}

function normalizeOptionalText(value) {
	if (value === undefined || value === null) {
		return null;
	}

	const normalized = String(value).trim();
	return normalized || null;
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
