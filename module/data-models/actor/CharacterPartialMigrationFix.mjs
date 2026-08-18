import { CharacterData } from "./CharacterData.mjs";

const { TypeDataModel } = foundry.abstract;

/* CharacterData's legacy migration deliberately reconstructs a complete Actor
 * system record when loading/creating old data. Foundry v14 also invokes
 * migrateData while cleaning differential updates. In that partial mode,
 * reconstructing omitted details/status/experience fields would replace valid
 * sibling data with defaults. Delegate partial updates to the base TypeDataModel
 * migration and retain the legacy-aware migration only for complete records. */
const originalMigrateData = CharacterData.migrateData;

CharacterData.migrateData = function partialAwareCharacterMigration(source, options = {}) {
	if (options?.partial === true) {
		return TypeDataModel.migrateData.call(this, source, options);
	}
	return originalMigrateData.call(this, source, options);
};
