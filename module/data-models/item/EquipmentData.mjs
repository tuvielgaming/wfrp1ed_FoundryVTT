import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
} from "./InventoryItemFields.mjs";

const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for ordinary physical equipment.
 *
 * Equipment shares the same inventory state contract as Weapon and Armour so
 * rules which care about carried/held objects do not need to special-case
 * legacy template.json fields or localized Item names.
 */
export class EquipmentData extends TypeDataModel {
	static defineSchema() {
		return inventorySchema({
			allowedModes: [
				INVENTORY_MODE.CARRIED,
				INVENTORY_MODE.HELD,
			],
			defaultMode: INVENTORY_MODE.CARRIED,
		});
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

		return super.migrateData(migrated, options);
	}
}
