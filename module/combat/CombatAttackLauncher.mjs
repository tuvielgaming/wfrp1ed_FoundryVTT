import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackResolution } from "./CombatAttackResolution.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import { PendingCombatAttack } from "./PendingCombatAttack.mjs";

/**
 * User-facing entry point for weapon attacks.
 *
 * Only the audited melee vertical slice is executable today. Ranged Weapon
 * Items deliberately remain non-rollable until their Draw/Load/Aim/Fire
 * lifecycle is implemented; Core p.126 explicitly says the Attacks
 * characteristic does not determine missile firing rate.
 */
export class CombatAttackLauncher {
	static canLaunch(weapon) {
		return Boolean(
			weapon?.type === "weapon" &&
			weapon.system?.kind === WEAPON_KIND.MELEE &&
			CombatEquipmentState.isUsed(weapon),
		);
	}

	static async launch(actor, weapon) {
		if (!this.canLaunch(weapon)) {
			throw new Error(localize(
				"Only an equipped melee weapon can currently launch an attack.",
				"Obecnie atak można rozpocząć tylko używaną bronią do walki wręcz.",
			));
		}
		if (weapon.parent?.uuid !== actor?.uuid) {
			throw new Error("The selected Weapon is not owned by this Actor.");
		}

		const configuration = await CombatAttackDialog.configure(actor, weapon);
		if (!configuration) return null;

		if (configuration.target) {
			return CombatAttackResolution.execute(
				actor,
				weapon,
				configuration,
				{
					targetMode: "defender",
					target: configuration.target,
				},
			);
		}

		return PendingCombatAttack.create(actor, weapon, configuration);
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
