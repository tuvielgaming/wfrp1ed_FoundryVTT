import {
	WEAPON_KIND,
	weaponRangedCycleSnapshot,
} from "../data-models/item/WeaponData.mjs";
import {
	COMBAT_ATTACK_TARGET_MODE,
} from "./CombatAttackResolution.mjs";
import { CombatAttackRangeRules } from "./CombatAttackRangeRules.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

/**
 * Execute one configured ranged Weapon attack.
 *
 * Ranged attacks deliberately do not consume the melee Attacks economy. Their
 * authoritative resources are the Weapon runtime state (ready/reload/magazine)
 * and the Combatant's separate firing-round shot pool in CombatRangedState.
 *
 * The resource is committed before rolling, matching the existing melee attack
 * contract where an Attack is spent before its d100 is created. This prevents a
 * second client from spending the same loaded shot while the first roll is in
 * flight. The generic Test card remains authoritative for the editable physical
 * d100; this service only attaches the ranged combat/range snapshot around it.
 */
export class CombatRangedAttackResolution {
	static async execute(
		actor,
		weapon,
		configuration,
		{
			targetMode = COMBAT_ATTACK_TARGET_MODE.DEFENDER,
			target = null,
		} = {},
	) {
		this.#validate(actor, weapon, targetMode, target);

		const before = CombatRangedState.fireAvailability(actor, weapon);
		if (!before.available) throw new Error(before.reason);

		const range = rangedRangeSnapshot(weapon, configuration);
		if (range.automatic && range.legal === false) {
			throw new Error(localize(
				"The entered distance is beyond this weapon's maximum range.",
				"Podany dystans przekracza maksymalny zasięg tej broni.",
			));
		}

		const testModifiers = [];
		if (range.automatic && range.bsModifier !== 0) {
			testModifiers.push({
				id: "combat-range",
				value: range.bsModifier,
				source: localize(
					`Range — ${CombatAttackRangeRules.label(range.band)}`,
					`Zasięg — ${CombatAttackRangeRules.label(range.band)}`,
				),
				type: CombatAttackResultChat.rangeModifierType,
				enabled: true,
			});
		}

		/*
		 * Commit ammunition/readiness/shot-pool state authoritatively before the
		 * d100, exactly as melee spends its Attack resource before rolling.
		 */
		const after = await CombatRangedState.fire(actor, weapon);

		const options = {
			modifier: finiteNumber(configuration?.modifier ?? 0, "Attack modifier"),
			modifiers: testModifiers,
			resultVisibility: configuration?.resultVisibility,
			ruleEffects: mutableRuleEffects(configuration?.ruleEffects),
		};
		if (targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER) {
			options.target = target;
		}

		const result = await actor.rollTest("bs", options);
		if (!result?.chatMessage) {
			throw new Error(
				"The ranged attack roll did not produce its expected Test chat message.",
			);
		}

		const lifecycleCombat = game.combat?.started ? game.combat : null;
		const cycle = weaponRangedCycleSnapshot(weapon);
		const attackState = {
			version: 5,
			family: WEAPON_KIND.RANGED,
			status: "rolled",
			managedByCombat: Boolean(before.combatant),
			lifecycle: lifecycleCombat
				? {
					combatId: String(lifecycleCombat.id ?? ""),
					round: positiveRound(lifecycleCombat.round),
				}
				: null,
			attacker: {
				uuid: actor.uuid,
				name: String(actor.name ?? ""),
				combatantId: String(before.combatant?.id ?? ""),
			},
			weapon: {
				uuid: weapon.uuid,
				name: String(weapon.name ?? ""),
				kind: WEAPON_KIND.RANGED,
				effectiveStrength: nonNegativeInteger(weapon.system?.effectiveStrength),
				firingCycle: foundry.utils.deepClone(cycle),
			},
			targetMode,
			target: targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER
				? {
					uuid: String(target?.uuid ?? ""),
					name: String(target?.name ?? ""),
				}
				: null,
			attackCost: 0,
			range,
			ranged: {
				shotNumber: nonNegativeInteger(before.turn?.spent) + 1,
				shotsPerFireRound: nonNegativeInteger(before.turn?.allowance) ||
					cycle.shotsPerFireRound,
				shotsRemaining: nonNegativeInteger(after.turn?.remaining),
				magazineCapacity: nonNegativeInteger(after.runtime?.magazineCapacity),
				magazineRemaining: after.runtime?.magazineRemaining ?? null,
				reloadRounds: nonNegativeInteger(after.runtime?.reloadRounds),
				reloadRemaining: nonNegativeInteger(after.runtime?.reloadRemaining),
				readyToFire: after.runtime?.readyToFire === true,
			},
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};

		await CombatAttackResultChat.attach(result.chatMessage, attackState);

		return Object.freeze({
			result,
			message: result.chatMessage,
			attack: Object.freeze(foundry.utils.deepClone(attackState)),
			rangedState: Object.freeze({
				before: snapshotAvailability(before),
				after: snapshotAvailability(after),
			}),
		});
	}

	static #validate(actor, weapon, targetMode, target) {
		if (actor?.documentName !== "Actor") {
			throw new Error("Ranged attack resolution requires an Actor.");
		}
		if (weapon?.type !== "weapon") {
			throw new Error("Ranged attack resolution requires a Weapon Item.");
		}
		if (weapon.parent?.uuid !== actor.uuid) {
			throw new Error("The selected ranged Weapon is not owned by this Actor.");
		}
		if (weapon.system?.kind !== WEAPON_KIND.RANGED) {
			throw new Error("Ranged attack resolution requires a ranged Weapon.");
		}
		if (!CombatEquipmentState.isUsed(weapon)) {
			throw new Error(localize(
				"The selected ranged weapon must be equipped/held before it can fire.",
				"Wybrana broń dystansowa musi być używana/trzymana, aby można było z niej strzelić.",
			));
		}
		if (!Object.values(COMBAT_ATTACK_TARGET_MODE).includes(targetMode)) {
			throw new Error(`Unknown combat attack target mode '${String(targetMode)}'.`);
		}
		if (
			targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER &&
			target?.documentName !== "Actor"
		) {
			throw new Error("A targeted ranged attack requires a target Actor.");
		}
	}
}

function rangedRangeSnapshot(weapon, configuration) {
	const profile = CombatAttackRangeRules.weaponProfile(weapon);
	const automatic = configuration?.automaticRangeEffects === true;
	const distance = finiteNonNegative(configuration?.distance ?? 0, "Distance");
	const manualDamageModifier = finiteNumber(
		configuration?.manualDamageModifier ?? 0,
		"Damage modifier",
	);

	if (!automatic) {
		return {
			automatic: false,
			distance,
			profile: foundry.utils.deepClone(profile),
			band: null,
			legal: true,
			bsModifier: 0,
			damageModifier: manualDamageModifier,
			manualDamageModifier,
		};
	}

	const resolved = CombatAttackRangeRules.resolve(profile, distance);
	return {
		automatic: true,
		distance,
		profile: foundry.utils.deepClone(profile),
		band: resolved.band,
		legal: resolved.legal,
		bsModifier: resolved.bsModifier,
		damageModifier: resolved.damageModifier,
		manualDamageModifier,
	};
}

function snapshotAvailability(value) {
	return Object.freeze({
		available: value?.available === true,
		reason: String(value?.reason ?? ""),
		runtime: foundry.utils.deepClone(value?.runtime ?? null),
		turn: foundry.utils.deepClone(value?.turn ?? null),
		combatantId: String(value?.combatant?.id ?? ""),
	});
}

function mutableRuleEffects(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => ({
		...entry,
		source: { ...(entry?.source ?? {}) },
	}));
}

function positiveRound(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return number;
}

function finiteNonNegative(value, label) {
	const number = finiteNumber(value, label);
	if (number < 0) throw new Error(`${label} must not be negative.`);
	return number;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
