/**
 * Executable WFRP 1e characteristic tests.
 *
 * Core rule contract:
 * - percentage characteristics test directly against their current value;
 * - Strength and Toughness test against ten times their current value;
 * - Movement, Wounds, and Attacks are never used as test bases.
 *
 * Named standard tests from the Gamesmaster chapter are not registered here
 * yet. Their skill modifiers and situational inputs require dedicated,
 * audited runtime contracts rather than inert metadata or guessed formulas.
 */

export const TESTABLE_CHARACTERISTIC_IDS = Object.freeze([
	"ws",
	"bs",
	"s",
	"t",
	"i",
	"dex",
	"ld",
	"int",
	"cl",
	"wp",
	"fel",
]);

export const STANDARD_TESTS = deepFreeze({
	ws: percentageCharacteristicTest(
		"ws",
		"Weapon Skill",
		"WFRP1ed.CHAR.ws",
	),

	bs: percentageCharacteristicTest(
		"bs",
		"Ballistic Skill",
		"WFRP1ed.CHAR.bs",
	),

	s: nonPercentageCharacteristicTest(
		"s",
		"Strength",
		"WFRP1ed.CHAR.s",
	),

	t: nonPercentageCharacteristicTest(
		"t",
		"Toughness",
		"WFRP1ed.CHAR.t",
	),

	i: percentageCharacteristicTest(
		"i",
		"Initiative",
		"WFRP1ed.CHAR.i",
	),

	dex: percentageCharacteristicTest(
		"dex",
		"Dexterity",
		"WFRP1ed.CHAR.dex",
	),

	ld: percentageCharacteristicTest(
		"ld",
		"Leadership",
		"WFRP1ed.CHAR.ld",
	),

	int: percentageCharacteristicTest(
		"int",
		"Intelligence",
		"WFRP1ed.CHAR.int",
	),

	cl: percentageCharacteristicTest(
		"cl",
		"Cool",
		"WFRP1ed.CHAR.cl",
	),

	wp: percentageCharacteristicTest(
		"wp",
		"Will Power",
		"WFRP1ed.CHAR.wp",
	),

	fel: percentageCharacteristicTest(
		"fel",
		"Fellowship",
		"WFRP1ed.CHAR.fel",
	),
});

/**
 * Build a direct percentage-characteristic test definition.
 *
 * @param {string} id
 * @param {string} label
 * @param {string} labelKey
 * @returns {Object}
 */
function percentageCharacteristicTest(id, label, labelKey) {
	return {
		id,
		label,
		labelKey,
		characteristic: id,
		tags: ["characteristic"],
	};
}

/**
 * Build a Strength or Toughness test definition.
 *
 * @param {string} id
 * @param {string} label
 * @param {string} labelKey
 * @returns {Object}
 */
function nonPercentageCharacteristicTest(id, label, labelKey) {
	return {
		id,
		label,
		labelKey,
		formula: `${id} * 10`,
		tags: [
			"characteristic",
			"non-percentage",
		],
	};
}

/**
 * Recursively freeze test configuration.
 *
 * @param {*} value
 * @returns {*}
 */
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