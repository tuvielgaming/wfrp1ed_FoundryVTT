import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";
import {
	COMBAT_ATTACK_TARGET_MODE,
	CombatAttackResolution,
} from "./CombatAttackResolution.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import { PendingCombatAttack } from "./PendingCombatAttack.mjs";

/**
 * User-facing entry point for weapon attacks.
 *
 * A started Combat encounter adds turn/resource automation when this Actor is a
 * participant. It is not a prerequisite for the basic weapon Test: an Actor
 * outside the active encounter may still roll an equipped melee weapon and no
 * Combatant Attacks are spent automatically.
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

		/*
		 * If this Actor participates in the started encounter, enforce the active
		 * turn before opening UI. If it does not participate, this is an unmanaged
		 * out-of-combat attack and no A availability check applies.
		 */
		const combatant = CombatAttackResolution.combatantFor(actor);
		if (combatant) {
			const economy = CombatAttackEconomy.snapshot(combatant);
			if (!economy.canAttack) {
				throw new Error(localize(
					"This Combatant has no Attack available in the current attack window.",
					"Ten uczestnik walki nie ma dostępnego Ataku w bieżącym oknie ataku.",
				));
			}
		}

		const configuration = await CombatAttackDialog.configure(actor, weapon);
		if (!configuration) return null;

		if (configuration.targetMode === COMBAT_ATTACK_TARGET_MODE.NONE) {
			return CombatAttackResolution.execute(
				actor,
				weapon,
				configuration,
				{
					targetMode: COMBAT_ATTACK_TARGET_MODE.NONE,
					target: null,
				},
			);
		}

		if (configuration.target) {
			return CombatAttackResolution.execute(
				actor,
				weapon,
				configuration,
				{
					targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
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
