import {
	DAMAGE_AMOUNT_MODIFIER_TARGET_ID,
	DamageRuleEffects,
	LEGACY_AMMUNITION_DAMAGE_TARGET_ID,
} from "../damage/DamageRuleEffects.mjs";

export const AMMUNITION_DAMAGE_TARGET_ID =
	LEGACY_AMMUNITION_DAMAGE_TARGET_ID;

/**
 * Resolve WFRP Rule Active Effects from the exact ammunition snapshot persisted
 * on a ranged attack.
 *
 * This deliberately does not scan the attacker's current inventory. A shot is
 * transaction-stable: moving, renaming, deleting or depleting the source stack
 * after the attack cannot change which ammunition effects belong to that shot.
 * Other compatible ammunition carried by the Actor is never consulted.
 */
export class CombatAmmunitionRuleEffects {
	/**
	 * Resolve the automatic numeric damage modifier contributed by fired ammo.
	 *
	 * This compatibility facade returns only the numeric ammunition contribution.
	 * The shared DamageRuleEffects resolver also supports mitigation capabilities
	 * for integrations which consume its complete result.
	 *
	 * `ActiveEffect.transfer` is intentionally irrelevant here. Transfer controls
	 * whether an Item effect is applied to its owning Actor; this consumer is not
	 * transferring an effect to the attacker. It is reading a mechanical property
	 * from the ammunition object which was actually fired.
	 *
	 * @param {Actor} attacker
	 * @param {Actor} defender
	 * @param {Object|null|undefined} ammunition
	 * @returns {{total:number, entries:readonly Object[]}}
	 */
	static damageModifier(attacker, defender, ammunition) {
		if (!(attacker instanceof foundry.documents.Actor)) {
			throw new Error(
				"Ammunition damage effect resolution requires the attacking Actor.",
			);
		}
		if (!(defender instanceof foundry.documents.Actor)) {
			throw new Error(
				"Ammunition damage effect resolution requires the defending Actor.",
			);
		}

		const resolved = DamageRuleEffects.resolve(attacker, defender, [{
			kind: "ammunition",
			source: ammunition ?? {},
		}]);

		return foundry.utils.deepFreeze({
			total: resolved.damageModifier,
			entries: foundry.utils.deepClone(
				resolved.entries.filter(
					(entry) =>
						entry.resolvedTargetId ===
						DAMAGE_AMOUNT_MODIFIER_TARGET_ID,
				),
			),
		});
	}
}
