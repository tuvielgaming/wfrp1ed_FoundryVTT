import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
	ARMOUR_PIECE,
	ArmourData,
} from "../data-models/item/ArmourData.mjs";
import { EquipmentData } from "../data-models/item/EquipmentData.mjs";
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
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";
import { ArmourItemSheet } from "../sheets/ArmourItemSheet.mjs";
import { EquipmentItemSheet } from "../sheets/EquipmentItemSheet.mjs";
import { WeaponItemSheet } from "../sheets/WeaponItemSheet.mjs";
import { ArmourEquipValidator } from "./ArmourEquipValidator.mjs";
import { ArmourInitiativeRuleProvider } from "./ArmourInitiativeRuleProvider.mjs";
import { CombatDodgeEconomy } from "./CombatDodgeEconomy.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import {
	PARRY_ATTACK_COST_MODE,
} from "./CombatParryRules.mjs";
import { CombatParrySelection } from "./CombatParrySelection.mjs";
import { HandEquipValidator } from "./HandEquipValidator.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/**
 * Dependency-ordered bootstrap for the physical equipment contract required by
 * WFRP combat and inventory procedures. This intentionally precedes
 * attack/parry/action-economy code.
 */
Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED combat equipment requires the core system API to initialize first.",
		);
	}

	CONFIG.Item.dataModels.weapon = WeaponData;
	CONFIG.Item.dataModels.armour = ArmourData;
	CONFIG.Item.dataModels.equipment = EquipmentData;

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

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		EquipmentItemSheet,
		{
			types: ["equipment"],
			makeDefault: true,
		},
	);

	RuleEffectResolver.registerCandidateProvider(
		"armour-initiative",
		(input) => ArmourInitiativeRuleProvider.candidates(input),
	);

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		combat: Object.freeze({
			...(game.WFRP1ED.combat ?? {}),
			parrySelection: CombatParrySelection,
			dodge: CombatDodgeEconomy,
		}),
		equipment: Object.freeze({
			resolver: CombatEquipment,
			state: CombatEquipmentState,
			armourValidator: ArmourEquipValidator,
			handValidator: HandEquipValidator,
			initiativeRuleProvider: ArmourInitiativeRuleProvider,
			inventoryMode: INVENTORY_MODE,
			inventoryHand: INVENTORY_HAND,
			weaponKind: WEAPON_KIND,
			weaponGroup: WEAPON_GROUP,
			weaponHandedness: WEAPON_HANDEDNESS,
			armourClass: ARMOUR_CLASS,
			armourPiece: ARMOUR_PIECE,
			armourLocations: ARMOUR_LOCATIONS,
			parryAttackCostMode: PARRY_ATTACK_COST_MODE,
		}),
	});
});
