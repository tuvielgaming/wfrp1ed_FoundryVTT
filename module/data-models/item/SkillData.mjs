const {
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for a WFRP 1e Skill Item.
 *
 * In WFRP 1e, possession of an embedded Skill Item means that the character
 * has acquired that skill. Skills do not share one universal test mechanic:
 * individual skill descriptions determine whether a use is automatic,
 * permits an otherwise unavailable action, modifies a Test, or follows a
 * skill-specific procedure.
 *
 * Some skills require a chosen specialisation. Examples from the core rules
 * include language skills and Specialist Weapon. The model deliberately does
 * not hard-code which skill names require a specialisation because Item names
 * are localized content rather than mechanical identifiers.
 */
export class SkillData extends TypeDataModel {
	/**
	 * Define persistent WFRP 1e Skill data.
	 *
	 * The Item's root `name` owns the skill name.
	 *
	 * `description` stores the rules/content description of the skill.
	 *
	 * `specialisation` identifies the selected subject, language, weapon
	 * category, or other qualification when the particular skill requires one.
	 * It remains blank for skills which do not require a qualification.
	 *
	 * No generic characteristic, target number, or modifier is stored here.
	 * Those concepts are not universal properties of WFRP 1e skills.
	 *
	 * @returns {Object}
	 */
	static defineSchema() {
		return {
			description: textField(),
			specialisation: textField(),
		};
	}

	/**
	 * Normalize early or transitional Skill data into the canonical model.
	 *
	 * Although Skill was not part of the previous native Item contract,
	 * accepting the common American-spelling `specialization` key makes the
	 * migration deterministic if any Skill Documents were created during the
	 * transition between manifest registration and this TypeDataModel.
	 *
	 * Legacy `{ value }` text records are also unwrapped without preserving
	 * their presentation wrapper.
	 *
	 * @param {Object} source
	 * @param {Object} options
	 * @returns {Object}
	 */
	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(
			source ?? {},
		);

		migrated.description = unwrapText(
			migrated.description,
		);

		migrated.specialisation = unwrapText(
			migrated.specialisation ??
				migrated.specialization,
		);

		delete migrated.specialization;

		return super.migrateData(
			migrated,
			options,
		);
	}
}

/**
 * Construct a required, non-null text field.
 *
 * @returns {StringField}
 */
function textField() {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial: "",
		trim: true,
	});
}

/**
 * Read either a native string or a legacy `{ value }` text record.
 *
 * @param {*} value
 * @returns {string}
 */
function unwrapText(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		return normalizeText(
			value.value,
		);
	}

	return normalizeText(value);
}

/**
 * Convert an arbitrary legacy value into canonical text.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeText(value) {
	if (
		value === undefined ||
		value === null
	) {
		return "";
	}

	return String(value).trim();
}