import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
} from "./InventoryItemFields.mjs";

const { BooleanField } = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for ordinary physical equipment.
 *
 * Equipment shares the same inventory state contract as Weapon and Armour so
 * rules which care about carried/held objects do not need to special-case
 * legacy template.json fields or localized Item names.
 *
 * `isWealth` mirrors the two physical lists on the original WFRP 1e character
 * sheet. `false` means Equipment/Trappings; `true` means Wealth. A Boolean is
 * deliberately used because the printed sheet defines exactly those two
 * destinations and ordinary Equipment is the natural default.
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

		/* Transitional migration from the short-lived inventorySection field.
		 * Existing Wealth Items remain Wealth; all other ordinary Equipment keeps
		 * the printed-sheet default of Equipment/Trappings. */
		migrated.isWealth = migrated.isWealth === true ||
			String(migrated.inventorySection ?? "").trim().toLowerCase() === "wealth";
		delete migrated.inventorySection;

		return super.migrateData(migrated, options);
	}
}
