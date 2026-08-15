const OWNER_LEVEL = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
const CRITICAL_WOUND_TYPE = "criticalWound";

/**
 * Materialize one already-resolved detailed critical as persistent Actor state.
 *
 * This service deliberately knows nothing about WFRP critical-table contents.
 * A verified resolver supplies the wound text, provenance, and any ActiveEffect
 * sources. This class only owns Foundry document validation, permissions,
 * idempotency, and embedded Item creation.
 */
export class CriticalWoundApplication {
	static canApply(actor, user = game.user) {
		if (!isActor(actor) || !user) return false;
		if (user.isGM) return true;
		return actor.testUserPermission(user, OWNER_LEVEL);
	}

	static existingForResolution(actor, resolution = {}) {
		if (!isActor(actor)) return null;
		const normalized = normalizeResolution(resolution);
		const resultMessageId = normalized.resultMessageId;
		if (!resultMessageId) return null;
		return [...(actor.items ?? [])].find((item) =>
			item.type === CRITICAL_WOUND_TYPE &&
			text(item.system?.resolution?.resultMessageId) === resultMessageId
		) ?? null;
	}

	static async create(input = {}) {
		const actor = input.actor;
		const user = input.user ?? game.user;
		this.#assertActor(actor);
		this.#assertPermission(actor, user);

		const source = normalizeWoundSource(input);
		const existing = this.existingForResolution(actor, source.system.resolution);
		if (existing) return { created: false, wound: existing };

		const [wound] = await actor.createEmbeddedDocuments("Item", [source]);
		if (!wound || wound.type !== CRITICAL_WOUND_TYPE) {
			throw new Error("Foundry did not return the created Critical Wound Item.");
		}
		return { created: true, wound };
	}

	static #assertActor(actor) {
		if (!isActor(actor)) {
			throw new Error("Critical Wound application requires an Actor document.");
		}
	}

	static #assertPermission(actor, user) {
		if (this.canApply(actor, user)) return;
		throw new Error(
			"Only a GM or the target Actor OWNER may create a Critical Wound on this Actor.",
		);
	}
}

function normalizeWoundSource(input) {
	const name = text(input.name);
	if (!name) throw new Error("A resolved Critical Wound requires a name.");

	const criticalValue = positiveInteger(input.criticalValue, "Critical value");
	const resolution = normalizeResolution(input.resolution);
	if (!resolution.resultMessageId) {
		throw new Error(
			"A resolved Critical Wound requires its result ChatMessage id for idempotent materialization.",
		);
	}
	if (!resolution.damagePacketId) {
		throw new Error("A resolved Critical Wound requires its source DamagePacket id.");
	}
	if (!resolution.tableRole) {
		throw new Error("A resolved Critical Wound requires its critical table role.");
	}

	return {
		name,
		type: CRITICAL_WOUND_TYPE,
		...(text(input.img) ? { img: text(input.img) } : {}),
		system: {
			description: text(input.description),
			criticalValue,
			hitLocation: text(input.hitLocation),
			resolution,
		},
		effects: normalizeEffects(input.effects),
	};
}

function normalizeResolution(value = {}) {
	const source = value?.toObject?.() ?? value ?? {};
	return {
		damagePacketId: text(source.damagePacketId),
		sourceMessageId: text(source.sourceMessageId),
		resultMessageId: text(source.resultMessageId),
		tableRole: text(source.tableRole),
		tableVariant: text(source.tableVariant),
		providerId: text(source.providerId),
		tableUuid: text(source.tableUuid),
		tableResultId: text(source.tableResultId),
		effectNumber: nonNegativeInteger(source.effectNumber),
		roll: nonNegativeInteger(source.roll),
		resolvedByUserId: text(source.resolvedByUserId),
		resolvedAt: nonNegativeInteger(source.resolvedAt),
	};
}

function normalizeEffects(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new Error("Critical Wound effects must be an array.");
	}
	return value.map((effect, index) => {
		const source = effect?.toObject?.() ?? effect;
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new Error(
				`Critical Wound effect at index ${index} is not a valid ActiveEffect source object.`,
			);
		}
		return foundry.utils.deepClone(source);
	});
}

function positiveInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function text(value) {
	if (value === undefined || value === null) return "";
	return String(value).trim();
}

function isActor(document) {
	return Boolean(document && document.documentName === "Actor");
}
