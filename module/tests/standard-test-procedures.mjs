/*
 * WFRP 1e Standard Test launcher procedures which are not d100 Tests.
 *
 * Mechanics authority:
 * - English Core Rulebook, Time and Motion, printed pp. 73-75:
 *   Moving/Running and Jumping/Falling/Leaping/Climbing.
 * - Polish Core Rulebook, Ruchy, printed pp. 73-75:
 *   Poruszanie się/Bieg and Zeskok/Upadek/Skok/Wspinaczka.
 *
 * These definitions are intentionally separate from TestManager/Test because
 * those classes model d100 target tests. Jumping and Leaping use d6 movement
 * procedures, while continued Running combines a derived movement rate with an
 * optional Risk Test underground.
 */

export const STANDARD_TEST_PROCEDURES = deepFreeze({
	jump: {
		id: "jump",
		label: "Jump",
		labelKey: "WFRP1ED.StandardTest.Jump",
		polishFallback: "Zeskok",
		effectTargets: [
			"procedure.movement.jump.reductionDie",
		],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-jump-height",
		],
	},

	leap: {
		id: "leap",
		label: "Leap",
		labelKey: "WFRP1ED.StandardTest.Leap",
		polishFallback: "Skok",
		effectTargets: [
			"procedure.movement.leap.distance",
		],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-leap-gap",
			"requires-run-up",
		],
	},

	running: {
		id: "running",
		label: "Running",
		labelKey: "WFRP1ED.StandardTest.Running",
		polishFallback: "Bieg",
		effectTargets: [],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-running-round",
			"requires-underground",
		],
	},
});

/**
 * Localized procedure name with audited English/Polish fallbacks.
 *
 * @param {Object} procedure
 * @returns {string}
 */
export function standardTestProcedureName(procedure) {
	if (!procedure) {
		return "";
	}

	const localized = globalThis.game?.i18n?.localize?.(
		procedure.labelKey,
	);

	if (localized && localized !== procedure.labelKey) {
		return localized;
	}

	return globalThis.game?.i18n?.lang === "pl"
		? procedure.polishFallback
		: procedure.label;
}

function deepFreeze(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.isFrozen(value)
	) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return Object.freeze(value);
}
