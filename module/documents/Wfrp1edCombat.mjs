import { CombatAttackEconomy } from "../combat/CombatAttackEconomy.mjs";
import { CombatDodgeEconomy } from "../combat/CombatDodgeEconomy.mjs";
import { CombatInitiativeClock } from "../combat/CombatInitiativeClock.mjs";
import { CombatRoundInitiativeOrder } from "../combat/CombatRoundInitiativeOrder.mjs";
import { CombatRoundTurnState } from "../combat/CombatRoundTurnState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PARRY_DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";
const CORE_INITIATIVE_OPTION = "wfrpCoreInitiative";

/**
 * WFRP 1e Combat document.
 *
 * Core initiative is deterministic: Combatants act in descending current
 * Initiative characteristic rather than rolling a die. Equal Initiative values
 * deliberately remain equal; Foundry may serialize their UI turns, but the WFRP
 * rules layer treats the shared Initiative score as one simultaneous band.
 *
 * Round start is the authoritative reset point for current-round Attack/parry
 * resources. Starting a Combatant turn only opens that Combatant's attack
 * window; it never restores Attacks already lost to same-round parries.
 *
 * Initiative edits made during a started round are temporary. Turn completion
 * is tracked separately from initiative position, so postponing the current
 * Combatant cannot accidentally make Foundry think the whole round is over.
 *
 * `parryDebtReminder` is presentation-only. Default-mode debt must survive the
 * end-of-round transition, remain visible after it is paid at the Combatant's
 * next turn start, and disappear only when that Combatant actually completes
 * the turn with Next Turn. Initiative focus changes must not clear it.
 */
export class Wfrp1edCombat extends foundry.documents.Combat {
	/**
	 * Foundry's Roll Initiative action becomes the Core WFRP procedure: assign
	 * each requested Combatant their Actor's current Initiative characteristic.
	 * No initiative die exists in the WFRP 1e Core procedure.
	 *
	 * Optional weapon Initiative modifiers are intentionally not guessed here.
	 * The existing optional Weapon Modifiers world setting remains authoritative,
	 * but combat first needs a dedicated stateful resolver for entries whose
	 * Initiative bonus changes with combat circumstances (for example polearms).
	 *
	 * @inheritDoc
	 */
	async rollInitiative(ids, options = {}) {
		const requested = normalizeCombatantIds(ids, this);
		const updates = [];

		for (const id of requested) {
			const combatant = this.combatants.get(id);
			const initiative = coreInitiativeFor(combatant);
			if (initiative === null) continue;
			updates.push({ _id: id, initiative });
		}

		if (updates.length) {
			await this.updateEmbeddedDocuments(
				"Combatant",
				updates,
				{ ...options, [CORE_INITIATIVE_OPTION]: true },
			);
		}

		if (!this.started) {
			await CombatRoundInitiativeOrder.captureCombatBaselines(this, {
				force: true,
			});
		}
		return this;
	}

	/**
	 * WFRP turn advancement follows unfinished round-turn state rather than the
	 * current numeric turn index. This is necessary because the GM may reorder
	 * initiative during the round.
	 *
	 * The Combatant whose turn is currently focused is marked complete only when
	 * the GM/player actually presses Next Turn. A drag-based postponement changes
	 * focus without marking that Combatant complete.
	 *
	 * The immutable initiative clock is emitted only from this real progression
	 * path. Merely dragging/re-focusing the tracker therefore cannot age a wound.
	 *
	 * @inheritDoc
	 */
	async nextTurn() {
		if (!this.started || !this.combatant || Number(this.round) <= 0) {
			return super.nextTurn();
		}

		const prior = this.combatant;
		await CombatRoundTurnState.markCompleted(prior);
		const next = CombatRoundTurnState.firstUnfinished(this);
		if (!next) return this.nextRound();

		const result = await CombatRoundTurnState.focus(this, next);
		await CombatInitiativeClock.emitTurnStart(this, prior, next);
		return result;
	}

	/**
	 * End-of-round is the immutable clock safety boundary. It is emitted before
	 * temporary initiative is restored, so a clock point made unreachable by a
	 * death, Skip Defeated, or a temporary reorder still completes exactly one
	 * full cycle before the round is allowed to advance.
	 *
	 * After that boundary has resolved, the next round rebuilds canonical order
	 * from each Actor's current Initiative characteristic. Any temporary reorder
	 * from the completed round is discarded, while real characteristic changes
	 * are naturally reflected in the following round.
	 *
	 * @inheritDoc
	 */
	async nextRound() {
		if (this.started && Number(this.round) > 0) {
			await CombatInitiativeClock.emitRoundEnd(this);
		}

		await CombatRoundInitiativeOrder.resetBeforeNextRound(this);
		await this.rollInitiative(
			[...this.combatants].map((entry) => String(entry.id)),
			{ [CORE_INITIATIVE_OPTION]: true },
		);
		await CombatRoundInitiativeOrder.captureCombatBaselines(this, {
			force: true,
		});

		const result = await super.nextRound();
		if (this.started && Number(this.round) > 0 && this.combatant) {
			await CombatInitiativeClock.emitRoundStart(this, this.combatant);
		}
		return result;
	}

	/** @inheritDoc */
	async _onStartRound(context) {
		await super._onStartRound(context);

		/* Round 1 establishes the baseline after any pre-combat initiative action. */
		if (Number(this.round) === 1) {
			await CombatRoundInitiativeOrder.captureCombatBaselines(this, {
				force: true,
			});
		}

		await CombatRoundTurnState.resetRound(this);
		await CombatAttackEconomy.startRound(this);
		await CombatDodgeEconomy.startRound(this);

		/*
		 * Do not clear parryDebtReminder here. Default-mode debt intentionally
		 * survives the round boundary and the reminder is owned by the affected
		 * Combatant's real Next Turn completion, not by the global round reset.
		 */
	}

	/** @inheritDoc */
	async _onStartTurn(combatant, context) {
		await super._onStartTurn(combatant, context);

		const existingReminder = nonNegativeInteger(
			combatant.getFlag?.(FLAG_SCOPE, PARRY_DEBT_REMINDER_FLAG_KEY),
		);
		const before = CombatAttackEconomy.snapshot(combatant);
		const after = await CombatAttackEconomy.startTurn(combatant);
		const paidDebt = Math.max(0, after.spent - before.spent);
		const reminder = paidDebt > 0 ? paidDebt : existingReminder;

		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			reminder,
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

		if (CombatRoundTurnState.isCompleted(combatant)) {
			await combatant.setFlag(
				FLAG_SCOPE,
				PARRY_DEBT_REMINDER_FLAG_KEY,
				0,
			);
		}
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

function normalizeCombatantIds(ids, combat) {
	if (Array.isArray(ids)) return ids.map(String);
	if (ids instanceof Set) return [...ids].map(String);
	const id = String(ids ?? "").trim();
	if (id) return [id];
	return [...(combat?.combatants ?? [])].map((entry) => String(entry.id));
}

function coreInitiativeFor(combatant) {
	const actor = combatant?.actor;
	if (!(actor instanceof foundry.documents.Actor)) return null;
	try {
		const value = Number(actor.getCharacteristicValue?.("i"));
		return Number.isFinite(value) ? value : null;
	} catch (_error) {
		return null;
	}
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}
