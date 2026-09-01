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
	 * `skillId` is the stable, language-neutral identity of the Skill definition.
	 * It identifies which WFRP 1e Skill the Item represents; it is not an
	 * executable procedure id. Core Skills use ids from CoreSkillCatalog while
	 * custom Skills may leave the field blank.
	 *
	 * `description` stores the rules/content description of the skill.
	 *
	 * `specialisation` identifies the selected subject, language, weapon
	 * category, or other qualification when the particular skill requires one.
	 * It remains blank for skills which do not require a qualification.
	 *
	 * No generic characteristic, target number, or modifier is stored here.
	 * Those concepts are not universal properties of WFRP 1e skills. Audited
	 * mechanics may use `skillId` as a stable lookup key without coupling rules
	 * to localized or user-editable Item names.
	 *
	 * @returns {Object}
	 */
	static defineSchema() {
		return {
			skillId: textField(),
			description: textField(),
			specialisation: textField(),
		};
	}

	/**
	 * Transitional read-only compatibility alias.
	 *
	 * Older system code still reads `system.rulesId`. Keeping that name as a
	 * derived getter lets the persistent model move to `skillId` first, before
	 * the remaining consumers and nested Race/Career references are renamed in
	 * the next audited slice. No `rulesId` field is persisted by SkillData.
	 *
	 * @returns {string}
	 */
	get rulesId() {
		return this.skillId;
	}

	/**
	 * Normalize transitional Skill data into the canonical model.
	 *
	 * Existing development-world Skills which still persist `rulesId` are
	 * migrated deterministically into `skillId`; the legacy field is then
	 * discarded. We never guess identity from localized or user-editable names.
	 *
	 * The common American-spelling `specialization` key is also accepted during
	 * the transition and normalized to `specialisation`.
	 *
	 * @param {Object} source
	 * @param {Object} options
	 * @returns {Object}
	 */
	static migrateData(source, options = {}) {
		const raw = source && typeof source === "object"
			? source
			: {};
		const migrated = foundry.utils.deepClone(raw);

		if (
			Object.hasOwn(raw, "skillId") ||
			Object.hasOwn(raw, "rulesId")
		) {
			migrated.skillId = normalizeText(
				raw.skillId ?? raw.rulesId,
			);
		}

		if (Object.hasOwn(raw, "description")) {
			migrated.description = unwrapText(
				raw.description,
			);
		}

		if (
			Object.hasOwn(raw, "specialisation") ||
			Object.hasOwn(raw, "specialization")
		) {
			migrated.specialisation = unwrapText(
				raw.specialisation ?? raw.specialization,
			);
		}

		delete migrated.rulesId;
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
