export const PARRY_ATTACK_COST_MODE = Object.freeze({
	ONE_ATTACK: "oneAttack",
	ALL_REMAINING_ATTACKS: "allRemainingAttacks",
});

/**
 * Normalize the resource cost attached to one parry option.
 *
 * Ordinary weapon parries consume one Attack. Core shield parries consume all
 * following Attacks, represented by all Attacks which remain unspent in the
 * current round when the shield parry is declared.
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
