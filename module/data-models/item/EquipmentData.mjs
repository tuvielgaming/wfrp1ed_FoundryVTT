import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
} from "./InventoryItemFields.mjs";

const { StringField } = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

export const EQUIPMENT_SECTION = Object.freeze({
	EQUIPMENT: "equipment",
	WEALTH: "wealth",
});

const EQUIPMENT_SECTIONS = Object.freeze(
	Object.values(EQUIPMENT_SECTION),
);

/**
 * Native Foundry v14 data model for ordinary physical equipment.
 *
 * Equipment shares the same inventory state contract as Weapon and Armour so
 * rules which care about carried/held objects do not need to special-case
 * legacy template.json fields or localized Item names.
 *
 * `inventorySection` mirrors the two physical lists on the original WFRP 1e
 * character sheet: Equipment/Trappings and Wealth. It is deliberately owned by
 * ordinary Equipment rather than Actor money fields so coins, jewellery and
 * other valuables remain transferable physical Items with location and
 * encumbrance.
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
			inventorySection: new StringField({
				required: true,
				nullable: false,
				blank: false,
				initial: EQUIPMENT_SECTION.EQUIPMENT,
				choices: EQUIPMENT_SECTIONS,
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

		migrated.inventorySection = normalizeEquipmentSection(
			migrated.inventorySection,
		);

		return super.migrateData(migrated, options);
	}
}

export function normalizeEquipmentSection(value) {
	const normalized = String(value ?? "").trim().toLowerCase();
	return EQUIPMENT_SECTIONS.includes(normalized)
		? normalized
		: EQUIPMENT_SECTION.EQUIPMENT;
}
