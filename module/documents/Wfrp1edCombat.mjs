import { CombatAttackEconomy } from "../combat/CombatAttackEconomy.mjs";

/**
 * WFRP 1e Combat document.
 *
 * Foundry v14 provides designated-GM lifecycle callbacks for system-specific
 * round and turn state. Using them keeps attack-resource bookkeeping
 * authoritative without duplicating turn progression in hook listeners.
 */
export class Wfrp1edCombat extends foundry.documents.Combat {
	/** @inheritDoc */
	async _onStartRound(context) {
		await super._onStartRound(context);
		await CombatAttackEconomy.startRound(this);
	}

	/** @inheritDoc */
	async _onStartTurn(combatant, context) {
		await super._onStartTurn(combatant, context);
		await CombatAttackEconomy.startTurn(combatant);
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
	}
}
