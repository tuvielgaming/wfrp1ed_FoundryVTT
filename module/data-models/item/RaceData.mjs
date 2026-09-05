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

/* Legacy authoring constant retained temporarily because the Race sheet module
 * still imports it for unreachable pre-refactor editor actions. Career Class
 * eligibility itself is no longer Race data and is owned exclusively by
 * CareerClassEligibility. */
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
 *
 * Career Class eligibility deliberately does NOT live here. Core Class
 * requirements, including the Wood Elf Rogue exception, are system-level
 * character-creation rules owned by CareerClassEligibility.
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
		};
	}

	/**
	 * Transitional nested-reference migration.
	 *
	 * Race Skill references historically persisted their Skill identity as the
	 * generic `rulesId`. During this audited migration slice we backfill the
	 * explicit `skillId` at the data-model boundary while retaining `rulesId` so
	 * existing Race generation/authoring consumers continue to behave exactly as
	 * before. Once those consumers are migrated, the legacy nested field can be
	 * removed without needing name-based identity inference.
	 *
	 * Only Skill references are touched here. The Race's own `rulesId`, Language,
	 * Psychology, and Career references remain unchanged because they belong to
	 * separate domain-identity migrations.
	 */
	static migrateData(source, options = {}) {
		const raw = source && typeof source === "object"
			? source
			: {};
		const migrated = foundry.utils.deepClone(raw);

		if (Object.hasOwn(raw, "mandatorySkills")) {
			migrated.mandatorySkills = migrateMandatorySkillReferences(
				raw.mandatorySkills,
			);
		}

		if (Object.hasOwn(raw, "skillTables")) {
			migrated.skillTables = migrateSkillTableReferences(raw.skillTables);
		}

		return super.migrateData(migrated, options);
	}
}

function languageField() {
	return new SchemaField({
		uuid: textField(),
		rulesId: textField(),
		name: textField(),
	});
}

function psychologyField() {
	return new SchemaField({
		uuid: textField(),
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
		skillId: textField(),
		/* Transitional persisted field. Race Skill consumers are being migrated
		 * to skillId before legacy rulesId is removed from nested references. */
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

function percentileTablesField(rowFactory) {
	return new SchemaField(Object.fromEntries(
		RACE_CAREER_CLASSES.map((careerClass) => [
			careerClass,
			new ArrayField(rowFactory(), arrayOptions()),
		]),
	));
}

function migrateMandatorySkillReferences(value) {
	if (!Array.isArray(value)) return value;
	return value.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		const migrated = foundry.utils.deepClone(entry);
		if (!Array.isArray(entry.choices)) return migrated;
		migrated.choices = entry.choices.map((choice) => {
			if (!choice || typeof choice !== "object") return choice;
			const nextChoice = foundry.utils.deepClone(choice);
			if (Array.isArray(choice.grants)) {
				nextChoice.grants = choice.grants.map(migrateSkillReference);
			}
			return nextChoice;
		});
		return migrated;
	});
}

function migrateSkillTableReferences(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const migrated = foundry.utils.deepClone(value);
	for (const careerClass of RACE_CAREER_CLASSES) {
		const rows = value[careerClass];
		if (!Array.isArray(rows)) continue;
		migrated[careerClass] = rows.map((row) => {
			if (!row || typeof row !== "object") return row;
			const nextRow = foundry.utils.deepClone(row);
			if (row.grant && typeof row.grant === "object") {
				nextRow.grant = migrateSkillReference(row.grant);
			}
			return nextRow;
		});
	}
	return migrated;
}

function migrateSkillReference(reference) {
	if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
		return reference;
	}
	const migrated = foundry.utils.deepClone(reference);
	const skillId = normalizeText(reference.skillId ?? reference.rulesId);
	if (skillId) migrated.skillId = skillId;
	return migrated;
}

function normalizeText(value) {
	return String(value ?? "").trim();
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
