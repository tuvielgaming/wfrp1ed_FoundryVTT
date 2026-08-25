import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { FormulaResolver } from "../tests/FormulaResolver.mjs";
import { DAMAGE_MITIGATION_POLICY } from "./DamagePacket.mjs";

export const DAMAGE_AMOUNT_MODIFIER_TARGET_ID =
	"damage.amount.modifier";
export const DAMAGE_ARMOUR_PENETRATION_TARGET_ID =
	"damage.armour.penetration";
export const DAMAGE_IGNORE_ARMOUR_TARGET_ID =
	"damage.armour.ignore";
export const DAMAGE_IGNORE_TOUGHNESS_TARGET_ID =
	"damage.toughness.ignore";

const NUMERIC_TARGETS = new Set([
	DAMAGE_AMOUNT_MODIFIER_TARGET_ID,
	DAMAGE_ARMOUR_PENETRATION_TARGET_ID,
]);
const GRANT_TARGETS = new Set([
	DAMAGE_IGNORE_ARMOUR_TARGET_ID,
	DAMAGE_IGNORE_TOUGHNESS_TARGET_ID,
]);

/**
 * Resolve source-independent WFRP damage rules from immutable Item snapshots.
 *
 * A source may be a weapon, ammunition, spell, potion, trap, or any future
 * document which supplies an Active Effect snapshot. Combat integrations decide
 * when the source participates in a damage event; this class only interprets
 * the registered damage capabilities. The exact snapshots are persisted on the
 * originating transaction so later Item edits cannot rewrite rolled damage.
 */
export class DamageRuleEffects {
	/**
	 * Capture active embedded effects from an Item for a transaction snapshot.
	 *
	 * @param {Item|Object|null|undefined} item
	 * @returns {readonly Object[]}
	 */
	static activeEffectSnapshots(item) {
		const effects = [...(item?.effects ?? [])]
			.filter((effect) => effect?.disabled !== true)
			.map((effect) => {
				if (typeof effect?.toObject === "function") {
					return effect.toObject();
				}
				return foundry.utils.deepClone(effect ?? {});
			});

		return foundry.utils.deepFreeze(
			foundry.utils.deepClone(effects),
		);
	}

	/**
	 * @param {Actor} attacker
	 * @param {Actor} defender
	 * @param {Array<{kind:string, source:Object|null|undefined}>} sources
	 * @returns {Object}
	 */
	static resolve(attacker, defender, sources = []) {
		assertActor(attacker, "Damage rule attacker");
		assertActor(defender, "Damage rule defender");

		const entries = [];
		let damageModifier = 0;
		let armourPenetration = 0;
		let armourPolicy = DAMAGE_MITIGATION_POLICY.APPLY;
		let toughnessPolicy = DAMAGE_MITIGATION_POLICY.APPLY;

		for (const descriptor of normalizeSources(sources)) {
			const effects = Array.isArray(descriptor.source?.effects)
				? descriptor.source.effects
				: [];

			for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
				const effect = effects[effectIndex];
				if (!effect || effect.disabled === true) continue;

				const changes = ruleChanges(effect);
				for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
					const decoded = decodeRuleEffectChange(changes[changeIndex]);
					const targetId = canonicalTargetId(decoded?.targetId);
					if (!decoded || !targetId) continue;
					if (
						decoded.applicability !== RULE_EFFECT_APPLICABILITY.AUTOMATIC ||
						decoded.side !== RULE_EFFECT_SIDES.SELF
					) {
						continue;
					}

					let value;
					if (NUMERIC_TARGETS.has(targetId)) {
						if (![
							RULE_EFFECT_OPERATIONS.ADD,
							RULE_EFFECT_OPERATIONS.SUBTRACT,
						].includes(decoded.operation)) {
							continue;
						}
						const resolved = FormulaResolver.resolve(
							attacker,
							decoded.formula,
							{ target: defender },
						);
						if (!Number.isFinite(resolved)) {
							throw new Error(
								`Damage rule effect '${effect.name ?? "Active Effect"}' did not resolve to a finite number.`,
							);
						}
						value = decoded.operation === RULE_EFFECT_OPERATIONS.SUBTRACT
							? -resolved
							: resolved;

						if (targetId === DAMAGE_AMOUNT_MODIFIER_TARGET_ID) {
							damageModifier += value;
						} else {
							armourPenetration += value;
						}
					} else if (GRANT_TARGETS.has(targetId)) {
						if (decoded.operation !== RULE_EFFECT_OPERATIONS.GRANT) continue;
						value = true;
						if (targetId === DAMAGE_IGNORE_ARMOUR_TARGET_ID) {
							armourPolicy = DAMAGE_MITIGATION_POLICY.IGNORE;
						} else {
							toughnessPolicy = DAMAGE_MITIGATION_POLICY.IGNORE;
						}
					}

					entries.push({
						sourceKind: descriptor.kind,
						sourceUuid: String(descriptor.source?.uuid ?? ""),
						sourceName: String(descriptor.source?.name ?? descriptor.kind),
						effectId: String(
							effect._id ?? effect.id ?? `effect-${effectIndex}`,
						),
						effectName: String(effect.name ?? "Active Effect"),
						changeIndex,
						targetId: decoded.targetId,
						resolvedTargetId: targetId,
						operation: decoded.operation,
						formula: decoded.formula,
						value,
						condition: decoded.condition,
					});
				}
			}
		}

		return foundry.utils.deepFreeze({
			damageModifier,
			armourPenetration: Math.max(0, armourPenetration),
			armourPolicy,
			toughnessPolicy,
			entries: foundry.utils.deepClone(entries),
		});
	}
}

function canonicalTargetId(targetId) {
	const normalized = String(targetId ?? "").trim();
	if (NUMERIC_TARGETS.has(normalized) || GRANT_TARGETS.has(normalized)) {
		return normalized;
	}
	return null;
}

function normalizeSources(sources) {
	if (!Array.isArray(sources)) {
		throw new Error("Damage rule sources must be an array.");
	}

	return sources.map((descriptor, index) => {
		if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
			throw new Error(`Damage rule source ${index} must be an object.`);
		}
		const kind = String(descriptor.kind ?? "").trim();
		if (!kind) {
			throw new Error(`Damage rule source ${index} requires a kind.`);
		}
		const source = descriptor.source ?? {};
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new Error(`Damage rule source ${index} snapshot must be an object.`);
		}
		return { kind, source };
	});
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

function assertActor(actor, label) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(`${label} requires an Actor.`);
	}
}
