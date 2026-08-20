import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
	toNonNegativeInteger,
	toNonNegativeNumber,
	unwrapValue,
} from "./InventoryItemFields.mjs";

const {
	BooleanField,
	NumberField,
} = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for ordinary WFRP 1e Equipment Items.
 *
 * Equipment shares the same inventory state contract as Weapon and Armour so
 * rules which care about carried/held objects do not need to special-case
 * legacy template.json fields or localized Item names.
 *
 * `isWealth` mirrors the two physical lists on the original WFRP 1e character
 * sheet. `false` means Equipment/Trappings; `true` means Wealth. A Boolean is
 * deliberately used because the printed sheet defines exactly those two
 * destinations and ordinary Equipment is the natural default.
 *
 * Quantity has two distinct meanings for stackable Core equipment:
 *
 * - `referenceQuantity` is the authored quantity to which the listed price and
 *   Encumbrance apply (for example 5 arrows or 10 firearm balls).
 * - `quantity` is the current amount represented by this owned Item.
 *
 * The Core tables can therefore remain unchanged while an owned stack changes
 * during play. `totalEncumbrance` is derived and is never persisted.
 */
export class EquipmentData extends TypeDataModel {
	static defineSchema() {
		return {
			...inventorySchema({
				allowedModes: [
					INVENTORY_MODE.CARRIED,
					INVENTORY_MODE.HELD,
				],
				defaultMode: INVENTORY_MODE.CARRIED,
			}),
			referenceQuantity: positiveIntegerField(1),
			isWealth: new BooleanField({
				required: true,
				nullable: false,
				initial: false,
			}),
		};
	}

	static migrateData(source, options = {}) {
		const migrated = migrateInventoryData(source, {
			allowedModes: [
				INVENTORY_MODE.CARRIED,
				INVENTORY_MODE.HELD,
			],
			defaultMode: INVENTORY_MODE.CARRIED,
			legacyEquippedMode: INVENTORY_MODE.HELD,
		});

		/*
		 * Existing Equipment predates the reference/current quantity split.
		 * Preserve the old quantity as the current amount and initialize the
		 * reference package from the same value. This keeps every existing Item's
		 * Encumbrance unchanged on migration.
		 */
		migrated.referenceQuantity = Math.max(
			1,
			toNonNegativeInteger(
				unwrapValue(
					source?.referenceQuantity ?? source?.quantity,
				),
				1,
			),
		);

		/* Transitional migration from the short-lived inventorySection field.
		 * Existing Wealth Items remain Wealth; all other ordinary Equipment keeps
		 * the printed-sheet default of Equipment/Trappings. */
		migrated.isWealth = migrated.isWealth === true ||
			String(migrated.inventorySection ?? "").trim().toLowerCase() === "wealth";
		delete migrated.inventorySection;

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

function positiveIntegerField(initial = 1) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min: 1,
	});
}
