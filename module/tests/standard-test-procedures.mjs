/*
 * WFRP 1e Standard Test launcher procedures which are not d100 Tests.
 *
 * Mechanics authority:
 * - English Core Rulebook, Time and Motion, printed p. 75:
 *   Jumping, Falling, Leaping, Climbing.
 * - Polish Core Rulebook, Ruchy, printed p. 75:
 *   Zeskok, Upadek, Skok, Wspinaczka.
 *
 * These definitions are intentionally separate from TestManager/Test because
 * those classes model d100 target tests. Jumping and Leaping use d6 movement
 * procedures and must not be forced through the percentile Test contract.
 */

export const STANDARD_TEST_PROCEDURES = deepFreeze({
	jump: {
		id: "jump",
		label: "Jump",
		labelKey: "WFRP1ED.StandardTest.Jump",
		polishFallback: "Zeskok",
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
		tags: [
			"standard",
			"procedure",
			"movement",
			"requires-leap-gap",
			"requires-run-up",
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
