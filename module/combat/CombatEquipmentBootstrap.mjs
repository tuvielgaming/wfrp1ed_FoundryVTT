import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
	ArmourData,
} from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import {
	WEAPON_GROUP,
	WEAPON_HANDEDNESS,
	WEAPON_KIND,
	WeaponData,
} from "../data-models/item/WeaponData.mjs";
import { ArmourItemSheet } from "../sheets/ArmourItemSheet.mjs";
import { WeaponItemSheet } from "../sheets/WeaponItemSheet.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/**
 * Dependency-ordered bootstrap for the physical equipment contract required by
 * WFRP combat. This intentionally precedes attack/parry/action-economy code.
 */
Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED combat equipment requires the core system API to initialize first.",
		);
	}

	CONFIG.Item.dataModels.weapon = WeaponData;
	CONFIG.Item.dataModels.armour = ArmourData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		WeaponItemSheet,
		{
			types: ["weapon"],
			makeDefault: true,
		},
	);

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		ArmourItemSheet,
		{
			types: ["armour"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		equipment: Object.freeze({
			resolver: CombatEquipment,
			inventoryMode: INVENTORY_MODE,
			inventoryHand: INVENTORY_HAND,
			weaponKind: WEAPON_KIND,
			weaponGroup: WEAPON_GROUP,
			weaponHandedness: WEAPON_HANDEDNESS,
			armourClass: ARMOUR_CLASS,
			armourLocations: ARMOUR_LOCATIONS,
		}),
	});
});
