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
 */
export class CriticalWoundData extends TypeDataModel {
	static defineSchema() {
		return {
			/** Narrative/rules text of the resolved injury. */
			description: textField(),

			/** Damage overflow value which selected the detailed critical column. */
			criticalValue: nonNegativeIntegerField(),

			/** Stable mechanical hit-location value supplied by the resolver. */
			hitLocation: textField(),

			/**
			 * Immutable-style provenance of the resolution which created the wound.
			 * `effectNumber` is persisted directly because managed Core RollTables are
			 * implementation documents and their UUID/result ids must not be required
			 * to reconstruct an ongoing injury after a world restart.
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
				effectNumber: nonNegativeIntegerField(),
				roll: nonNegativeIntegerField(),
				resolvedByUserId: textField(),
				resolvedAt: nonNegativeIntegerField(),
			}),
		};
	}

	/** Normalize transitional/plain object data without inventing rule content. */
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
			effectNumber: toNonNegativeInteger(
				unwrapValue(resolution.effectNumber),
			),
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
