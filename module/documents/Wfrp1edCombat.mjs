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
 * deliberately remain equal.
 *
 * Foundry's native Combat.turns remains Initiative-sorted and owns focus/lifecycle
 * bookkeeping. Temporary WFRP round order is stored separately by
 * CombatRoundInitiativeOrder and decides who acts next plus how tracker rows are
 * displayed. Dragging therefore never rewrites Initiative or Foundry's turn array.
 *
 * Round start is the authoritative reset point for current-round Attack/parry
 * resources. Starting a Combatant turn only opens that Combatant's attack
 * window; it never restores Attacks already lost to same-round parries.
 */
export class Wfrp1edCombat extends foundry.documents.Combat {
	/**
	 * Foundry's Roll Initiative action becomes the Core WFRP procedure: assign
	 * each requested Combatant their Actor's current Initiative characteristic.
	 * No initiative die exists in the WFRP 1e Core procedure.
	 *
	 * Optional weapon Initiative modifiers are intentionally not guessed here.
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
	 * Starting combat always resolves Core Initiative for every Combatant.
	 *
	 * @inheritDoc
	 */
	async startCombat() {
		if (!this.started) {
			const ids = [...this.combatants].map((combatant) => String(combatant.id));
			if (ids.length) {
				await this.rollInitiative(ids, {
					updateTurn: false,
					[CORE_INITIATIVE_OPTION]: true,
				});
			}
			await CombatRoundInitiativeOrder.captureCombatBaselines(this, {
				force: true,
			});
		}
		return super.startCombat();
	}

	/**
	 * WFRP turn advancement follows unfinished state in the independent temporary
	 * acting order. Foundry focus is then moved to that Combatant using its native
	 * Initiative-sorted turn index.
	 *
	 * @inheritDoc
	 */
	async nextTurn() {
		if (!this.started || !this.combatant || Number(this.round) <= 0) {
			return super.nextTurn();
		}

		const prior = this.combatant;
		await CombatRoundTurnState.markCompleted(prior);
		const next = CombatRoundInitiativeOrder.firstUnfinished(this);
		if (!next) return this.nextRound();

		const result = await CombatRoundTurnState.focus(this, next);
		await CombatInitiativeClock.emitTurnStart(this, prior, next);
		return result;
	}

	/**
	 * End-of-round is the immutable clock safety boundary. After it resolves,
	 * discard the temporary acting order, refresh real Initiative from Actors,
	 * and let Foundry advance using its normal Initiative-sorted turn array.
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

		await CombatRoundInitiativeOrder.captureCombatBaselines(this, {
			force: true,
		});
		await CombatRoundInitiativeOrder.initializeRound(this);

		await CombatRoundTurnState.resetRound(this);
		await CombatAttackEconomy.startRound(this);
		await CombatDodgeEconomy.startRound(this);
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
	 * Closing a focused turn segment is separate from saying that the Combatant
	 * completed their WFRP turn. A postponed Combatant may be focused again later.
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

	/**
	 * A Combatant joining the encounter immediately receives Core Initiative and
	 * is inserted into the current WFRP acting order without rewriting existing
	 * temporary reorder decisions.
	 *
	 * @inheritDoc
	 */
	async _onEnter(combatant) {
		await super._onEnter(combatant);

		await this.rollInitiative([String(combatant.id)], {
			updateTurn: false,
			[CORE_INITIATIVE_OPTION]: true,
		});
		await CombatRoundInitiativeOrder.captureBaseline(combatant, {
			force: true,
		});
		if (this.started && Number(this.round) > 0) {
			await CombatRoundInitiativeOrder.insertCombatant(this, combatant);
		}

		await CombatRoundTurnState.initializeCombatant(combatant);
		await CombatAttackEconomy.initializeCombatant(combatant);
		await CombatDodgeEconomy.initializeCombatant(combatant);
		await combatant.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			0,
		);
	}

	/**
	 * Preserve the remaining temporary order when one Combatant leaves. When the
	 * whole Combat is being deleted, the parent no longer exists in CombatEncounters
	 * and must never be updated from this exit workflow.
	 *
	 * @inheritDoc
	 */
	async _onExit(combatant) {
		await super._onExit(combatant);
		const id = String(this.id ?? "");
		if (!id || game.combats?.get?.(id) !== this) return;
		if (this.started && Number(this.round) > 0) {
			await CombatRoundInitiativeOrder.removeCombatant(this);
		}
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
