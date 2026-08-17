import { CombatRoundInitiativeOrder } from "./CombatRoundInitiativeOrder.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BASE_INITIATIVE_FLAG = "roundBaseInitiative";

export const COMBAT_INITIATIVE_CLOCK_HOOK = "wfrp1edCombatInitiativeClock";

export const COMBAT_INITIATIVE_CLOCK_EVENT = Object.freeze({
	ROUND_START: "roundStart",
	TURN_START: "turnStart",
	ROUND_END: "roundEnd",
});

/**
 * Immutable WFRP initiative-time coordinate used by effects which must measure
 * full combat cycles independently of the Combatant currently occupying a turn.
 *
 * Foundry's native Combat.turns remains Initiative-sorted for lifecycle/focus.
 * The separate WFRP round-order list describes who occupies each acting slot.
 * Timeline coordinates are therefore derived by assigning the frozen descending
 * Initiative bands to those WFRP slots by position.
 *
 * One eligible round reaches the clock at the first of:
 * - round start already being at/below the clock Initiative;
 * - real turn progression crossing from above the clock to at/below it;
 * - round end, when the clock was not otherwise reachable in that round.
 */
export class CombatInitiativeClock {
	static #consumers = new Set();

	static registerConsumer(consumer) {
		if (typeof consumer !== "function") {
			throw new TypeError("Initiative clock consumer must be a function.");
		}
		this.#consumers.add(consumer);
		return () => this.#consumers.delete(consumer);
	}

	static capture(combat) {
		if (!(combat instanceof foundry.documents.Combat) || !combat.started) {
			return emptyClockState();
		}

		const combatant = lifecycleCombatant(combat);
		const initiative = this.timelineInitiative(combat, combatant);
		return {
			combatId: String(combat.id ?? ""),
			startRound: nonNegativeInteger(combat.round),
			clockInitiative: initiative,
			lastClockRound: 0,
		};
	}

	/** Stable Initiative fact owned by one Combatant for the current round. */
	static canonicalInitiative(combatant) {
		if (!(combatant instanceof foundry.documents.Combatant)) return null;
		const baseline = nullableFinite(
			combatant.getFlag?.(FLAG_SCOPE, BASE_INITIATIVE_FLAG),
		);
		if (baseline !== null) return baseline;
		return nullableFinite(combatant.initiative);
	}

	/**
	 * Initiative-time coordinate represented by a Combatant's WFRP acting slot.
	 * Actor identity is irrelevant to the coordinate itself: dragging an actor
	 * changes which actor occupies a slot, not the Initiative band assigned there.
	 */
	static timelineInitiative(combat, combatant) {
		if (!(combat instanceof foundry.documents.Combat)) return null;
		if (!(combatant instanceof foundry.documents.Combatant)) return null;

		const actingOrder = CombatRoundInitiativeOrder.orderedCombatants(combat);
		const slot = actingOrder.findIndex(
			(entry) => String(entry?.id ?? "") === String(combatant.id ?? ""),
		);
		if (slot < 0) return null;

		const timeline = [...(combat.combatants ?? [])]
			.map((entry) => this.canonicalInitiative(entry))
			.filter((value) => value !== null)
			.sort((left, right) => right - left);
		return slot < timeline.length ? timeline[slot] : null;
	}

	static anchored(state, combat) {
		return Boolean(
			String(state?.combatId ?? "") === String(combat?.id ?? "") &&
			nonNegativeInteger(state?.startRound) > 0 &&
			nullableFinite(state?.clockInitiative) !== null
		);
	}

	static withAnchor(state, combat) {
		if (this.anchored(state, combat)) return foundry.utils.deepClone(state);
		return {
			...foundry.utils.deepClone(state ?? {}),
			...this.capture(combat),
		};
	}

	static isDue(state, event) {
		if (!state || !event) return false;
		if (String(state.combatId ?? "") !== String(event.combatId ?? "")) return false;

		const clock = nullableFinite(state.clockInitiative);
		const startRound = nonNegativeInteger(state.startRound);
		const round = nonNegativeInteger(event.round);
		const lastClockRound = nonNegativeInteger(state.lastClockRound);
		if (clock === null || !startRound || round <= startRound || round <= lastClockRound) {
			return false;
		}

		switch (String(event.kind ?? "")) {
			case COMBAT_INITIATIVE_CLOCK_EVENT.ROUND_START: {
				const current = nullableFinite(event.currentInitiative);
				return current !== null && current <= clock;
			}
			case COMBAT_INITIATIVE_CLOCK_EVENT.TURN_START: {
				const prior = nullableFinite(event.priorInitiative);
				const current = nullableFinite(event.currentInitiative);
				return prior !== null && current !== null && prior > clock && current <= clock;
			}
			case COMBAT_INITIATIVE_CLOCK_EVENT.ROUND_END:
				return true;
			default:
				return false;
		}
	}

	static stamp(state, event) {
		return {
			...foundry.utils.deepClone(state ?? {}),
			lastClockRound: nonNegativeInteger(event?.round),
			lastClockEventId: String(event?.id ?? ""),
		};
	}

	static async emitRoundStart(combat, combatant = lifecycleCombatant(combat)) {
		return this.#emit(combat, {
			kind: COMBAT_INITIATIVE_CLOCK_EVENT.ROUND_START,
			round: nonNegativeInteger(combat?.round),
			currentInitiative: this.timelineInitiative(combat, combatant),
			currentCombatantId: String(combatant?.id ?? ""),
		});
	}

	static async emitTurnStart(combat, priorCombatant, currentCombatant) {
		return this.#emit(combat, {
			kind: COMBAT_INITIATIVE_CLOCK_EVENT.TURN_START,
			round: nonNegativeInteger(combat?.round),
			priorInitiative: this.timelineInitiative(combat, priorCombatant),
			currentInitiative: this.timelineInitiative(combat, currentCombatant),
			priorCombatantId: String(priorCombatant?.id ?? ""),
			currentCombatantId: String(currentCombatant?.id ?? ""),
		});
	}

	static async emitRoundEnd(combat) {
		return this.#emit(combat, {
			kind: COMBAT_INITIATIVE_CLOCK_EVENT.ROUND_END,
			round: nonNegativeInteger(combat?.round),
			currentCombatantId: String(lifecycleCombatant(combat)?.id ?? ""),
		});
	}

	static async #emit(combat, source) {
		if (!(combat instanceof foundry.documents.Combat) || !combat.id) return null;
		const event = foundry.utils.deepFreeze({
			combatId: String(combat.id),
			...source,
			id: [
				String(combat.id),
				String(source.kind ?? ""),
				String(nonNegativeInteger(source.round)),
				String(source.priorCombatantId ?? ""),
				String(source.currentCombatantId ?? ""),
			].join("|"),
		});

		for (const consumer of [...this.#consumers]) {
			await consumer(combat, event);
		}
		Hooks.callAll(COMBAT_INITIATIVE_CLOCK_HOOK, combat, event);
		return event;
	}
}

function lifecycleCombatant(combat) {
	if (!(combat instanceof foundry.documents.Combat)) return null;
	if (combat.combatant) return combat.combatant;
	const id = String(combat.current?.combatantId ?? "");
	return id ? combat.combatants.get(id) ?? null : null;
}

function emptyClockState() {
	return {
		combatId: "",
		startRound: 0,
		clockInitiative: null,
		lastClockRound: 0,
	};
}

function nullableFinite(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
