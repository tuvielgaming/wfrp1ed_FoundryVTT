export const PARRY_ATTACK_COST_MODE = Object.freeze({
	ONE_ATTACK: "oneAttack",
	ALL_REMAINING_ATTACKS: "allRemainingAttacks",
});

/**
 * Normalize the attack-loss mode attached to one parry option.
 *
 * Ordinary weapon parries lose the character's next Attack. Core shield parries
 * lose all following Attacks. The historical internal value
 * `allRemainingAttacks` is retained for API compatibility, but the actual
 * timing is resolved by CombatAttackEconomy: the loss is paid immediately when
 * possible and otherwise carries forward as parry debt.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeParryAttackCostMode(value) {
	const mode = String(value ?? "");
	if (mode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS) {
		return mode;
	}
	return PARRY_ATTACK_COST_MODE.ONE_ATTACK;
}
