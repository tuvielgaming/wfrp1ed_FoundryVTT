/*
 * Executable WFRP 1e named Standard Tests.
 *
 * Mechanics authority:
 * - English Core Rulebook, Standard Tests, printed pp. 66-72.
 * - Polish Core Rulebook, Standardowe Testy, printed pp. 66-71.
 *
 * Only procedures which can be expressed by the current Test/TestContext
 * contract are registered here. Gambling, Employment, Busking and the
 * Movement procedures need their own audited execution contracts. Sneaking is
 * explicitly described as not being a Standard Test and is therefore not
 * registered here.
 */

export const NAMED_STANDARD_TESTS = deepFreeze({
	animosity: characteristicTest(
		"animosity",
		"Animosity",
		"WFRP1ED.StandardTest.Animosity",
		"cl",
	),

	bargain: characteristicTest(
		"bargain",
		"Bargain",
		"WFRP1ED.StandardTest.Bargain",
		"fel",
		["charm", "haggle", "seduction"],
	),

	bluff: characteristicTest(
		"bluff",
		"Bluff",
		"WFRP1ED.StandardTest.Bluff",
		"fel",
		[
			"acting",
			"charm",
			"clown",
			"jester",
			"publicSpeaking",
			"seduction",
			"wit",
		],
	),

	bribe: formulaTest(
		"bribe",
		"Bribe",
		"WFRP1ED.StandardTest.Bribe",
		"100 - target.wp",
		["bribery"],
		["requires-target"],
	),

	construct: characteristicTest(
		"construct",
		"Construct",
		"WFRP1ED.StandardTest.Construct",
		"dex",
		[
			"boatBuilding",
			"carpentry",
			"engineer",
			"mining",
			"smithing",
			"stoneworking",
		],
	),

	disease: formulaTest(
		"disease",
		"Disease",
		"WFRP1ED.StandardTest.Disease",
		"t * 10",
		["immunityToDisease"],
	),

	estimate: characteristicTest(
		"estimate",
		"Estimate",
		"WFRP1ED.StandardTest.Estimate",
		"int",
		["evaluate", "followTrail", "superNumerate"],
	),

	fear: characteristicTest(
		"fear",
		"Fear",
		"WFRP1ED.StandardTest.Fear",
		"cl",
	),

	frenzy: characteristicTest(
		"frenzy",
		"Frenzy",
		"WFRP1ED.StandardTest.Frenzy",
		"cl",
	),

	gossip: characteristicTest(
		"gossip",
		"Gossip",
		"WFRP1ED.StandardTest.Gossip",
		"fel",
		[
			"acting",
			"bribery",
			"charm",
			"comedian",
			"publicSpeaking",
			"seduction",
			"storyTelling",
			"wit",
		],
	),

	hatred: characteristicTest(
		"hatred",
		"Hatred",
		"WFRP1ED.StandardTest.Hatred",
		"cl",
	),

	hide: formulaTest(
		"hide",
		"Hide",
		"WFRP1ED.StandardTest.Hide",
		"i + cl - target.i",
		[
			"concealmentRural",
			"concealmentUrban",
			"shadowing",
		],
		["requires-target"],
	),

	hypnotism: characteristicTest(
		"hypnotism",
		"Hypnotism",
		"WFRP1ED.StandardTest.Hypnotism",
		"wp",
	),

	interrogate: characteristicTest(
		"interrogate",
		"Interrogate",
		"WFRP1ED.StandardTest.Interrogate",
		"wp",
		["torture"],
	),

	listen: formulaTest(
		"listen",
		"Listen",
		"WFRP1ED.StandardTest.Listen",
		"noise",
		["acuteHearing", "silentMoveRural", "silentMoveUrban"],
		["requires-noise-level"],
	),

	loyalty: characteristicTest(
		"loyalty",
		"Loyalty",
		"WFRP1ED.StandardTest.Loyalty",
		"ld",
		["bribery"],
	),

	magic: characteristicTest(
		"magic",
		"Magic",
		"WFRP1ED.StandardTest.Magic",
		"wp",
	),

	observe: characteristicTest(
		"observe",
		"Observe",
		"WFRP1ED.StandardTest.Observe",
		"i",
	),

	pickLock: formulaTest(
		"pickLock",
		"Pick Lock",
		"WFRP1ED.StandardTest.PickLock",
		"dex - lockDifficulty",
		["pickLock"],
		["requires-lock-rating"],
	),

	pickPocket: characteristicTest(
		"pickPocket",
		"Pick Pocket",
		"WFRP1ED.StandardTest.PickPocket",
		"dex",
		["pickPocket"],
	),

	poison: formulaTest(
		"poison",
		"Poison",
		"WFRP1ED.StandardTest.Poison",
		"t * 10",
		["immunityToPoison"],
	),

	problemSolving: characteristicTest(
		"problemSolving",
		"Problem Solving",
		"WFRP1ED.StandardTest.ProblemSolving",
		"int",
	),

	reaction: characteristicTest(
		"reaction",
		"Reaction",
		"WFRP1ED.StandardTest.Reaction",
		"i",
	),

	risk: formulaTest(
		"risk",
		"Risk",
		"WFRP1ED.StandardTest.Risk",
		"50",
		[],
		["situational-skills"],
	),

	search: characteristicTest(
		"search",
		"Search",
		"WFRP1ED.StandardTest.Search",
		"i",
	),

	searchRapid: characteristicTest(
		"searchRapid",
		"Rapid Search",
		"WFRP1ED.StandardTest.SearchRapid",
		"i",
		[],
		["rapid-search"],
		-10,
	),

	strength: formulaTest(
		"strength",
		"Strength",
		"WFRP1ED.StandardTest.Strength",
		"s * 10",
	),

	stupidity: characteristicTest(
		"stupidity",
		"Stupidity",
		"WFRP1ED.StandardTest.Stupidity",
		"int",
	),

	terror: characteristicTest(
		"terror",
		"Terror",
		"WFRP1ED.StandardTest.Terror",
		"cl",
	),

	understandLanguage: characteristicTest(
		"understandLanguage",
		"Understand Language",
		"WFRP1ED.StandardTest.UnderstandLanguage",
		"int",
		["linguistics"],
	),
});

function characteristicTest(
	id,
	label,
	labelKey,
	characteristic,
	skills = [],
	extraTags = [],
	defaultModifier = 0,
) {
	return {
		id,
		label,
		labelKey,
		characteristic,
		skills,
		defaultModifier,
		tags: ["standard", ...extraTags],
	};
}

function formulaTest(
	id,
	label,
	labelKey,
	formula,
	skills = [],
	extraTags = [],
	defaultModifier = 0,
) {
	return {
		id,
		label,
		labelKey,
		formula,
		skills,
		defaultModifier,
		tags: ["standard", ...extraTags],
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
