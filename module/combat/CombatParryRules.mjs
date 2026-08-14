export const PARRY_ATTACK_COST_MODE = Object.freeze({
	ONE_ATTACK: "oneAttack",
	ALL_REMAINING_ATTACKS: "allRemainingAttacks",
});

/**
 * Normalize the attack-loss mode attached to one parry option.
 *
 * Ordinary weapon parries lose the character's next Attack. Core shield text
 * says the character loses all following Attacks. The historical internal
 * value `allRemainingAttacks` is retained as the stable Item/API identity for a
 * shield cost; CombatAttackEconomy decides how that text is applied under the
 * world's selected WFRP optional-rule interpretation.
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
