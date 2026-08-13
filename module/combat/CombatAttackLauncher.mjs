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

		/*
		 * Reject impossible declarations before opening any UI. This does not
		 * reserve/spend A; the authoritative spend still happens only when a fully
		 * configured attack is actually executed. A pending target card can still
		 * become stale if another action spends the last A before it is resolved.
		 */
		const combatant = activeCombatantFor(actor);
		const economy = CombatAttackEconomy.snapshot(combatant);
		if (!economy.canAttack) {
			throw new Error(localize(
				"This Combatant has no Attack available in the current attack window.",
				"Ten uczestnik walki nie ma dostępnego Ataku w bieżącym oknie ataku.",
			));
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

function activeCombatantFor(actor) {
	const combat = game.combat;
	if (!combat?.started || !combat.combatant) {
		throw new Error(localize(
			"A weapon attack requires an active Foundry Combat turn.",
			"Atak bronią wymaga aktywnej tury w walce Foundry.",
		));
	}

	const combatant = combat.combatant;
	if (combatant.actor?.uuid !== actor?.uuid) {
		throw new Error(localize(
			"This Actor is not the Combatant whose turn is currently active.",
			"Ten Aktor nie jest uczestnikiem, którego tura jest aktualnie aktywna.",
		));
	}
	return combatant;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
