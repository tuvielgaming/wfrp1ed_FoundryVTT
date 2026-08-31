import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
	toBoolean,
	toInteger,
	toNonNegativeInteger,
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

/**
 * Core armour-piece identities from the Body Areas and Armour table.
 *
 * Layering legality in WFRP 1e is defined by specific pieces, not by a generic
 * "one leather + one mail + one plate" stack. Keeping this identity explicit
 * lets the equip validator enforce exactly the combinations named by the Core
 * rules while still allowing custom armour through CUSTOM.
 */
export const ARMOUR_PIECE = Object.freeze({
	SHIELD: "shield",
	LEATHER_COIF: "leatherCoif",
	LEATHER_JERKIN: "leatherJerkin",
	LEATHER_JACKET: "leatherJacket",
	MAIL_SHIRT: "mailShirt",
	SLEEVED_MAIL_SHIRT: "sleevedMailShirt",
	MAIL_COAT: "mailCoat",
	SLEEVED_MAIL_COAT: "sleevedMailCoat",
	MAIL_COIF: "mailCoif",
	BREASTPLATE: "breastplate",
	BACK_PLATE: "backPlate",
	MAIL_ARM_BRACER: "mailArmBracer",
	PLATE_ARM_BRACER: "plateArmBracer",
	GAUNTLETS: "gauntlets",
	LEGGINGS: "leggings",
	HELMET: "helmet",
	POT_HELMET: "potHelmet",
	CUSTOM: "custom",
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
 * is location-based and may be layered only in the explicit Core combinations.
 * The equip validator owns that legality; this model stores the authored facts.
 *
 * `piece` is the canonical structured Core armour identity used by layering and
 * equipment rules. A second generic Rules ID is intentionally not stored: it
 * would duplicate `piece` without adding a separate mechanical role.
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

			armourClass: textField(ARMOUR_CLASS.OTHER),
			piece: textField(ARMOUR_PIECE.CUSTOM),
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

		/* `rulesId` was an early generic identity field. Armour now uses the
		 * structured `piece` identity exclusively, so legacy values are discarded
		 * rather than migrated into another redundant field. */
		delete migrated.rulesId;

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
		migrated.piece = normalizeAllowed(
			sourceObject.piece,
			Object.values(ARMOUR_PIECE),
			inferCorePiece(migrated),
		);
		migrated.parry = {
			suitable: toBoolean(parry.suitable),
			bonus: toInteger(parry.bonus),
		};

		return super.migrateData(migrated, options);
	}
}

function inferCorePiece(system) {
	const armourClass = String(system?.armourClass ?? "");
	const coverage = system?.coverage ?? {};
	const locations = ARMOUR_LOCATIONS.filter(
		(location) => coverage[location] === true,
	);
	const key = [...locations].sort().join("|");

	if (armourClass === ARMOUR_CLASS.SHIELD) {
		return ARMOUR_PIECE.SHIELD;
	}

	if (armourClass === ARMOUR_CLASS.LEATHER) {
		switch (key) {
			case "head": return ARMOUR_PIECE.LEATHER_COIF;
			case "body": return ARMOUR_PIECE.LEATHER_JERKIN;
			case "body|leftArm|rightArm": return ARMOUR_PIECE.LEATHER_JACKET;
			default:
				break;
		}
	}

	if (armourClass === ARMOUR_CLASS.MAIL) {
		switch (key) {
			case "body": return ARMOUR_PIECE.MAIL_SHIRT;
			case "body|leftArm|rightArm": return ARMOUR_PIECE.SLEEVED_MAIL_SHIRT;
			case "body|leftLeg|rightLeg": return ARMOUR_PIECE.MAIL_COAT;
			case "body|leftArm|leftLeg|rightArm|rightLeg": return ARMOUR_PIECE.SLEEVED_MAIL_COAT;
			case "head": return ARMOUR_PIECE.MAIL_COIF;
			case "leftArm":
			case "rightArm":
			case "leftArm|rightArm":
				return ARMOUR_PIECE.MAIL_ARM_BRACER;
			case "leftLeg":
			case "rightLeg":
			case "leftLeg|rightLeg":
				return ARMOUR_PIECE.LEGGINGS;
			default:
				break;
		}
	}

	if (armourClass === ARMOUR_CLASS.PLATE) {
		switch (key) {
			case "body": return ARMOUR_PIECE.BREASTPLATE;
			case "head": return ARMOUR_PIECE.HELMET;
			case "leftArm":
			case "rightArm":
			case "leftArm|rightArm":
				return ARMOUR_PIECE.PLATE_ARM_BRACER;
			case "leftLeg":
			case "rightLeg":
			case "leftLeg|rightLeg":
				return ARMOUR_PIECE.LEGGINGS;
			default:
				break;
		}
	}

	return ARMOUR_PIECE.CUSTOM;
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
	const normalized = String(value ?? "").trim();
	return allowed.includes(normalized) ? normalized : fallback;
}

function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}
