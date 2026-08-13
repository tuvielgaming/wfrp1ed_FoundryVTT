import { CombatAttackEconomy } from "../combat/CombatAttackEconomy.mjs";
import { CombatDodgeEconomy } from "../combat/CombatDodgeEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_ECONOMY_FLAG_KEY = "attackEconomy";

/**
 * WFRP 1e Combat document.
 *
 * Round start is the only ordinary reset point for the Attacks pool. Starting a
 * Combatant turn only opens its attack window and converts accumulated parry
 * debt into spent Attacks; it must not erase a GM/player manual correction made
 * earlier in the same round.
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
		});
	}

	/** @inheritDoc */
	async _onEndTurn(combatant, context) {
		await super._onEndTurn(combatant, context);
		await CombatAttackEconomy.endTurn(combatant);
	}

	/** @inheritDoc */
	async _onEnter(combatant) {
		await super._onEnter(combatant);
		await CombatAttackEconomy.initializeCombatant(combatant);
		await CombatDodgeEconomy.initializeCombatant(combatant);
	}
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}
