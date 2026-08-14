import { CombatAttackEconomy } from "../combat/CombatAttackEconomy.mjs";
import { CombatDodgeEconomy } from "../combat/CombatDodgeEconomy.mjs";
import { CombatRoundInitiativeOrder } from "../combat/CombatRoundInitiativeOrder.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PARRY_DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";

/**
 * WFRP 1e Combat document.
 *
 * Round start is the authoritative reset point for current-round Attack/parry
 * resources. Starting a Combatant turn only opens that Combatant's attack
 * window; it never restores Attacks already lost to same-round parries.
 *
 * Initiative edits made during a started round are temporary. Immediately
 * before Foundry advances to the next round, baseline initiative values are
 * restored so the new round begins in the normal initiative order again.
 */
export class Wfrp1edCombat extends foundry.documents.Combat {
	/**
	 * Restore temporary initiative order before Foundry calculates the next
	 * round's first Combatant.
	 *
	 * @inheritDoc
	 */
	async nextRound() {
		await CombatRoundInitiativeOrder.resetBeforeNextRound(this);
		return super.nextRound();
	}

	/** @inheritDoc */
	async _onStartRound(context) {
		await super._onStartRound(context);

		/* Round 1 establishes the baseline after any pre-combat initiative rolls. */
		if (Number(this.round) === 1) {
			await CombatRoundInitiativeOrder.captureCombatBaselines(this, {
				force: true,
			});
		}

		await CombatAttackEconomy.startRound(this);
		await CombatDodgeEconomy.startRound(this);

		const reminderUpdates = [...this.combatants].map((combatant) => ({
			_id: combatant.id,
			[`flags.${FLAG_SCOPE}.${PARRY_DEBT_REMINDER_FLAG_KEY}`]: 0,
		}));
		if (reminderUpdates.length) {
			await this.updateEmbeddedDocuments("Combatant", reminderUpdates);
		}
	}

	/** @inheritDoc */
	async _onStartTurn(combatant, context) {
		await super._onStartTurn(combatant, context);

		const before = CombatAttackEconomy.snapshot(combatant);
		const after = await CombatAttackEconomy.startTurn(combatant);
		const paidDebt = Math.max(0, after.spent - before.spent);

		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			paidDebt,
		);
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
		await CombatRoundInitiativeOrder.captureBaseline(combatant);
		await CombatAttackEconomy.initializeCombatant(combatant);
		await CombatDodgeEconomy.initializeCombatant(combatant);
		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			0,
		);
	}
}
