import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";
import {
	PARRY_ATTACK_COST_MODE,
} from "./CombatParryRules.mjs";

/**
 * Build and validate the tactical parry choices for one Combatant.
 *
 * The selection is deliberately Item-based. A defender holding both a suitable
 * one-handed weapon and a shield must choose which Item performs the parry;
 * the system must not silently prefer either option. The selected Item carries
 * both its WS modifier and its Core Attacks-resource cost mode.
 *
 * This service does not render UI and does not roll WS. The future pending
 * defence transaction consumes this contract when it asks the defender to
 * choose Parry / Dodge / no defence.
 */
export class CombatParrySelection {
	/**
	 * Return presentation-safe parry choices for the Combatant's current state.
	 *
	 * `attackCost` is a preview calculated from the current remaining Attacks.
	 * The authoritative cost is recalculated when the choice is committed.
	 *
	 * @param {Combatant} combatant
	 * @param {Object} [options]
	 * @param {boolean} [options.optionalWeaponModifiers=false]
	 * @returns {Object}
	 */
	static choices(
		combatant,
		{
			optionalWeaponModifiers = false,
		} = {},
	) {
		assertCombatant(combatant);
		const actor = assertActor(combatant.actor);
		const economy = CombatAttackEconomy.snapshot(combatant);
		const remainingAttacks = economy.remaining;

		const parryOptions = economy.canParry
			? CombatEquipment.parryOptions(actor, {
				optionalWeaponModifiers,
			})
			: [];

		const choices = parryOptions.map((option) => {
			const attackCost = previewAttackCost(
				option.attackCostMode,
				remainingAttacks,
			);

			return Object.freeze({
				...option,
				attackCost,
				remainingAttacksBefore: remainingAttacks,
				remainingAttacksAfter: Math.max(
					0,
					remainingAttacks - attackCost,
				),
			});
		});

		return foundry.utils.deepFreeze({
			combatId: economy.combatId,
			combatantId: economy.combatantId,
			actorUuid: economy.actorUuid,
			remainingAttacks,
			parryAttemptsRemaining: economy.parryAttemptsRemaining,
			resourceCanParry: economy.canParry,
			canParry: economy.canParry && choices.length > 0,
			choices,
		});
	}

	/**
	 * Resolve one currently legal Item choice by UUID.
	 *
	 * This always rebuilds the choices from current Actor/Combatant state so a
	 * stale dialog cannot keep using an Item which has been put away, dropped,
	 * or otherwise stopped being a valid parry source.
	 *
	 * @param {Combatant} combatant
	 * @param {string} itemUuid
	 * @param {Object} [options]
	 * @param {boolean} [options.optionalWeaponModifiers=false]
	 * @returns {Object}
	 */
	static choice(
		combatant,
		itemUuid,
		{
			optionalWeaponModifiers = false,
		} = {},
	) {
		const selection = this.choices(combatant, {
			optionalWeaponModifiers,
		});

		if (!selection.resourceCanParry) {
			throw new Error(
				"No Attacks remain to spend on a parry this round.",
			);
		}

		const requestedUuid = String(itemUuid ?? "");
		const selected = selection.choices.find(
			(choice) => choice.itemUuid === requestedUuid,
		);

		if (!selected) {
			throw new Error(
				"The selected Item is not currently available for parrying.",
			);
		}

		return selected;
	}

	/**
	 * GM-authoritatively spend the cost of the selected parry Item.
	 *
	 * The future defence-response socket/transaction passes the original user
	 * here. The selected Item is re-resolved on the GM before the attack economy
	 * is mutated, so a client does not get to submit an arbitrary cheaper cost
	 * mode for a shield parry.
	 *
	 * This method spends the resource only. It intentionally does not make the
	 * WS roll; that belongs to the pending defence transaction which owns the
	 * complete attack/defence resolution.
	 *
	 * @param {Combatant} combatant
	 * @param {string} itemUuid
	 * @param {User} requestingUser
	 * @param {Object} [options]
	 * @param {boolean} [options.optionalWeaponModifiers=false]
	 * @returns {Promise<Object>}
	 */
	static async commitSelectedParry(
		combatant,
		itemUuid,
		requestingUser,
		{
			optionalWeaponModifiers = false,
		} = {},
	) {
		if (!game.user?.isGM) {
			throw new Error(
				"Selected parry commitment requires GM authority.",
			);
		}

		const selected = this.choice(combatant, itemUuid, {
			optionalWeaponModifiers,
		});

		const economy = await CombatAttackEconomy.commit(
			"parry",
			combatant,
			{
				count: 1,
				costMode: selected.attackCostMode,
			},
			requestingUser,
		);

		return foundry.utils.deepFreeze({
			selected,
			economy,
			parryAttackCost: economy.parryAttackCost,
			remainingAttacks: economy.remaining,
		});
	}
}

function previewAttackCost(costMode, remainingAttacks) {
	if (remainingAttacks <= 0) return 0;

	return costMode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS
		? remainingAttacks
		: 1;
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new TypeError(
			"Parry selection requires a Combatant with an Actor.",
		);
	}
	return actor;
}
