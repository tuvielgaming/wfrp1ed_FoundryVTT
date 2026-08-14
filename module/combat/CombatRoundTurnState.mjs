import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "roundTurnState";
const PARRY_DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";
const FOCUS_OPTION = "wfrpRoundTurnFocus";

/**
 * Round-scoped turn completion independent of Combat.turn and initiative order.
 *
 * Foundry's `turn` is an index into the currently sorted initiative list. That
 * is not enough once the GM is allowed to postpone/reorder Combatants during a
 * round: an active Combatant may move to the bottom without having completed
 * their turn. This flag records the actual WFRP round contract separately.
 */
export class CombatRoundTurnState {
	static snapshot(combatant) {
		assertCombatant(combatant);
		const round = nonNegativeInteger(combatant.parent?.round);
		const raw = combatant.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {};
		const sameRound = nonNegativeInteger(raw.round) === round;

		return Object.freeze({
			round,
			completed: sameRound && raw.completed === true,
		});
	}

	static isCompleted(combatant) {
		return this.snapshot(combatant).completed;
	}

	static async resetRound(combat) {
		assertCombat(combat);
		const round = nonNegativeInteger(combat.round);
		const updates = [...combat.combatants].map((combatant) => ({
			_id: combatant.id,
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: {
				round,
				completed: false,
			},
		}));

		if (updates.length) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}

	static async initializeCombatant(combatant) {
		assertCombatant(combatant);
		const combat = combatant.parent;
		if (!combat?.started || nonNegativeInteger(combat.round) <= 0) return;
		await combatant.setFlag(FLAG_SCOPE, FLAG_KEY, {
			round: nonNegativeInteger(combat.round),
			completed: false,
		});
	}

	static async markCompleted(combatant) {
		assertCombatant(combatant);
		await combatant.setFlag(FLAG_SCOPE, FLAG_KEY, {
			round: nonNegativeInteger(combatant.parent?.round),
			completed: true,
		});
		return this.snapshot(combatant);
	}

	/**
	 * First Combatant from the top of the current tracker who has not finished
	 * this round. Respect Foundry's native skip-defeated preference.
	 */
	static firstUnfinished(combat) {
		assertCombat(combat);
		const skipDefeated = combat.settings?.skipDefeated === true;
		return [...combat.turns].find((combatant) => {
			if (skipDefeated && combatant.defeated) return false;
			return !this.isCompleted(combatant);
		}) ?? null;
	}

	static unfinished(combat) {
		assertCombat(combat);
		const skipDefeated = combat.settings?.skipDefeated === true;
		return Object.freeze(
			[...combat.turns].filter((combatant) => {
				if (skipDefeated && combatant.defeated) return false;
				return !this.isCompleted(combatant);
			}),
		);
	}

	/**
	 * Focus one Combatant by its position in the current sorted order.
	 *
	 * `combat.combatant` is derived from the numeric turn index and can become
	 * misleading immediately after initiative values are bulk-reordered. Foundry
	 * also keeps `combat.current.combatantId`, which records the actual lifecycle
	 * turn owner. Use that history ID to decide whether this is index
	 * synchronization or a real End Turn -> Start Turn transition.
	 *
	 * Foundry's visual turn focus can update correctly after initiative is
	 * reordered without necessarily reopening our system-owned Attack economy
	 * window. After a real focus transfer we therefore reconcile the previous
	 * and next Combatant economy states. The reconciliation is idempotent: if
	 * Foundry already fired the normal _onEndTurn/_onStartTurn lifecycle, the
	 * resulting state is detected and no duplicate spend/reset occurs.
	 */
	static async focus(combat, combatant) {
		assertCombat(combat);
		assertCombatant(combatant);
		const index = [...combat.turns].findIndex(
			(entry) => String(entry.id) === String(combatant.id),
		);
		if (index < 0) {
			throw new Error("The requested Combatant is not present in the current turn order.");
		}

		const lifecycleCombatantId = String(
			combat.current?.combatantId ?? combat.combatant?.id ?? "",
		);
		const requestedId = String(combatant.id);

		if (lifecycleCombatantId === requestedId) {
			if (Number(combat.turn) !== index) {
				await combat.update(
					{ turn: index },
					{ [FOCUS_OPTION]: true, direction: 0 },
				);
			}
			return combat;
		}

		const previous = lifecycleCombatantId
			? combat.combatants.get(lifecycleCombatantId) ?? null
			: null;

		await combat.update(
			{ turn: index },
			{ [FOCUS_OPTION]: true, direction: 1 },
		);

		await reconcileAttackWindows(previous, combatant);
		return combat;
	}
}

async function reconcileAttackWindows(previous, next) {
	if (previous && String(previous.id) !== String(next.id)) {
		const previousEconomy = CombatAttackEconomy.snapshot(previous);
		if (previousEconomy.turnStarted && !previousEconomy.turnCompleted) {
			await CombatAttackEconomy.endTurn(previous);
		}
		await previous.setFlag(
			FLAG_SCOPE,
			PARRY_DEBT_REMINDER_FLAG_KEY,
			0,
		);
	}

	const before = CombatAttackEconomy.snapshot(next);
	if (before.turnStarted && !before.turnCompleted) return;

	const after = await CombatAttackEconomy.startTurn(next);
	const paidDebt = Math.max(0, after.spent - before.spent);
	await next.setFlag(
		FLAG_SCOPE,
		PARRY_DEBT_REMINDER_FLAG_KEY,
		paidDebt,
	);
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function assertCombat(combat) {
	if (!(combat instanceof foundry.documents.Combat)) {
		throw new TypeError("A Foundry Combat is required.");
	}
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}
