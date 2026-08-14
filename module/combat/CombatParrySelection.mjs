import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";
import { PARRY_ATTACK_COST_MODE } from "./CombatParryRules.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";

/**
 * Build and validate the tactical parry choices for one Combatant.
 *
 * The selection is deliberately Item-based. A defender holding both a suitable
 * one-handed weapon and a shield must choose which Item performs the parry;
 * the system must not silently prefer either option. The selected Item carries
 * both its WS modifier and its current Attacks-resource cost contract.
 *
 * Under the optional round contract a normal weapon parry is paid directly from
 * the current-round Attack pool and therefore requires at least 1 A remaining.
 * Shield Full Defence is different: after it is legally declared, repeated
 * shield parries rely on the separate Core parry-attempt cap, so they remain
 * possible even though offensive Attacks have been reduced to 0.
 */
export class CombatParrySelection {
	static choices(
		combatant,
		{
			optionalWeaponModifiers = false,
		} = {},
	) {
		assertCombatant(combatant);
		const actor = assertActor(combatant.actor);
		const economy = CombatAttackEconomy.snapshot(combatant);

		const parryOptions = economy.canParry
			? CombatEquipment.parryOptions(actor, {
				optionalWeaponModifiers,
			})
			: [];

		const choices = parryOptions
			.filter((option) => {
				const availability = CombatAttackEconomy.parryCostAvailability(
					combatant,
					{ costMode: option.attackCostMode },
				);
				if (!availability.available) return false;

				if (
					WfrpRuleSettings.usesRoundDefenceContract() &&
					option.attackCostMode === PARRY_ATTACK_COST_MODE.ONE_ATTACK &&
					economy.remaining <= 0
				) {
					return false;
				}
				return true;
			})
			.map((option) => {
				const preview = CombatAttackEconomy.previewParry(
					combatant,
					{
						costMode: option.attackCostMode,
					},
				);

				return Object.freeze({
					...option,
					attackCost: preview.parryAttackCost,
					immediateAttackCost: preview.parryImmediateAttackCost,
					parryDebtAdded: preview.parryDebtAdded,
					parryDebtBefore: preview.parryDebtBefore,
					parryDebtAfter: preview.parryDebtAfter,
					remainingAttacksBefore: preview.remainingAttacksBefore,
					remainingAttacksAfter: preview.remainingAttacksAfter,
					projectedNextTurnAttacksBefore:
						preview.projectedNextTurnAttacksBefore,
					projectedNextTurnAttacksAfter:
						preview.projectedNextTurnAttacksAfter,
					shieldDefensiveCommitment:
						preview.shieldDefensiveCommitment === true,
					shieldDefenceCommittedAfter:
						preview.shieldDefenceCommittedAfter === true,
				});
			});

		return foundry.utils.deepFreeze({
			combatId: economy.combatId,
			combatantId: economy.combatantId,
			actorUuid: economy.actorUuid,
			remainingAttacks: economy.remaining,
			currentAttackRemaining: economy.currentAttackRemaining,
			projectedNextTurnAttacks: economy.projectedNextTurnAttacks,
			parryDebt: economy.parryDebt,
			parryAttemptsRemaining: economy.parryAttemptsRemaining,
			resourceCanParry: economy.canParry,
			canParry: economy.canParry && choices.length > 0,
			choices,
		});
	}

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
				"The Combatant has reached the Core parry-attempt limit for this round.",
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
			parryImmediateAttackCost: economy.parryImmediateAttackCost,
			parryDebtAdded: economy.parryDebtAdded,
			parryDebt: economy.parryDebt,
			remainingAttacks: economy.remaining,
			projectedNextTurnAttacks: economy.projectedNextTurnAttacks,
			shieldDefensiveCommitment:
				economy.shieldDefensiveCommitment === true,
		});
	}
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
