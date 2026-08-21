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
 * `isWealth` mirrors the two physical lists on the original WFRP 1e character
 * sheet. `false` means Equipment/Trappings; `true` means Wealth. A Boolean is
 * deliberately used because the printed sheet defines exactly those two
 * destinations and ordinary Equipment is the natural default.
 *
 * `isClothing` is an authored rules fact used by Core Encumbrance: clothing
 * worn on the character contributes no personal Encumbrance, while the same
 * clothing carried in a bag/container does. `worn` remains available in the
 * state schema so this distinction is explicit rather than inferred from names.
 *
 * Quantity has two distinct meanings for stackable Core equipment:
 *
 * - `referenceQuantity` is the authored quantity to which the listed price and
 *   Encumbrance apply (for example 5 arrows or 10 firearm balls).
 * - `quantity` is the current amount represented by this owned Item.
 *
 * Containers use two separate facts:
 *
 * - `isContainer` says an Equipment definition can contain other Equipment.
 * - `containerId` is an owned-instance relationship to another Equipment Item
 *   embedded in the same Actor. World/Compendium definitions normally keep it
 *   blank. UI/services must validate the referenced parent and prevent cycles.
 *
 * The Core tables can therefore remain unchanged while an owned stack changes
 * during play. `totalEncumbrance` is derived and is never persisted.
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
			/*
			 * Existing Equipment predates the reference/current quantity split.
			 * A complete legacy Item source has more authored inventory fields than
			 * a differential quantity update, so initialize its reference package
			 * from the old quantity exactly once during construction/migration.
			 */
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
			requestedMode = INVENTORY_MODE.WORN;
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

	/*
	 * A differential current-quantity update contains only `quantity`. A stored
	 * legacy Item source contains other authored inventory facts. Requiring at
	 * least one such fact prevents later quantity changes from redefining the
	 * reference package.
	 */
	return [
		"description",
		"gmDescription",
		"gmdescription",
		"encumbrance",
		"weight",
		"price",
		"availability",
		"storageLocation",
		"location",
		"state",
		"isWealth",
		"inventorySection",
		"isContainer",
		"isClothing",
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
