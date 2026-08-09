import { decodeRuleEffectChange } from "./RuleEffectRegistry.mjs";

export const RULE_EFFECT_FLAG_SCOPE = "wfrp1ed";
export const RULE_EFFECT_FLAG_KEY = "ruleChanges";

/**
 * Durable WFRP rule storage for native Foundry ActiveEffect Documents.
 *
 * ActiveEffect remains the lifecycle/state container (disabled, transfer,
 * duration, source Item, etc.). WFRP-specific declarative rule descriptors are
 * package-owned data and therefore live in flags instead of Foundry's typed
 * ActiveEffect.system.changes collection.
 */
export class RuleEffectStorage {
	/**
	 * Return a mutable copy of WFRP rule descriptors stored on one effect.
	 *
	 * Flags are canonical. The system.changes fallback exists only to migrate
	 * effects authored during the earlier v14 implementation in the current
	 * session. Once a flagged array exists, legacy changes are ignored.
	 *
	 * @param {ActiveEffect} effect
	 * @returns {Object[]}
	 */
	static rules(effect) {
		const flagged = effect?.getFlag?.(
			RULE_EFFECT_FLAG_SCOPE,
			RULE_EFFECT_FLAG_KEY,
		);

		if (Array.isArray(flagged)) {
			return clone(flagged);
		}

		return this.nativeChanges(effect)
			.filter((change) => Boolean(decodeRuleEffectChange(change)))
			.map((change) => clone(change));
	}

	/**
	 * Return native Foundry system changes without WFRP descriptors.
	 *
	 * @param {ActiveEffect} effect
	 * @returns {Object[]}
	 */
	static nativeChanges(effect) {
		const system = effect?.system?.toObject?.() ??
			clone(effect?.system) ??
			{};
		const changes = Array.isArray(system?.changes)
			? system.changes
			: [];

		return changes
			.filter((change) => !decodeRuleEffectChange(change))
			.map((change) => clone(change));
	}

	/**
	 * Persist the complete WFRP rule array on an embedded ActiveEffect.
	 *
	 * Use the parent Item's embedded-document update path so this works for both
	 * world Items and Actor-embedded Items, including synthetic Token Actors.
	 * The supplied payload is cloned because Foundry DataModel cleaning may
	 * mutate source data while constructing the persisted Document.
	 *
	 * @param {Item} item
	 * @param {ActiveEffect} effect
	 * @param {Object[]} rules
	 * @returns {Promise<ActiveEffect>}
	 */
	static async persist(item, effect, rules) {
		if (!item || !effect?.id) {
			throw new Error(
				"WFRP rule persistence requires an Item and ActiveEffect id.",
			);
		}

		const payload = Array.isArray(rules)
			? clone(rules)
			: [];

		const [updated] = await item.updateEmbeddedDocuments(
			"ActiveEffect",
			[
				{
					_id: effect.id,
					[`flags.${RULE_EFFECT_FLAG_SCOPE}.${RULE_EFFECT_FLAG_KEY}`]: payload,
				},
			],
		);

		const stored = updated ?? item.effects?.get(effect.id) ?? null;

		if (!stored) {
			throw new Error(
				`Updated ActiveEffect '${effect.id}' is missing from its parent Item.`,
			);
		}

		return stored;
	}
}

function clone(value) {
	if (value === undefined || value === null) {
		return value;
	}

	return foundry.utils.deepClone(value);
}
