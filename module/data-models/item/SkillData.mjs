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
 * include language skills and Specialist Weapon.
 */
export class SkillData extends TypeDataModel {
	/**
	 * Define persistent WFRP 1e Skill data.
	 *
	 * The Item's root `name` owns the displayed skill name.
	 *
	 * `rulesId` is a stable, language-neutral identifier for an audited core
	 * skill rule. It is deliberately independent of Item.name so localization,
	 * user-visible renaming and specialisations cannot break mechanical lookup.
	 * Custom or not-yet-mapped skills leave it blank.
	 *
	 * `description` stores the rules/content description of the skill.
	 *
	 * `specialisation` identifies the selected subject, language, weapon
	 * category, or other qualification when the particular skill requires one.
	 * It remains blank for skills which do not require a qualification.
	 *
	 * No generic characteristic, target number, or modifier is stored here.
	 * Those concepts are not universal properties of WFRP 1e skills. Audited
	 * mechanics are resolved from `rulesId` by the subsystem which owns the
	 * relevant procedure, such as Standard Tests.
	 *
	 * @returns {Object}
	 */
	static defineSchema() {
		return {
			rulesId: textField(),
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
	 * Existing Skill Items predate the stable rules identity contract. Their
	 * `rulesId` therefore migrates safely to an empty string rather than being
	 * guessed from a localized or user-editable Item name.
	 *
	 * @param {Object} source
	 * @param {Object} options
	 * @returns {Object}
	 */
	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(
			source ?? {},
		);

		migrated.rulesId = normalizeText(
			migrated.rulesId,
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
