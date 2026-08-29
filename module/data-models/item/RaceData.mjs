const {
	ArrayField,
	BooleanField,
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

export const RACE_CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);

export const RACE_CAREER_CLASSES = Object.freeze([
	"warrior",
	"ranger",
	"rogue",
	"academic",
]);

/**
 * Keep the same package-mode vocabulary as CareerData. Race mandatory Skills
 * use the same entry -> choices -> grants semantics, with the Race-specific
 * minInitialSkills condition instead of Career acquisition chance.
 */
export const RACE_INITIAL_SKILL_MODE = Object.freeze({
	ALL: "all",
	PLAYER_CHOICE: "player-choice",
	RANDOM_CHOICE: "random-choice",
});

export const RACE_CAREER_OVERRIDE_MODE = Object.freeze({
	REPLACE_REQUIREMENTS: "replace-requirements",
	FORBID: "forbid",
});

/**
 * Native Foundry v14 data model for a WFRP 1e Race Item.
 *
 * A Race Item is a rules definition, not a collection of permanent modifiers.
 * Character creation rolls the formulas and tables declared here and writes the
 * generated results to the Character. The embedded Race Item then remains the
 * character's stable racial identity for later rule lookups.
 *
 * The model deliberately contains the race-specific D100 distributions rather
 * than UUIDs of eight external RollTables. One Race Item is therefore sufficient
 * to define one playable custom race.
 */
export class RaceData extends TypeDataModel {
	static defineSchema() {
		return {
			rulesId: textField(),
			description: textField(),

			profile: new SchemaField(Object.fromEntries(
				RACE_CHARACTERISTIC_IDS.map((id) => [id, textField()]),
			)),

			languages: new ArrayField(languageField(), arrayOptions()),

			vision: new SchemaField({
				nightVisionRange: integerField(0, 0),
				unit: textField("yd"),
			}),

			startingAlignment: textField("neutral"),

			psychology: new ArrayField(psychologyField(), arrayOptions()),

			height: new SchemaField({
				maleFormula: textField(),
				femaleFormula: textField(),
				unit: textField("in"),
			}),

			age: new SchemaField({
				youngFormula: textField(),
				matureFormula: textField(),
				minimum: integerField(16, 0),
				rerollBelowMinimum: booleanField(true),
				skillCountModifiers: new ArrayField(
					ageSkillModifierField(),
					arrayOptions(),
				),
			}),

			fate: new SchemaField({
				formula: textField(),
				minimum: integerField(0, 0),
			}),

			mandatorySkills: new ArrayField(
				mandatorySkillRuleField(),
				arrayOptions(),
			),

			skillTables: percentileTablesField(skillTableRowField),
			basicCareerTables: percentileTablesField(careerTableRowField),

			careerClassOverrides: new ArrayField(
				careerClassOverrideField(),
				arrayOptions(),
			),
		};
	}
}

function languageField() {
	return new SchemaField({
		rulesId: textField(),
		name: textField(),
	});
}

function psychologyField() {
	return new SchemaField({
		rulesId: textField(),
		name: textField(),
		description: textField(),
	});
}

function ageSkillModifierField() {
	return new SchemaField({
		minAge: integerField(16, 0),
		maxAge: integerField(16, 0),
		modifier: integerField(0),
	});
}

function mandatorySkillRuleField() {
	return new SchemaField({
		id: textField(),
		minInitialSkills: integerField(1, 1),
		mode: textField(RACE_INITIAL_SKILL_MODE.ALL),
		choose: integerField(1, 1),
		choices: new ArrayField(skillChoiceField(), arrayOptions()),
	});
}

function skillChoiceField() {
	return new SchemaField({
		id: textField(),
		label: textField(),
		grants: new ArrayField(skillReferenceField(), arrayOptions()),
	});
}

function skillTableRowField() {
	return new SchemaField({
		min: percentileField(1),
		max: percentileField(1),
		grant: skillReferenceField(),
	});
}

function careerTableRowField() {
	return new SchemaField({
		min: percentileField(1),
		max: percentileField(1),
		career: documentReferenceField(),
	});
}

function skillReferenceField() {
	return new SchemaField({
		uuid: textField(),
		rulesId: textField(),
		name: textField(),
		specialisation: textField(),
	});
}

function documentReferenceField() {
	return new SchemaField({
		uuid: textField(),
		rulesId: textField(),
		name: textField(),
	});
}

function careerClassOverrideField() {
	return new SchemaField({
		class: textField(),
		mode: textField(RACE_CAREER_OVERRIDE_MODE.REPLACE_REQUIREMENTS),
		requirements: new ArrayField(
			careerClassRequirementField(),
			arrayOptions(),
		),
	});
}

function careerClassRequirementField() {
	return new SchemaField({
		characteristic: textField(),
		operator: textField("gte"),
		value: integerField(0),
	});
}

function percentileTablesField(rowFactory) {
	return new SchemaField(Object.fromEntries(
		RACE_CAREER_CLASSES.map((careerClass) => [
			careerClass,
			new ArrayField(rowFactory(), arrayOptions()),
		]),
	));
}

function arrayOptions() {
	return {
		required: true,
		nullable: false,
		initial: [],
	};
}

function textField(initial = "") {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial,
		trim: true,
	});
}

function booleanField(initial) {
	return new BooleanField({
		required: true,
		nullable: false,
		initial,
	});
}

function integerField(initial = 0, min = null) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		...(min === null ? {} : { min }),
	});
}

function percentileField(initial) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		min: 1,
		max: 100,
		initial,
	});
}
