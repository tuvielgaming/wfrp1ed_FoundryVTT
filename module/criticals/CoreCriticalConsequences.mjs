/**
 * Executable subset of audited Core detailed Critical consequences.
 *
 * This is intentionally declarative. Random durations are formulas which the
 * runtime resolves exactly once when the persistent Critical Wound is applied.
 * One-shot Item movement is likewise a transaction, not a repeatable Active
 * Effect change.
 *
 * Coverage in this first runtime slice focuses on the primitives requested for
 * validation: timed characteristic penalties, indefinite characteristic
 * penalties, held-item drops, and per-round bleeding. The same contract is
 * designed to grow into prone/unconscious/action restrictions and the remaining
 * Critical Effects without replacing the architecture.
 */
const CONSEQUENCES = Object.freeze({
	arm: Object.freeze({
		1: consequence({ dropHeld: "injured-hand" }),
		2: consequence({ dropHeld: "injured-hand" }),
		3: consequence({ dropHeld: "injured-hand" }),
		4: consequence({ dropHeld: "injured-hand" }),
		5: consequence({ dropHeld: "injured-hand" }),
		8: consequence({ dropHeld: "injured-hand" }),
		9: consequence({ dropHeld: "injured-hand" }),
		10: consequence({ dropHeld: "injured-hand" }),
		11: consequence({
			dropHeld: "injured-hand",
			periodicWounds: { formula: "1", until: "medical-attention" },
		}),
		12: consequence({
			dropHeld: "injured-hand",
			periodicWounds: { formula: "1d4", until: "medical-attention" },
		}),
		13: consequence({
			periodicWounds: { formula: "1d4", until: "medical-attention" },
		}),
		14: consequence({
			periodicWounds: { formula: "1d6", until: "medical-attention" },
		}),
	}),
	leg: Object.freeze({
		4: consequence({
			characteristics: halfMovementAndInitiative(),
			duration: { formula: "1d4", units: "rounds" },
		}),
		5: consequence({
			characteristics: halfMovementAndInitiative(),
			until: "medical-attention",
		}),
		6: consequence({
			characteristics: halfMovementAndInitiative(),
			until: "medical-attention",
		}),
		7: consequence({
			characteristics: halfMovementAndInitiative(),
			until: "medical-attention",
		}),
		8: consequence({
			periodicWounds: { formula: "1", until: "medical-attention" },
		}),
		9: consequence({
			periodicWounds: { formula: "1", until: "medical-attention" },
		}),
		10: consequence({
			dropHeld: "all",
			periodicWounds: { formula: "1d4", until: "medical-attention" },
		}),
		11: consequence({
			periodicWounds: { formula: "1d4", until: "medical-attention" },
		}),
		12: consequence({
			periodicWounds: { formula: "1d4", until: "medical-attention" },
		}),
		13: consequence({
			periodicWounds: { formula: "1d4", until: "medical-attention" },
		}),
		14: consequence({
			periodicWounds: { formula: "1d6", until: "medical-attention" },
		}),
	}),
	body: Object.freeze({
		4: consequence({ dropHeld: "all" }),
	}),
});

export function coreCriticalConsequence(location, effectNumber) {
	const normalized = String(location ?? "").trim();
	const number = Number(effectNumber);
	const definition = CONSEQUENCES[normalized]?.[number] ?? null;
	return definition ? structuredCloneSafe(definition) : null;
}

export function coreCriticalConsequenceCoverage() {
	return structuredCloneSafe(CONSEQUENCES);
}

function consequence(source) {
	return Object.freeze(structuredCloneSafe(source));
}

function halfMovementAndInitiative() {
	return [
		{ characteristicId: "m", operation: "multiply", value: 0.5 },
		{ characteristicId: "i", operation: "multiply", value: 0.5 },
	];
}

function structuredCloneSafe(value) {
	return JSON.parse(JSON.stringify(value));
}
