const { StringField } = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for reusable WFRP 1e Disease Items.
 *
 * This first structural contract deliberately stores only stable identity and
 * authored rules text. Disease-specific automation fields are added only after
 * their Core Rulebook lifecycle is audited.
 */
export class DiseaseData extends TypeDataModel {
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
