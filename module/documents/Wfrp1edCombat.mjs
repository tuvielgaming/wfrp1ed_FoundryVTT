import { CombatAttackEconomy } from "../combat/CombatAttackEconomy.mjs";
import { CombatDodgeEconomy } from "../combat/CombatDodgeEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_ECONOMY_FLAG_KEY = "attackEconomy";
const PARRY_DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";

/**
 * WFRP 1e Combat document.
 *
 * Round start is the only ordinary reset point for the Attacks pool. Starting a
 * Combatant turn only opens its attack window and converts accumulated parry
 * debt into spent Attacks; it must not erase a GM/player manual correction made
 * earlier in the same round.
 *
 * `parryDebtReminder` is presentation-only. When debt is paid at turn start we
 * retain the paid amount through that Combatant's active turn so the A-cell
 * badge can still explain why the character has fewer Attacks. The reminder is
 * cleared when that Combatant ends the turn; it never participates in resource
 * calculations.
 */
export class Wfrp1edCombat extends foundry.documents.Combat {
	/** @inheritDoc */
	async _onStartRound(context) {
		await super._onStartRound(context);
		await CombatAttackEconomy.startRound(this);
		await CombatDodgeEconomy.startRound(this);
	}

	/** @inheritDoc */
	async _onStartTurn(combatant, context) {
		await super._onStartTurn(combatant, context);

		const snapshot = CombatAttackEconomy.snapshot(combatant);
		const raw = combatant.getFlag(
			FLAG_SCOPE,
			ATTACK_ECONOMY_FLAG_KEY,
		) ?? {};
		const paidDebt = Math.min(snapshot.allowance, snapshot.parryDebt);
		await combatant.update({
			[`flags.${FLAG_SCOPE}.${ATTACK_ECONOMY_FLAG_KEY}`]: {
				...raw,
				round: nonNegativeInteger(this.round),
				spent: snapshot.spent + paidDebt,
				parryDebt: Math.max(0, snapshot.parryDebt - paidDebt),
				parriesThisRound: snapshot.parriesThisRound,
				turnStarted: true,
				turnCompleted: false,
			},
			[`flags.${FLAG_SCOPE}.${PARRY_DEBT_REMINDER_FLAG_KEY}`]: paidDebt,
		});
	}

	/** @inheritDoc */
	async _onEndTurn(combatant, context) {
		await super._onEndTurn(combatant, context);
		await CombatAttackEconomy.endTurn(combatant);
		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			0,
		);
	}

	/** @inheritDoc */
	async _onEnter(combatant) {
		await super._onEnter(combatant);
		await CombatAttackEconomy.initializeCombatant(combatant);
		await CombatDodgeEconomy.initializeCombatant(combatant);
		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			0,
		);
	}
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}
