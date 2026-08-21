/*
 * WFRP 1e Standard Test launcher procedures which are not d100 Tests.
 *
 * Mechanics authority:
 * - English Core Rulebook, Time and Motion, printed pp. 73-75:
 *   Moving/Running, Obstacles, Difficult Ground, Swimming, and
 *   Jumping/Falling/Leaping/Climbing.
 * - Polish Core Rulebook, Czas i ruch, printed pp. 73-75:
 *   Poruszanie się/Bieg, Przeszkody, Trudny teren, Pływanie, and
 *   Zeskok/Upadek/Skok/Wspinaczka.
 *
 * These definitions are intentionally separate from TestManager/Test because
 * those classes model d100 target tests. Movement procedures derive distances
 * and may launch an ordinary Risk Test when the Core procedure requires one.
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

	fall: {
		id: "fall",
		label: "Fall",
		labelKey: "WFRP1ED.StandardTest.Fall",
		polishFallback: "Upadek",
		effectTargets: [],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-fall-height",
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

	obstacle: {
		id: "obstacle",
		label: "Obstacle",
		labelKey: "WFRP1ED.StandardTest.Obstacle",
		polishFallback: "Przeszkoda",
		effectTargets: [],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-movement-pace",
		],
	},

	difficultGround: {
		id: "difficultGround",
		label: "Difficult Ground",
		labelKey: "WFRP1ED.StandardTest.DifficultGround",
		polishFallback: "Trudny teren",
		effectTargets: [],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-movement-pace",
		],
	},

	swimming: {
		id: "swimming",
		label: "Swimming",
		labelKey: "WFRP1ED.StandardTest.Swimming",
		polishFallback: "Pływanie",
		effectTargets: [],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-swimming-hazard",
			"requires-swimming-encumbrance-modifier",
		],
	},

	climbing: {
		id: "climbing",
		label: "Climbing",
		labelKey: "WFRP1ED.StandardTest.Climbing",
		polishFallback: "Wspinaczka",
		effectTargets: [],
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-climb-type",
			"requires-climb-sheer-access",
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
