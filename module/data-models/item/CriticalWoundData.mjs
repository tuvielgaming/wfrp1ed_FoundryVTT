const {
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for a resolved WFRP 1e Critical Wound Item.
 *
 * A Critical Wound Item is persistent injury state. The ChatMessage which
 * produced it remains the historical resolution event, while the Item survives
 * on the Actor and owns any embedded ActiveEffects representing ongoing
 * mechanical consequences.
 *
 * This foundation deliberately stores only facts which are independent from a
 * particular critical-effect row. Exact penalties, durations, bleeding,
 * amputations, recovery rules, and other injury-specific mechanics are not
 * guessed here. Those are authored as native ActiveEffects or future audited
 * fields only after the relevant Core Rulebook effect table is verified.
 */
export class CriticalWoundData extends TypeDataModel {
	static defineSchema() {
		return {
			/** Narrative/rules text of the resolved injury. */
			description: textField(),

			/** Damage overflow value which selected the detailed critical column. */
			criticalValue: nonNegativeIntegerField(),

			/**
			 * Stable mechanical hit-location value supplied by the damage/critical
			 * resolver. It remains text until the detailed location contract has
			 * been re-audited against the Core tables.
			 */
			hitLocation: textField(),

			/**
			 * Immutable-style provenance of the resolution which created the wound.
			 * These values are audit links, not presentation strings and not a
			 * substitute for the Item's embedded ActiveEffects.
			 */
			resolution: new SchemaField({
				damagePacketId: textField(),
				sourceMessageId: textField(),
				resultMessageId: textField(),
				tableRole: textField(),
				tableVariant: textField(),
				providerId: textField(),
				tableUuid: textField(),
				tableResultId: textField(),
				roll: nonNegativeIntegerField(),
				resolvedByUserId: textField(),
				resolvedAt: nonNegativeIntegerField(),
			}),
		};
	}

	/**
	 * Normalize transitional/plain object data without inventing rule content.
	 */
	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(source ?? {});
		const resolution = migrated.resolution ?? {};

		migrated.description = unwrapText(migrated.description);
		migrated.hitLocation = unwrapText(migrated.hitLocation);
		migrated.criticalValue = toNonNegativeInteger(
			unwrapValue(migrated.criticalValue),
		);
		migrated.resolution = {
			damagePacketId: unwrapText(resolution.damagePacketId),
			sourceMessageId: unwrapText(resolution.sourceMessageId),
			resultMessageId: unwrapText(resolution.resultMessageId),
			tableRole: unwrapText(resolution.tableRole),
			tableVariant: unwrapText(resolution.tableVariant),
			providerId: unwrapText(resolution.providerId),
			tableUuid: unwrapText(resolution.tableUuid),
			tableResultId: unwrapText(resolution.tableResultId),
			roll: toNonNegativeInteger(unwrapValue(resolution.roll)),
			resolvedByUserId: unwrapText(resolution.resolvedByUserId),
			resolvedAt: toNonNegativeInteger(
				unwrapValue(resolution.resolvedAt),
			),
		};

		return super.migrateData(migrated, options);
	}
}

function textField() {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial: "",
		trim: true,
	});
}

function nonNegativeIntegerField() {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial: 0,
		min: 0,
	});
}

function unwrapText(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		return normalizeText(value.value);
	}

	return normalizeText(value);
}

function unwrapValue(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "value")
	) {
		return value.value;
	}

	return value;
}

function normalizeText(value) {
	if (value === undefined || value === null) return "";
	return String(value).trim();
}

function toNonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.max(0, Math.trunc(number))
		: 0;
}
