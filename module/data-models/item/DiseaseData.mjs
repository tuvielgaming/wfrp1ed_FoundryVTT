const { NumberField, StringField } = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

export class DiseaseData extends TypeDataModel {
	static defineSchema() {
		return {
			rulesId: textField(),
			exposure: textField(),
			diseaseTestModifier: new NumberField({ required: true, nullable: false, initial: 0, integer: true }),
			incubationFormula: textField(),
			durationFormula: textField(),
			symptoms: textField(),
			recovery: textField(),
			description: textField(),
		};
	}

	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(source ?? {});
		for (const key of ["rulesId", "exposure", "incubationFormula", "durationFormula", "symptoms", "recovery", "description"]) migrated[key] = unwrapText(migrated[key]);
		migrated.diseaseTestModifier = finiteInteger(migrated.diseaseTestModifier);
		return super.migrateData(migrated, options);
	}
}

function textField() {
	return new StringField({ required: true, nullable: false, blank: true, initial: "", trim: true });
}

function unwrapText(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) return normalizeText(value.value);
	return normalizeText(value);
}

function normalizeText(value) {
	return value === undefined || value === null ? "" : String(value).trim();
}

function finiteInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}
