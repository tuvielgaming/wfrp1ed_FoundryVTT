import {
	INVENTORY_MODE,
	inventorySchema,
	normalizeInventoryHand,
	normalizeInventoryMode,
	toBoolean,
	toNonNegativeInteger,
	toNonNegativeNumber,
	unwrapText,
	unwrapValue,
} from "./InventoryItemFields.mjs";
import {
	AMMUNITION_TYPE,
	ammunitionIdentity,
	CONTAINER_KIND,
	EQUIPMENT_KIND,
	normalizeAmmunitionType,
	normalizeContainerKind,
	normalizeCustomId,
	normalizeEquipmentKind,
} from "./AmmunitionTypes.mjs";

const {
	BooleanField,
	NumberField,
	StringField,
} = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

const EQUIPMENT_MODES = Object.freeze([
	INVENTORY_MODE.CARRIED,
	INVENTORY_MODE.HELD,
	INVENTORY_MODE.WORN,
]);

/**
 * Native Foundry v14 data model for ordinary WFRP 1e Equipment Items.
 *
 * Equipment shares the same inventory state contract as Weapon and Armour so
 * rules which care about carried/held/worn objects do not need to special-case
 * legacy template.json fields or localized Item names.
 *
 * Quantity has two distinct meanings for stackable Core equipment:
 * - `referenceQuantity` is the authored package quantity to which listed price
 *   and Encumbrance apply;
 * - `quantity` is the current amount represented by this owned Item.
 *
 * Ammunition is deliberately an Equipment subtype rather than another Foundry
 * Item type. The concrete Equipment Item is the ammunition variant: two Arrow
 * stacks can therefore share compatibility while having different names and
 * embedded ActiveEffects.
 *
 * Containers keep their existing relationship contract through `containerId`.
 * A Quick Access Ammunition container adds one compatible ammunition identity
 * plus a unit capacity. Capacity counts ammunition units, not generic inventory
 * slots or Encumbrance; ordinary containers remain governed by normal inventory
 * and Encumbrance rules.
 */
export class EquipmentData extends TypeDataModel {
	static defineSchema() {
		return {
			...inventorySchema({
				allowedModes: EQUIPMENT_MODES,
				defaultMode: INVENTORY_MODE.CARRIED,
			}),
			referenceQuantity: positiveIntegerField(1),
			isWealth: booleanField(false),
			isContainer: booleanField(false),
			isClothing: booleanField(false),
			containerId: textField(),
			equipmentKind: textField(EQUIPMENT_KIND.STANDARD),
			ammunitionType: textField(AMMUNITION_TYPE.NONE),
			ammunitionCustomId: textField(),
			containerKind: textField(CONTAINER_KIND.STANDARD),
			containerAmmunitionType: textField(AMMUNITION_TYPE.NONE),
			containerAmmunitionCustomId: textField(),
			containerCapacity: nonNegativeIntegerField(),
		};
	}

	static migrateData(source, options = {}) {
		const sourceObject = objectValue(source);
		const migrated = foundry.utils.deepClone(sourceObject);

		/*
		 * Foundry v14 also runs TypeDataModel migration/cleaning for differential
		 * updates. Migration must therefore be sparse: normalize only properties
		 * actually supplied by the candidate source. Filling absent properties
		 * with defaults would turn a quantity/location update into an accidental
		 * replacement of Encumbrance, price, state, etc.
		 */
		migrateSparseInventoryFields(migrated, sourceObject);

		if (Object.hasOwn(sourceObject, "referenceQuantity")) {
			migrated.referenceQuantity = positiveInteger(
				unwrapValue(sourceObject.referenceQuantity),
				1,
			);
		} else if (shouldSeedLegacyReferenceQuantity(sourceObject)) {
			migrated.referenceQuantity = positiveInteger(
				unwrapValue(sourceObject.quantity),
				1,
			);
		}

		if (
			Object.hasOwn(sourceObject, "isWealth") ||
			Object.hasOwn(sourceObject, "inventorySection")
		) {
			migrated.isWealth = toBoolean(sourceObject.isWealth) ||
				String(sourceObject.inventorySection ?? "")
					.trim()
					.toLowerCase() === "wealth";
		}
		delete migrated.inventorySection;

		if (Object.hasOwn(sourceObject, "isContainer")) {
			migrated.isContainer = toBoolean(sourceObject.isContainer);
		}
		if (Object.hasOwn(sourceObject, "isClothing")) {
			migrated.isClothing = toBoolean(sourceObject.isClothing);
		}
		if (Object.hasOwn(sourceObject, "containerId")) {
			migrated.containerId = unwrapText(sourceObject.containerId);
		}
		if (Object.hasOwn(sourceObject, "equipmentKind")) {
			migrated.equipmentKind = normalizeEquipmentKind(
				unwrapText(sourceObject.equipmentKind),
			);
		}
		if (Object.hasOwn(sourceObject, "ammunitionType")) {
			migrated.ammunitionType = normalizeAmmunitionType(
				unwrapText(sourceObject.ammunitionType),
				AMMUNITION_TYPE.NONE,
			);
		}
		if (Object.hasOwn(sourceObject, "ammunitionCustomId")) {
			migrated.ammunitionCustomId = normalizeCustomId(
				unwrapText(sourceObject.ammunitionCustomId),
			);
		}
		if (Object.hasOwn(sourceObject, "containerKind")) {
			migrated.containerKind = normalizeContainerKind(
				unwrapText(sourceObject.containerKind),
			);
		}
		if (Object.hasOwn(sourceObject, "containerAmmunitionType")) {
			migrated.containerAmmunitionType = normalizeAmmunitionType(
				unwrapText(sourceObject.containerAmmunitionType),
				AMMUNITION_TYPE.NONE,
			);
		}
		if (Object.hasOwn(sourceObject, "containerAmmunitionCustomId")) {
			migrated.containerAmmunitionCustomId = normalizeCustomId(
				unwrapText(sourceObject.containerAmmunitionCustomId),
			);
		}
		if (Object.hasOwn(sourceObject, "containerCapacity")) {
			migrated.containerCapacity = toNonNegativeInteger(
				unwrapValue(sourceObject.containerCapacity),
			);
		}

		return super.migrateData(migrated, options);
	}

	/** @inheritDoc */
	prepareDerivedData() {
		super.prepareDerivedData();

		const referenceQuantity = Math.max(
			1,
			toNonNegativeInteger(this.referenceQuantity, 1),
		);
		const quantity = toNonNegativeInteger(this.quantity);
		const referenceEncumbrance = toNonNegativeNumber(this.encumbrance);

		this.totalEncumbrance =
			(quantity / referenceQuantity) * referenceEncumbrance;
	}
}

export function equipmentAmmunitionSnapshot(item) {
	if (item?.type !== "equipment") return null;
	const system = item.system ?? {};
	if (system.equipmentKind !== EQUIPMENT_KIND.AMMUNITION) return null;
	const identity = ammunitionIdentity({
		type: system.ammunitionType,
		customId: system.ammunitionCustomId,
	});
	if (identity.type === AMMUNITION_TYPE.NONE) return null;
	return Object.freeze({
		...identity,
		quantity: toNonNegativeInteger(system.quantity),
	});
}

export function quickAmmunitionContainerSnapshot(item) {
	if (item?.type !== "equipment") return null;
	const system = item.system ?? {};
	if (
		system.isContainer !== true ||
		system.containerKind !== CONTAINER_KIND.QUICK_AMMUNITION
	) return null;
	const identity = ammunitionIdentity({
		type: system.containerAmmunitionType,
		customId: system.containerAmmunitionCustomId,
	});
	if (identity.type === AMMUNITION_TYPE.NONE) return null;
	return Object.freeze({
		...identity,
		capacity: toNonNegativeInteger(system.containerCapacity),
	});
}

function migrateSparseInventoryFields(migrated, source) {
	if (Object.hasOwn(source, "description")) {
		migrated.description = unwrapText(source.description);
	}

	if (
		Object.hasOwn(source, "gmDescription") ||
		Object.hasOwn(source, "gmdescription")
	) {
		migrated.gmDescription = unwrapText(
			source.gmDescription ?? source.gmdescription,
		);
		delete migrated.gmdescription;
	}

	if (Object.hasOwn(source, "quantity")) {
		migrated.quantity = toNonNegativeInteger(
			unwrapValue(source.quantity),
			1,
		);
	}

	if (
		Object.hasOwn(source, "encumbrance") ||
		Object.hasOwn(source, "weight")
	) {
		migrated.encumbrance = toNonNegativeNumber(
			unwrapValue(source.encumbrance ?? source.weight),
		);
		delete migrated.weight;
	}

	if (Object.hasOwn(source, "price")) {
		const price = objectValue(source.price);
		const migratedPrice = {};
		for (const denomination of ["gc", "ss", "bp"]) {
			if (!Object.hasOwn(price, denomination)) continue;
			migratedPrice[denomination] = toNonNegativeInteger(
				unwrapValue(price[denomination]),
			);
		}
		migrated.price = migratedPrice;
	}

	if (Object.hasOwn(source, "priceFormula")) {
		migrated.priceFormula = unwrapText(source.priceFormula);
	}

	if (Object.hasOwn(source, "availability")) {
		migrated.availability = unwrapText(source.availability);
	}

	if (
		Object.hasOwn(source, "storageLocation") ||
		Object.hasOwn(source, "location")
	) {
		migrated.storageLocation = unwrapText(
			source.storageLocation ?? source.location,
		);
		delete migrated.location;
	}

	migrateSparseState(migrated, source);
}

function migrateSparseState(migrated, source) {
	const sourceState = objectValue(source.state);
	const hasState = Object.hasOwn(source, "state");
	const hasLegacyMode = ["held", "worn", "equipped"]
		.some((key) => Object.hasOwn(source, key));
	const hasLegacyHand = Object.hasOwn(source, "hand");

	if (!hasState && !hasLegacyMode && !hasLegacyHand) return;

	const state = foundry.utils.deepClone(sourceState);
	let requestedMode = Object.hasOwn(sourceState, "mode")
		? unwrapText(sourceState.mode)
		: "";

	if (!requestedMode && hasLegacyMode) {
		if (toBoolean(unwrapValue(source.held))) {
			requestedMode = INVENTORY_MODE.HELD;
		} else if (
			toBoolean(unwrapValue(source.worn)) ||
			toBoolean(unwrapValue(source.equipped))
		) {
			requestedMode = toBoolean(unwrapValue(source.isClothing))
				? INVENTORY_MODE.WORN
				: INVENTORY_MODE.HELD;
		}
	}

	if (requestedMode) {
		state.mode = normalizeInventoryMode(
			requestedMode,
			EQUIPMENT_MODES,
			INVENTORY_MODE.CARRIED,
		);
	}

	if (Object.hasOwn(sourceState, "hand") || hasLegacyHand) {
		state.hand = normalizeInventoryHand(
			sourceState.hand ?? source.hand,
		);
	}

	migrated.state = state;
	delete migrated.held;
	delete migrated.worn;
	delete migrated.equipped;
	delete migrated.hand;
}

function shouldSeedLegacyReferenceQuantity(source) {
	if (!Object.hasOwn(source, "quantity")) return false;
	if (Object.hasOwn(source, "referenceQuantity")) return false;

	return [
		"description",
		"gmDescription",
		"gmdescription",
		"encumbrance",
		"weight",
		"price",
		"priceFormula",
		"availability",
		"storageLocation",
		"location",
		"state",
		"isWealth",
		"inventorySection",
		"isContainer",
		"isClothing",
		"equipmentKind",
		"ammunitionType",
		"containerKind",
	].some((key) => Object.hasOwn(source, key));
}

function booleanField(initial = false) {
	return new BooleanField({
		required: true,
		nullable: false,
		initial,
	});
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

function positiveIntegerField(initial = 1) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min: 1,
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

function positiveInteger(value, fallback = 1) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return Math.max(1, Math.trunc(Number(fallback) || 1));
	}
	return Math.max(1, Math.trunc(number));
}

function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}
