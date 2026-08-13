import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";

export const COMBAT_ATTACK_TARGET_MODE = Object.freeze({
	DEFENDER: "defender",
	NONE: "none",
});

/** Execute one configured melee weapon Test with optional Combat automation. */
export class CombatAttackResolution {
	/**
	 * Resolve whether this Actor is governed by the currently started Combat.
	 *
	 * No started encounter, or an Actor which is not a participant in it, means
	 * an unmanaged attack: the Test is legal and no Combatant A is spent. An
	 * Actor which *is* a participant must still be the active Combatant.
	 */
	static combatantFor(actor) {
		const combat = game.combat;
		if (!combat?.started) return null;

		const matches = matchingCombatants(combat, actor);
		if (matches.length === 0) return null;

		const active = combat.combatant;
		if (active && matches.some((entry) => entry.id === active.id)) {
			return active;
		}

		throw new Error(localize(
			"This Actor is a Combat participant but is not the Combatant whose turn is currently active.",
			"Ten Aktor jest uczestnikiem walki, ale nie jest uczestnikiem, którego tura jest aktualnie aktywna.",
		));
	}

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

		const combatant = this.combatantFor(actor);
		let economy = null;
		let attackCost = 0;

		if (combatant) {
			const before = CombatAttackEconomy.snapshot(combatant);
			if (!before.canAttack) {
				throw new Error(localize(
					"This Combatant has no Attack available in the current attack window.",
					"Ten uczestnik walki nie ma dostępnego Ataku w bieżącym oknie ataku.",
				));
			}

			/* Revalidate and spend authoritatively at the moment of execution. */
			economy = await CombatAttackEconomy.spendAttack(combatant, 1);
			attackCost = 1;
		}

		const options = {
			modifier: finiteNumber(configuration?.modifier ?? 0, "Attack modifier"),
			resultVisibility: configuration?.resultVisibility,
			ruleEffects: mutableRuleEffects(configuration?.ruleEffects),
		};

		if (targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER) {
			options.target = target;
		}

		const result = await actor.rollTest("ws", options);
		if (!result?.chatMessage) {
			throw new Error(
				"The melee attack roll did not produce its expected Test chat message.",
			);
		}

		const attackState = {
			version: 2,
			family: WEAPON_KIND.MELEE,
			status: "rolled",
			managedByCombat: Boolean(combatant),
			attacker: {
				uuid: actor.uuid,
				name: String(actor.name ?? ""),
				combatantId: String(combatant?.id ?? ""),
			},
			weapon: {
				uuid: weapon.uuid,
				name: String(weapon.name ?? ""),
				kind: WEAPON_KIND.MELEE,
			},
			targetMode,
			target: targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER
				? {
					uuid: String(target?.uuid ?? ""),
					name: String(target?.name ?? ""),
				}
				: null,
			attackCost,
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};

		await CombatAttackResultChat.attach(
			result.chatMessage,
			attackState,
		);

		return Object.freeze({
			result,
			message: result.chatMessage,
			attack: Object.freeze(foundry.utils.deepClone(attackState)),
			economy,
		});
	}

	static #validate(actor, weapon, targetMode, target) {
		if (actor?.documentName !== "Actor") {
			throw new Error("Melee attack resolution requires an Actor.");
		}
		if (weapon?.type !== "weapon") {
			throw new Error("Melee attack resolution requires a Weapon Item.");
		}
		if (weapon.parent?.uuid !== actor.uuid) {
			throw new Error("The selected Weapon is not owned by this Actor.");
		}
		if (weapon.system?.kind !== WEAPON_KIND.MELEE) {
			throw new Error(
				"Ranged weapon execution is not enabled until its Load/Aim/Fire lifecycle is implemented.",
			);
		}
		if (!CombatEquipmentState.isUsed(weapon)) {
			throw new Error(localize(
				"The selected melee weapon must be equipped/held before it can attack.",
				"Wybrana broń do walki wręcz musi być używana/trzymana, aby nią zaatakować.",
			));
		}
		if (!Object.values(COMBAT_ATTACK_TARGET_MODE).includes(targetMode)) {
			throw new Error(`Unknown combat attack target mode '${String(targetMode)}'.`);
		}
		if (
			targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER &&
			target?.documentName !== "Actor"
		) {
			throw new Error("A defended melee attack requires a target Actor.");
		}
	}
}

function matchingCombatants(combat, actor) {
	if (!actor) return [];
	const combatants = [...(combat?.combatants ?? [])];
	const exact = combatants.filter(
		(combatant) => combatant.actor?.uuid === actor.uuid,
	);
	if (exact.length) return exact;

	const sameId = combatants.filter(
		(combatant) =>
			combatant.actor?.id &&
			actor.id &&
			combatant.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId : [];
}

function mutableRuleEffects(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => ({
		...entry,
		source: { ...(entry?.source ?? {}) },
	}));
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return number;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
