/*
 * Audited WFRP 1e core-skill interactions used by Standard Tests.
 *
 * Mechanics authority:
 * - English Core Rulebook, Skills, printed pp. 46-58.
 * - English Core Rulebook, Standard Tests, printed p. 66 and detailed
 *   procedures on printed pp. 67-72.
 *
 * Polish terminology is taken from the corresponding Polish Skills and
 * Standard Tests sections. This module deliberately stores language-neutral
 * rules ids only; visible names remain Item/localization content.
 *
 * The Standard Tests table says listed skills are potentially relevant. The
 * GM decides which skills apply in the actual situation. Therefore this
 * registry describes what an applicable owned skill does; it does not decide
 * applicability or silently enable every matching modifier.
 */

export const STANDARD_TEST_SKILL_RULES = deepFreeze({
	acrobatics: {
		effects: [
			fixedModifier("busk", 10),
			fixedModifier("employment", 10, {
				condition: "entertainer-work",
			}),
			procedureEffect("fall", "movement-acrobatics"),
			procedureEffect("jump", "movement-acrobatics"),
			procedureEffect("leap", "movement-acrobatics"),
		],
	},

	acting: {
		effects: [
			fixedModifier("bluff", 15),
			fixedModifier("gossip", 15),
			fixedModifier("busk", 10),
			fixedModifier("employment", 10, {
				condition: "entertainer-work",
			}),
		],
	},

	acuteHearing: {
		effects: [
			fixedModifier("listen", 10),
			procedureEffect("listen", "hearing-distance-plus-2-yards"),
		],
	},

	ambidextrous: {
		effects: [
			fixedModifier("risk", 10, {
				condition: "dexterity-based-risk",
			}),
		],
	},

	animalTraining: {
		effects: [
			fixedModifier("employment", 10, {
				condition: "retainer-stable-falconer-work",
			}),
		],
	},

	art: {
		effects: [
			fixedModifier("busk", 10),
		],
	},

	boatBuilding: {
		effects: [
			fixedModifier("construct", 10, {
				condition: "wood-or-boat-related-materials",
			}),
		],
	},

	bribery: {
		effects: [
			fixedModifier("bribe", 20),
			procedureEffect("gossip", "relevant-skill"),
			procedureEffect("loyalty", "relevant-skill"),
		],
	},

	carpentry: {
		effects: [
			fixedModifier("construct", 10, {
				condition: "wooden-structures",
			}),
		],
	},

	charm: {
		effects: [
			fixedModifier("bargain", 10),
			fixedModifier("bluff", 10),
			fixedModifier("gossip", 10),
		],
	},

	clown: {
		effects: [
			fixedModifier("bluff", 10),
			fixedModifier("busk", 10),
			procedureEffect("fall", "movement-clown"),
			procedureEffect("jump", "movement-clown"),
		],
	},

	comedian: {
		effects: [
			fixedModifier("busk", 10),
			fixedModifier("gossip", 15),
		],
	},

	concealmentRural: {
		effects: [
			choiceModifier("hide", {
				stationary: 20,
				cautiousMovement: 5,
			}, {
				condition: "rural-environment",
			}),
			procedureEffect("sneak", "concealment-rural"),
		],
	},

	concealmentUrban: {
		effects: [
			choiceModifier("hide", {
				stationary: 20,
				cautiousMovement: 5,
			}, {
				condition: "urban-environment",
			}),
			procedureEffect("sneak", "concealment-urban"),
		],
	},

	contortionist: {
		effects: [
			fixedModifier("busk", 10),
		],
	},

	dance: {
		effects: [
			fixedModifier("busk", 10),
			fixedModifier("employment", 10, {
				condition: "entertainer-work",
			}),
		],
	},

	engineer: {
		effects: [
			fixedModifier("construct", 20),
		],
	},

	escapology: {
		effects: [
			fixedModifier("busk", 10),
		],
	},

	etiqUette: {
		effects: [
			procedureEffect("standardTests", "high-society-plus-10"),
		],
	},

	evaluate: {
		effects: [
			fixedModifier("estimate", 10),
			procedureEffect("estimate", "successful-margin-5-percent"),
		],
	},

	fireEating: {
		effects: [
			fixedModifier("busk", 10),
		],
	},

	followTrail: {
		effects: [
			fixedModifier("estimate", 10, {
				condition: "estimating-number-of-quarry",
			}),
		],
	},

	gamble: {
		effects: [
			derivedModifier("gamble", {
				characteristic: "int",
				operation: "half",
			}),
		],
	},

	haggle: {
		effects: [
			fixedModifier("bargain", 10),
		],
	},

	immunityToDisease: {
		effects: [
			fixedModifier("disease", 10),
		],
	},

	immunityToPoison: {
		effects: [
			fixedModifier("poison", 10),
		],
	},

	jester: {
		effects: [
			fixedModifier("bluff", 10),
			fixedModifier("busk", 10),
		],
	},

	juggle: {
		effects: [
			fixedModifier("busk", 10),
		],
	},

	linguistics: {
		effects: [
			fixedModifier("understandLanguage", 10),
		],
	},

	mimic: {
		effects: [
			fixedModifier("bluff", 10),
			fixedModifier("busk", 10),
		],
	},

	mining: {
		effects: [
			fixedModifier("construct", 10, {
				condition: "underground-construction",
			}),
		],
	},

	musicianship: {
		effects: [
			fixedModifier("busk", 10),
			fixedModifier("employment", 10, {
				condition: "entertainer-work",
			}),
		],
	},

	palmistry: {
		effects: [
			fixedModifier("busk", 10),
		],
	},

	pickLock: {
		effects: [
			repeatedAcquisitionModifier("pickLock", 10),
		],
	},

	pickPocket: {
		effects: [
			repeatedAcquisitionModifier("pickPocket", 10),
		],
	},

	publicSpeaking: {
		effects: [
			procedureEffect("bluff", "public-speaking-scope"),
			procedureEffect("gossip", "public-speaking-scope"),
		],
	},

	ride: {
		effects: [
			fixedModifier("risk", 10, {
				condition: "mounted-risk-covered-by-ride",
			}),
		],
	},

	seduction: {
		effects: [
			fixedModifier("bargain", 10, {
				condition: "opposite-sex-target",
			}),
			fixedModifier("bluff", 10, {
				condition: "opposite-sex-target",
			}),
			fixedModifier("gossip", 10, {
				condition: "opposite-sex-target",
			}),
		],
	},

	shadowing: {
		effects: [
			fixedModifier("hide", 10),
		],
	},

	silentMoveRural: {
		effects: [
			targetModifier("listen", -10, {
				condition: "rural-environment",
			}),
			procedureEffect("sneak", "silent-move-rural"),
		],
	},

	silentMoveUrban: {
		effects: [
			targetModifier("listen", -10, {
				condition: "urban-environment",
			}),
			procedureEffect("sneak", "silent-move-urban"),
		],
	},

	sing: {
		effects: [
			fixedModifier("busk", 10),
			fixedModifier("employment", 10, {
				condition: "entertainer-work",
			}),
		],
	},

	smithing: {
		effects: [
			fixedModifier("construct", 10, {
				condition: "suitable-metal-products",
			}),
		],
	},

	stoneworking: {
		effects: [
			fixedModifier("construct", 10, {
				condition: "working-with-stone",
			}),
		],
	},

	storyTelling: {
		effects: [
			fixedModifier("busk", 10),
			fixedModifier("gossip", 10),
		],
	},

	strongman: {
		effects: [
			fixedModifier("employment", 10, {
				condition: "entertainer-work",
			}),
		],
	},

	superNumerate: {
		effects: [
			fixedModifier("estimate", 20),
			fixedModifier("gamble", 10),
		],
	},

	swim: {
		effects: [
			fixedModifier("risk", 20, {
				condition: "swimming",
			}),
		],
	},

	tailor: {
		effects: [
			fixedModifier("bluff", 10, {
				condition: "using-disguise",
			}),
		],
	},

	torture: {
		effects: [
			targetCharacteristicModifier("interrogate", "wp", -10),
		],
	},

	trickRiding: {
		effects: [
			fixedModifier("risk", 30, {
				condition: "dangerous-mounted-trick",
			}),
		],
	},

	wit: {
		effects: [
			fixedModifier("bluff", 10),
			fixedModifier("gossip", 10),
		],
	},
});

/**
 * Return the audited rule for one stable Skill rules id.
 *
 * @param {string} rulesId
 * @returns {Object|null}
 */
export function getStandardTestSkillRule(rulesId) {
	const id = String(rulesId ?? "").trim();

	return STANDARD_TEST_SKILL_RULES[id] ?? null;
}

/**
 * Return effects from one Skill which can participate in a named Standard
 * Test. Broad procedure effects are returned only when they explicitly name
 * the requested test id.
 *
 * @param {string} rulesId
 * @param {string} testId
 * @returns {readonly Object[]}
 */
export function getStandardTestSkillEffects(rulesId, testId) {
	const rule = getStandardTestSkillRule(rulesId);
	const id = String(testId ?? "").trim();

	if (!rule || !id) {
		return Object.freeze([]);
	}

	return Object.freeze(
		rule.effects.filter((effect) => effect.testId === id),
	);
}

function fixedModifier(testId, value, options = {}) {
	return {
		type: "modifier",
		testId,
		value,
		...options,
	};
}

function choiceModifier(testId, choices, options = {}) {
	return {
		type: "choice-modifier",
		testId,
		choices,
		...options,
	};
}

function derivedModifier(testId, calculation, options = {}) {
	return {
		type: "derived-modifier",
		testId,
		calculation,
		...options,
	};
}

function repeatedAcquisitionModifier(testId, valuePerExtraAcquisition) {
	return {
		type: "repeated-acquisition-modifier",
		testId,
		valuePerExtraAcquisition,
	};
}

function targetModifier(testId, value, options = {}) {
	return {
		type: "target-modifier",
		testId,
		value,
		...options,
	};
}

function targetCharacteristicModifier(
	testId,
	characteristic,
	value,
	options = {},
) {
	return {
		type: "target-characteristic-modifier",
		testId,
		characteristic,
		value,
		...options,
	};
}

function procedureEffect(testId, procedure) {
	return {
		type: "procedure",
		testId,
		procedure,
	};
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
