const { StringField } = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for reusable WFRP 1e Psychology Items.
 *
 * The root Item name is the localized/user-visible Psychology name. `rulesId`
 * is the stable language-neutral identity used by Race/Character references.
 * `description` owns the rule/lore text. Mechanical automation can be added to
 * this Item later without changing its document identity or Race references.
 */
export class PsychologyData extends TypeDataModel {
	static defineSchema() {
		return {
			rulesId: textField(),
			description: textField(),
		};
	}

	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(source ?? {});
		migrated.rulesId = normalizeText(migrated.rulesId);
		migrated.description = unwrapText(migrated.description);
		return super.migrateData(migrated, options);
	}
}

function textField() {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial: "",
		trim: true,
	});
}

function unwrapText(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return normalizeText(value.value);
	}
	return normalizeText(value);
}

function normalizeText(value) {
	return value === undefined || value === null ? "" : String(value).trim();
}
