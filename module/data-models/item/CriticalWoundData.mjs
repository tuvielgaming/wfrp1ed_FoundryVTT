const {
	ArrayField,
	BooleanField,
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
 * `consequence` is deliberately rule-result agnostic. A user-created wound and
 * a Core Rulebook wound use the same declarative primitives; runtime consumers
 * never need to hard-code "Leg #4", "Body #9", or any other named result.
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
			 * Declarative automation authored on the wound itself.
			 *
			 * Supported primitives are intentionally generic:
			 * - characteristic modifications;
			 * - a random/fixed round duration or medical-attention lifetime;
			 * - periodic direct Wound loss;
			 * - one-shot held-item drops.
			 *
			 * Future status/action/limb primitives extend this schema without adding
			 * per-Critical special cases to the engine.
			 */
			consequence: new SchemaField({
				enabled: new BooleanField({
					required: true,
					nullable: false,
					initial: false,
				}),
				characteristics: new ArrayField(
					new SchemaField({
						characteristicId: textField(),
						operation: textField(),
						value: finiteNumberField(),
					}),
					{
						required: true,
						nullable: false,
						initial: [],
					},
				),
				duration: new SchemaField({
					formula: textField(),
					units: textField(),
					until: textField(),
				}),
				periodicWounds: new SchemaField({
					formula: textField(),
					until: textField(),
				}),
				dropHeld: textField(),
			}),

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

	/**
	 * Normalize transitional/plain object data without inventing rule content.
	 *
	 * Foundry also calls DataModel migration for partial document updates. A
	 * migration must therefore never manufacture default values for sibling keys
	 * which were absent from the update payload. Doing so used to make an edit to
	 * `description`, `hitLocation`, or `criticalValue` replace the complete
	 * consequence/resolution structures with empty defaults.
	 */
	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(source ?? {});

		if (Object.hasOwn(migrated, "description")) {
			migrated.description = unwrapText(migrated.description);
		}
		if (Object.hasOwn(migrated, "hitLocation")) {
			migrated.hitLocation = unwrapText(migrated.hitLocation);
		}
		if (Object.hasOwn(migrated, "criticalValue")) {
			migrated.criticalValue = toNonNegativeInteger(
				unwrapValue(migrated.criticalValue),
			);
		}
		if (Object.hasOwn(migrated, "consequence")) {
			migrated.consequence = normalizeConsequence(migrated.consequence ?? {});
		}
		if (Object.hasOwn(migrated, "resolution")) {
			migrated.resolution = normalizeResolution(migrated.resolution ?? {});
		}

		return super.migrateData(migrated, options);
	}
}

function normalizeConsequence(source) {
	const duration = source?.duration ?? {};
	const periodicWounds = source?.periodicWounds ?? {};
	const characteristics = Array.isArray(source?.characteristics)
		? source.characteristics
			.map((entry) => ({
				characteristicId: unwrapText(entry?.characteristicId),
				operation: unwrapText(entry?.operation),
				value: toFiniteNumber(unwrapValue(entry?.value)),
			}))
			.filter((entry) => entry.characteristicId && entry.operation)
		: [];

	return {
		enabled: source?.enabled === true,
		characteristics,
		duration: {
			formula: unwrapText(duration.formula),
			units: unwrapText(duration.units),
			until: unwrapText(duration.until),
		},
		periodicWounds: {
			formula: unwrapText(periodicWounds.formula),
			until: unwrapText(periodicWounds.until),
		},
		dropHeld: unwrapText(source?.dropHeld),
	};
}

function normalizeResolution(source) {
	return {
		damagePacketId: unwrapText(source.damagePacketId),
		sourceMessageId: unwrapText(source.sourceMessageId),
		resultMessageId: unwrapText(source.resultMessageId),
		tableRole: unwrapText(source.tableRole),
		tableVariant: unwrapText(source.tableVariant),
		providerId: unwrapText(source.providerId),
		tableUuid: unwrapText(source.tableUuid),
		tableResultId: unwrapText(source.tableResultId),
		effectNumber: toNonNegativeInteger(
			unwrapValue(source.effectNumber),
		),
		roll: toNonNegativeInteger(unwrapValue(source.roll)),
		resolvedByUserId: unwrapText(source.resolvedByUserId),
		resolvedAt: toNonNegativeInteger(
			unwrapValue(source.resolvedAt),
		),
	};
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

function finiteNumberField() {
	return new NumberField({
		required: true,
		nullable: false,
		initial: 0,
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

function toFiniteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}
