import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
	toBoolean,
	toInteger,
	toNonNegativeInteger,
	unwrapText,
	unwrapValue,
} from "./InventoryItemFields.mjs";

const {
	BooleanField,
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

export const ARMOUR_CLASS = Object.freeze({
	SHIELD: "shield",
	MAIL: "mail",
	PLATE: "plate",
	LEATHER: "leather",
	OTHER: "other",
});

export const ARMOUR_LOCATIONS = Object.freeze([
	"head",
	"body",
	"rightArm",
	"leftArm",
	"rightLeg",
	"leftLeg",
]);

/**
 * Native Foundry v14 data model for WFRP 1e armour.
 *
 * Armour Points and body-area coverage are stored per Item because WFRP armour
 * is location-based and may be layered. Whether a particular combination may
 * legally be layered is a combat/equipment rule, not a template calculation.
 *
 * Shields are represented as armour because their main-rule function is AP 1
 * over all body areas. A shield may additionally be authored as a parrying
 * item with the Core +20 WS parry bonus.
 */
export class ArmourData extends TypeDataModel {
	static defineSchema() {
		return {
			...inventorySchema({
				allowedModes: [
					INVENTORY_MODE.CARRIED,
					INVENTORY_MODE.WORN,
					INVENTORY_MODE.HELD,
				],
			}),

			rulesId: textField(),
			armourClass: textField(ARMOUR_CLASS.OTHER),
			armourPoints: nonNegativeIntegerField(),

			coverage: new SchemaField({
				head: booleanField(),
				body: booleanField(),
				rightArm: booleanField(),
				leftArm: booleanField(),
				rightLeg: booleanField(),
				leftLeg: booleanField(),
			}),

			parry: new SchemaField({
				suitable: booleanField(),
				bonus: integerField(),
			}),
		};
	}

	static migrateData(source, options = {}) {
		const migrated = migrateInventoryData(source, {
			allowedModes: [
				INVENTORY_MODE.CARRIED,
				INVENTORY_MODE.WORN,
				INVENTORY_MODE.HELD,
			],
			legacyEquippedMode: INVENTORY_MODE.WORN,
		});
		const sourceObject = source && typeof source === "object"
			? source
			: {};
		const coverage = objectValue(sourceObject.coverage);
		const coveredAreas = Array.isArray(sourceObject.areas)
			? sourceObject.areas.map((entry) => String(entry ?? "").trim())
			: [];
		const parry = objectValue(sourceObject.parry);

		migrated.rulesId = unwrapText(sourceObject.rulesId);
		migrated.armourClass = normalizeAllowed(
			sourceObject.armourClass ?? sourceObject.armorClass,
			Object.values(ARMOUR_CLASS),
			ARMOUR_CLASS.OTHER,
		);
		migrated.armourPoints = toNonNegativeInteger(
			unwrapValue(
				sourceObject.armourPoints ??
				sourceObject.armorPoints ??
				sourceObject.ap,
			),
		);
		migrated.coverage = Object.fromEntries(
			ARMOUR_LOCATIONS.map((location) => [
				location,
				Object.hasOwn(coverage, location)
					? toBoolean(coverage[location])
					: coveredAreas.includes(location),
			]),
		);
		migrated.parry = {
			suitable: toBoolean(parry.suitable),
			bonus: toInteger(parry.bonus),
		};

		return super.migrateData(migrated, options);
	}
}

function textField(initial = "") {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial,
		trim: true,
	});
}

function booleanField(initial = false) {
	return new BooleanField({
		required: true,
		nullable: false,
		initial,
	});
}

function integerField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
	});
}

function nonNegativeIntegerField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min: 0,
	});
}

function normalizeAllowed(value, allowed, fallback) {
	const normalized = unwrapText(value);
	return allowed.includes(normalized) ? normalized : fallback;
}

function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}
