import { coreSkillDefinitions } from "../core/CoreSkillCatalog.mjs";

/**
 * @deprecated Compatibility surface for the existing Skill sheet.
 *
 * Stable Skill identity is now owned by CoreSkillCatalog and persisted as
 * `system.skillId`. This export deliberately contains the complete Core Skill
 * catalogue (including the Polish-edition-only entry) so the current sheet can
 * move from the old mechanics-only selector without a second UI rewrite in the
 * same runtime slice.
 *
 * The file/export name is retained only until remaining consumers are migrated
 * from the historical `rulesId` terminology.
 */
export const STANDARD_TEST_SKILL_IDENTITIES = deepFreeze(
	Object.fromEntries(
		coreSkillDefinitions("pl").map((definition) => [
			definition.skillId,
			{
				get label() {
					const polish = String(
						globalThis.game?.i18n?.lang ?? "en",
					).toLocaleLowerCase().startsWith("pl");

					return polish
						? definition.polishName
						: definition.englishName || definition.polishName;
				},
				/* Even the Polish-edition-only record receives a non-empty synthetic
				 * localization key. Missing keys intentionally fall back to `label` in
				 * SkillItemSheet instead of relying on how Foundry localizes an empty
				 * string. */
				labelKey: definition.englishName
					? `WFRP1ED.Skill.${skillKey(definition.englishName)}`
					: `WFRP1ED.Skill.${skillKey(definition.skillId)}`,
			},
		]),
	),
);

/**
 * @deprecated Use CoreSkillCatalog/coreSkillDefinitions instead.
 */
export function getStandardTestSkillIdentity(skillId) {
	const id = String(skillId ?? "").trim();

	return STANDARD_TEST_SKILL_IDENTITIES[id] ?? null;
}

function skillKey(label) {
	return String(label)
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function deepFreeze(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.isFrozen(value)
	) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return Object.freeze(value);
}
