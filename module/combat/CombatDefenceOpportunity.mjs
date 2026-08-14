import { CombatEquipment } from "./CombatEquipment.mjs";
import { CombatDodgeEconomy } from "./CombatDodgeEconomy.mjs";
import { CombatParrySelection } from "./CombatParrySelection.mjs";

export const COMBAT_DEFENCE_RESPONSE = Object.freeze({
	PARRY: "parry",
	DODGE: "dodge",
	NONE: "none",
});

const DODGE_BLOW_RULES_ID = "dodgeBlow";

/**
 * Read-only WFRP 1e response choices for one incoming hand-to-hand blow.
 *
 * The defender chooses exactly one response for the blow:
 *
 *   Parry OR Dodge OR None
 *
 * Managed mode uses Combatant round resources. Unmanaged mode is used outside
 * Combat Tracker: the same mechanical response tests remain available, but the
 * system deliberately does not automate per-round parry/Dodge limits or future
 * Attack losses because there is no authoritative round lifecycle to attach
 * those resources to.
 */
export class CombatDefenceOpportunity {
	/**
	 * Build currently legal managed choices for a Combatant.
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

		return foundry.utils.deepFreeze({
			mode: "managed",
			combatId: String(combatant.parent?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			kind: "melee",
			seenComing: Boolean(seenComing),
			selectionMode: "exactlyOne",
			responses: responseView({
				parryAvailable: parry.canParry,
				parryReason: parry.canParry
					? null
					: parryUnavailableReason(parry),
				dodgeAvailable,
				dodgeReason: dodgeAvailable
					? null
					: dodgeUnavailableReason(dodge, seenComing),
			}),
			parry,
			dodge,
		});
	}

	/**
	 * Build defence choices for an Actor outside Combat Tracker.
	 *
	 * The Actor still needs a legal held parry Item and Dodge Blow still needs
	 * the stable Dodge Blow Skill rules ID. What is intentionally absent is
	 * automated round-resource accounting; callers/GM may manage those values
	 * manually when resolving an abstract or out-of-combat exchange.
	 */
	static unmanagedMelee(
		actor,
		{
			seenComing = true,
			optionalWeaponModifiers = false,
		} = {},
	) {
		assertActor(actor);

		const rawParryChoices = CombatEquipment.parryOptions(actor, {
			optionalWeaponModifiers,
		});
		const choices = rawParryChoices.map((choice) => Object.freeze({
			...choice,
			attackCost: 0,
			immediateAttackCost: 0,
			parryDebtAdded: 0,
			parryDebtBefore: 0,
			parryDebtAfter: 0,
			remainingAttacksBefore: null,
			remainingAttacksAfter: null,
			projectedNextTurnAttacksBefore: null,
			projectedNextTurnAttacksAfter: null,
		}));
		const hasSkill = actorHasDodgeBlow(actor);
		const dodgeAvailable = Boolean(seenComing && hasSkill);

		const parry = {
			actorUuid: String(actor.uuid ?? ""),
			managed: false,
			remainingAttacks: null,
			currentAttackRemaining: null,
			projectedNextTurnAttacks: null,
			parryDebt: null,
			parryAttemptsRemaining: null,
			resourceCanParry: choices.length > 0,
			canParry: choices.length > 0,
			choices,
		};
		const dodge = {
			actorUuid: String(actor.uuid ?? ""),
			managed: false,
			hasSkill,
			usedThisRound: false,
			canAttemptThisRound: hasSkill,
		};

		return foundry.utils.deepFreeze({
			mode: "unmanaged",
			combatId: "",
			combatantId: "",
			actorUuid: String(actor.uuid ?? ""),
			kind: "melee",
			seenComing: Boolean(seenComing),
			selectionMode: "exactlyOne",
			responses: responseView({
				parryAvailable: choices.length > 0,
				parryReason: choices.length > 0 ? null : "no-parry-item",
				dodgeAvailable,
				dodgeReason: dodgeAvailable
					? null
					: (!seenComing
						? "not-seen-coming"
						: "missing-dodge-blow-skill"),
			}),
			parry,
			dodge,
		});
	}
}

function responseView({
	parryAvailable,
	parryReason,
	dodgeAvailable,
	dodgeReason,
}) {
	return [
		Object.freeze({
			id: COMBAT_DEFENCE_RESPONSE.PARRY,
			available: Boolean(parryAvailable),
			reason: parryAvailable ? null : parryReason,
		}),
		Object.freeze({
			id: COMBAT_DEFENCE_RESPONSE.DODGE,
			available: Boolean(dodgeAvailable),
			reason: dodgeAvailable ? null : dodgeReason,
		}),
		Object.freeze({
			id: COMBAT_DEFENCE_RESPONSE.NONE,
			available: true,
			reason: null,
		}),
	];
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

function actorHasDodgeBlow(actor) {
	return [...(actor.items ?? [])].some((item) =>
		item?.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === DODGE_BLOW_RULES_ID,
	);
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new TypeError("A Foundry Actor is required.");
	}
}
