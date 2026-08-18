import { CareerData } from "../data-models/item/CareerData.mjs";

const { TypeDataModel } = foundry.abstract;

/*
 * Foundry v14 cleans differential updates with DataModelCleaningOptions.partial.
 * CareerData.migrateData() is intentionally broad for loading/creation because
 * it also migrates legacy Career structures. That broad migration must not run
 * against a partial update: omitted fields would otherwise be normalized to
 * schema defaults (empty arrays, zeroed Advance Scheme, empty text), erasing
 * untouched Career data.
 *
 * For partial updates, the current UI already sends canonical v14 Career field
 * shapes, so delegate directly to TypeDataModel's base migration and let
 * Foundry clean only the keys present in the differential. Full records keep
 * using CareerData's legacy-aware migration unchanged.
 */
const originalMigrateData = CareerData.migrateData;

CareerData.migrateData = function partialAwareCareerMigration(source, options = {}) {
	if (options?.partial === true) {
		return TypeDataModel.migrateData.call(this, source, options);
	}
	return originalMigrateData.call(this, source, options);
};
