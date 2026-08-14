import { CombatAttackEconomy } from "../combat/CombatAttackEconomy.mjs";
import { CombatDodgeEconomy } from "../combat/CombatDodgeEconomy.mjs";
import { CombatRoundInitiativeOrder } from "../combat/CombatRoundInitiativeOrder.mjs";
import { CombatRoundTurnState } from "../combat/CombatRoundTurnState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PARRY_DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";

/**
 * WFRP 1e Combat document.
 *
 * Round start is the authoritative reset point for current-round Attack/parry
 * resources. Starting a Combatant turn only opens that Combatant's attack
 * window; it never restores Attacks already lost to same-round parries.
 *
 * Initiative edits made during a started round are temporary. Turn completion
 * is tracked separately from initiative position, so postponing the current
 * Combatant cannot accidentally make Foundry think the whole round is over.
 */
export class Wfrp1edCombat extends foundry.documents.Combat {
	/**
	 * WFRP turn advancement follows unfinished round-turn state rather than the
	 * current numeric turn index. This is necessary because the GM may reorder
	 * initiative during the round.
	 *
	 * The Combatant whose turn is currently focused is marked complete only when
	 * the GM/player actually presses Next Turn. A drag-based postponement changes
	 * focus without marking that Combatant complete.
	 *
	 * @inheritDoc
	 */
	async nextTurn() {
		if (!this.started || !this.combatant || Number(this.round) <= 0) {
			return super.nextTurn();
		}

		await CombatRoundTurnState.markCompleted(this.combatant);
		const next = CombatRoundTurnState.firstUnfinished(this);
		if (!next) return this.nextRound();

		return CombatRoundTurnState.focus(this, next);
	}

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

		await CombatRoundTurnState.resetRound(this);
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

	/**
	 * Closing a focused turn segment is deliberately separate from saying that
	 * the Combatant has completed their turn for the round. Initiative drag may
	 * close and later reopen this attack window while `roundTurnState.completed`
	 * remains false. Only nextTurn() marks round completion.
	 *
	 * @inheritDoc
	 */
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
		await CombatRoundTurnState.initializeCombatant(combatant);
		await CombatAttackEconomy.initializeCombatant(combatant);
		await CombatDodgeEconomy.initializeCombatant(combatant);
		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			0,
		);
	}
}
