import { CombatDodgeEconomy } from "./CombatDodgeEconomy.mjs";
import { CombatParrySelection } from "./CombatParrySelection.mjs";

export const COMBAT_DEFENCE_RESPONSE = Object.freeze({
	PARRY: "parry",
	DODGE: "dodge",
	NONE: "none",
});

/**
 * Read-only WFRP 1e response choices for one incoming hand-to-hand blow.
 *
 * The defender chooses exactly one response for the blow:
 *
 *   Parry OR Dodge OR None
 *
 * There is deliberately no sequence which permits a failed Dodge to fall back
 * to Parry, or a failed Parry to fall back to Dodge, against that same blow.
 * The eventual pending-defence transaction persists and enforces that one-shot
 * response choice. This service only derives which buttons/options may be
 * offered from current Combatant state.
 */
export class CombatDefenceOpportunity {
	/**
	 * Build the currently legal choices for an incoming melee blow.
	 *
	 * Dodge Blow additionally requires that the blow was seen coming, per Core.
	 * The caller owns that fact because it comes from the attack transaction
	 * (surprise/visibility), not from the defender's persistent Actor state.
	 *
	 * Parry availability comes from the already-audited parry attempt/equipment
	 * contract. Item choice remains nested under the Parry response and is never
	 * automatically resolved by this service.
	 *
	 * @param {Combatant} combatant
	 * @param {Object} [options]
	 * @param {boolean} [options.seenComing=true]
	 * @param {boolean} [options.optionalWeaponModifiers=false]
	 * @returns {Object}
	 */
	static melee(
		combatant,
		{
			seenComing = true,
			optionalWeaponModifiers = false,
		} = {},
	) {
		assertCombatant(combatant);

		const parry = CombatParrySelection.choices(combatant, {
			optionalWeaponModifiers,
		});
		const dodge = CombatDodgeEconomy.snapshot(combatant);
		const dodgeAvailable = Boolean(
			seenComing && dodge.canAttemptThisRound,
		);

		const responses = [
			Object.freeze({
				id: COMBAT_DEFENCE_RESPONSE.PARRY,
				available: parry.canParry,
				reason: parry.canParry
					? null
					: parryUnavailableReason(parry),
			}),
			Object.freeze({
				id: COMBAT_DEFENCE_RESPONSE.DODGE,
				available: dodgeAvailable,
				reason: dodgeAvailable
					? null
					: dodgeUnavailableReason(dodge, seenComing),
			}),
			Object.freeze({
				id: COMBAT_DEFENCE_RESPONSE.NONE,
				available: true,
				reason: null,
			}),
		];

		return foundry.utils.deepFreeze({
			combatId: String(combatant.parent?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			kind: "melee",
			seenComing: Boolean(seenComing),
			selectionMode: "exactlyOne",
			responses,
			parry,
			dodge,
		});
	}
}

function parryUnavailableReason(parry) {
	if (!parry.resourceCanParry) {
		return "parry-limit";
	}
	if (!parry.choices.length) {
		return "no-parry-item";
	}
	return "unavailable";
}

function dodgeUnavailableReason(dodge, seenComing) {
	if (!seenComing) {
		return "not-seen-coming";
	}
	if (!dodge.hasSkill) {
		return "missing-dodge-blow-skill";
	}
	if (dodge.usedThisRound) {
		return "already-used-this-round";
	}
	return "unavailable";
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}
