import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { FormulaResolver } from "../tests/FormulaResolver.mjs";

export const AMMUNITION_DAMAGE_TARGET_ID =
	"combat.ranged.ammunition.damage";

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
	 * The first supported ammunition target is intentionally narrow: automatic
	 * Self-side Add/Subtract changes only. Contextual/manual decisions and other
	 * mechanics such as armour penetration, poison or bleeding require their own
	 * explicit consumer contracts rather than being inferred from prose.
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

		const effects = Array.isArray(ammunition?.effects)
			? ammunition.effects
			: [];
		const entries = [];
		let total = 0;

		for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
			const effect = effects[effectIndex];
			if (!effect || effect.disabled === true || effect.transfer === false) {
				continue;
			}

			const changes = ruleChanges(effect);
			for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
				const decoded = decodeRuleEffectChange(changes[changeIndex]);
				if (!decoded || decoded.targetId !== AMMUNITION_DAMAGE_TARGET_ID) {
					continue;
				}
				if (
					decoded.applicability !== RULE_EFFECT_APPLICABILITY.AUTOMATIC ||
					decoded.side !== RULE_EFFECT_SIDES.SELF ||
					![
						RULE_EFFECT_OPERATIONS.ADD,
						RULE_EFFECT_OPERATIONS.SUBTRACT,
					].includes(decoded.operation)
				) {
					continue;
				}

				const resolved = FormulaResolver.resolve(
					attacker,
					decoded.formula,
					{ target: defender },
				);
				if (!Number.isFinite(resolved)) {
					throw new Error(
						`Ammunition damage effect '${effect.name ?? "Active Effect"}' did not resolve to a finite number.`,
					);
				}

				const value = decoded.operation === RULE_EFFECT_OPERATIONS.SUBTRACT
					? -resolved
					: resolved;
				total += value;
				entries.push({
					effectId: String(effect._id ?? effect.id ?? `effect-${effectIndex}`),
					effectName: String(effect.name ?? "Active Effect"),
					changeIndex,
					targetId: decoded.targetId,
					operation: decoded.operation,
					formula: decoded.formula,
					value,
					condition: decoded.condition,
				});
			}
		}

		return foundry.utils.deepFreeze({
			total,
			entries: foundry.utils.deepClone(entries),
		});
	}
}

function ruleChanges(effect) {
	const flagged = effect?.flags?.wfrp1ed?.ruleChanges;
	if (Array.isArray(flagged) && flagged.length > 0) {
		return foundry.utils.deepClone(flagged);
	}

	if (Array.isArray(effect?.changes) && effect.changes.length > 0) {
		return foundry.utils.deepClone(effect.changes);
	}

	if (Array.isArray(effect?.system?.changes)) {
		return foundry.utils.deepClone(effect.system.changes);
	}

	return [];
}
