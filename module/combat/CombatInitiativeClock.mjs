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
 * The coordinate is the round baseline Initiative value captured before any
 * temporary tracker reorder. A clock therefore does not follow a Combatant when
 * that Combatant delays, is reordered, becomes defeated, is skipped, or is
 * removed from Combat.
 *
 * One eligible round reaches the clock at the first of:
 * - round start already being at/below the clock Initiative;
 * - real turn progression crossing from above the clock to at/below it;
 * - round end, when the clock was not otherwise reachable in that round.
 *
 * Reordering/focus changes do not emit clock events. Wfrp1edCombat emits events
 * only from its real Next Turn / Next Round lifecycle.
 */
export class CombatInitiativeClock {
	static capture(combat) {
		if (!(combat instanceof foundry.documents.Combat) || !combat.started) {
			return emptyClockState();
		}

		const combatant = lifecycleCombatant(combat);
		const initiative = this.canonicalInitiative(combatant);
		return {
			combatId: String(combat.id ?? ""),
			startRound: nonNegativeInteger(combat.round),
			clockInitiative: initiative,
			lastClockRound: 0,
		};
	}

	static canonicalInitiative(combatant) {
		if (!(combatant instanceof foundry.documents.Combatant)) return null;
		const baseline = nullableFinite(
			combatant.getFlag?.(FLAG_SCOPE, BASE_INITIATIVE_FLAG),
		);
		if (baseline !== null) return baseline;
		return nullableFinite(combatant.initiative);
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
				/* End of round is the agreed safety boundary: if a clock point was
				 * skipped, removed, or otherwise never crossed, the cycle cannot
				 * extend beyond the round itself. */
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
			currentInitiative: this.canonicalInitiative(combatant),
			currentCombatantId: String(combatant?.id ?? ""),
		});
	}

	static async emitTurnStart(combat, priorCombatant, currentCombatant) {
		return this.#emit(combat, {
			kind: COMBAT_INITIATIVE_CLOCK_EVENT.TURN_START,
			round: nonNegativeInteger(combat?.round),
			priorInitiative: this.canonicalInitiative(priorCombatant),
			currentInitiative: this.canonicalInitiative(currentCombatant),
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
		Hooks.callAll(COMBAT_INITIATIVE_CLOCK_HOOK, combat, event);
		return event;
	}
}

function lifecycleCombatant(combat) {
	if (!(combat instanceof foundry.documents.Combat)) return null;
	const id = String(combat.current?.combatantId ?? combat.combatant?.id ?? "");
	return id ? combat.combatants.get(id) ?? combat.combatant ?? null : combat.combatant ?? null;
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
