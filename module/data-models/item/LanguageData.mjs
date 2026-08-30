const { StringField } = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

/**
 * Native Foundry v14 data model for a WFRP 1e Language Item.
 *
 * The root Item name is the localized/user-visible language name. `rulesId`
 * is the stable language-neutral rules identity used by Race, Character and
 * future NPC/content references. `description` contains setting/rules notes.
 *
 * Language proficiency mechanics are intentionally not invented here. This
 * document establishes identity and reusable content ownership only.
 */
export class LanguageData extends TypeDataModel {
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
