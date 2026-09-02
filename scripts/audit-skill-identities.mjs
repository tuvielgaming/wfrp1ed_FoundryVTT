import {
	coreSkillDefinitions,
	coreSkillItemSources,
	IMPLEMENTED_CORE_SKILL_IDS,
} from "../module/core/CoreSkillCatalog.mjs";
import {
	STANDARD_TEST_SKILL_IDENTITIES,
} from "../module/tests/standard-test-skill-identities.mjs";
import {
	STANDARD_TEST_SKILL_RULES,
} from "../module/tests/standard-test-skill-rules.mjs";

const EXPECTED_COUNTS = Object.freeze({
	en: 133,
	pl: 134,
});

const definitions = Object.freeze({
	en: coreSkillDefinitions("en"),
	pl: coreSkillDefinitions("pl"),
});

const sources = Object.freeze({
	en: coreSkillItemSources("en"),
	pl: coreSkillItemSources("pl"),
});

for (const language of Object.keys(EXPECTED_COUNTS)) {
	auditDefinitions(language, definitions[language]);
	auditSources(language, definitions[language], sources[language]);
}

auditCrossLanguageIdentity(definitions.en, definitions.pl);
auditMechanicalIdentityReferences(definitions.pl);

console.log(
	"WFRP1ED | Skill identity audit passed:",
	`${definitions.en.length} EN Core Skills,`,
	`${definitions.pl.length} PL Core Skills,`,
	`${IMPLEMENTED_CORE_SKILL_IDS.size} mechanics-linked Skill ids,`,
	`${Object.keys(STANDARD_TEST_SKILL_IDENTITIES).length} audited Skill identities,`,
	`${Object.keys(STANDARD_TEST_SKILL_RULES).length} Standard Test Skill rules.`,
);

function auditDefinitions(language, records) {
	const expectedCount = EXPECTED_COUNTS[language];
	if (records.length !== expectedCount) {
		throw new Error(
			`Core Skill catalogue '${language}' contains ${records.length} records; expected ${expectedCount}.`,
		);
	}

	const skillIds = new Set();
	for (const record of records) {
		const skillId = requiredText(
			record.skillId,
			`Core Skill '${record.name || record.catalogId || "unknown"}' has no skillId.`,
		);

		if (skillIds.has(skillId)) {
			throw new Error(
				`Core Skill catalogue '${language}' contains duplicate skillId '${skillId}'.`,
			);
		}
		skillIds.add(skillId);
	}
}

function auditSources(language, records, itemSources) {
	if (itemSources.length !== records.length) {
		throw new Error(
			`Core Skill Item source '${language}' contains ${itemSources.length} documents for ${records.length} definitions.`,
		);
	}

	const expectedIds = new Set(records.map((record) => record.skillId));
	const emittedIds = new Set();

	for (const source of itemSources) {
		if (source.type !== "skill") {
			throw new Error(
				`Core Skill source '${source.name}' has unexpected Item type '${source.type}'.`,
			);
		}

		const skillId = requiredText(
			source.system?.skillId,
			`Core Skill source '${source.name}' has no system.skillId.`,
		);

		if (Object.hasOwn(source.system ?? {}, "rulesId")) {
			throw new Error(
				`Core Skill source '${source.name}' still persists legacy system.rulesId.`,
			);
		}

		if (!expectedIds.has(skillId)) {
			throw new Error(
				`Core Skill source '${source.name}' emits unknown skillId '${skillId}'.`,
			);
		}

		if (emittedIds.has(skillId)) {
			throw new Error(
				`Core Skill source '${language}' emits duplicate skillId '${skillId}'.`,
			);
		}
		emittedIds.add(skillId);

		const catalogSkillId = requiredText(
			source.flags?.wfrp1ed?.coreCatalog?.skillId,
			`Core Skill source '${source.name}' has no flags.wfrp1ed.coreCatalog.skillId.`,
		);
		if (catalogSkillId !== skillId) {
			throw new Error(
				`Core Skill source '${source.name}' disagrees between system.skillId '${skillId}' and catalogue skillId '${catalogSkillId}'.`,
			);
		}

		const mechanicsLinked =
			source.flags?.wfrp1ed?.coreCatalog?.mechanicsLinked === true;
		const expectedMechanicsLinked = IMPLEMENTED_CORE_SKILL_IDS.has(skillId);
		if (mechanicsLinked !== expectedMechanicsLinked) {
			throw new Error(
				`Core Skill source '${source.name}' has incorrect mechanicsLinked state for '${skillId}'.`,
			);
		}
	}
}

function auditCrossLanguageIdentity(englishRecords, polishRecords) {
	const polishIds = new Set(polishRecords.map((record) => record.skillId));
	for (const record of englishRecords) {
		if (!polishIds.has(record.skillId)) {
			throw new Error(
				`Polish Core Skill catalogue is missing English skillId '${record.skillId}'.`,
			);
		}
	}

	const extraPolishIds = polishRecords
		.map((record) => record.skillId)
		.filter((skillId) => !englishRecords.some((record) => record.skillId === skillId));

	if (
		extraPolishIds.length !== 1 ||
		extraPolishIds[0] !== "polishSenseMagicAlarm"
	) {
		throw new Error(
			`Unexpected Polish-only Core Skill identities: ${extraPolishIds.join(", ") || "none"}.`,
		);
	}
}

function auditMechanicalIdentityReferences(coreRecords) {
	const coreIds = new Set(coreRecords.map((record) => record.skillId));
	const auditedIds = new Set(Object.keys(STANDARD_TEST_SKILL_IDENTITIES));

	for (const skillId of IMPLEMENTED_CORE_SKILL_IDS) {
		if (!coreIds.has(skillId)) {
			throw new Error(
				`Mechanics-linked Skill id '${skillId}' does not exist in the Core Skill catalogue.`,
			);
		}
		if (!auditedIds.has(skillId)) {
			throw new Error(
				`Mechanics-linked Skill id '${skillId}' is missing from the audited Skill identity registry.`,
			);
		}
	}

	for (const skillId of Object.keys(STANDARD_TEST_SKILL_RULES)) {
		if (!coreIds.has(skillId)) {
			throw new Error(
				`Standard Test Skill rule '${skillId}' does not exist in the Core Skill catalogue.`,
			);
		}
		if (!auditedIds.has(skillId)) {
			throw new Error(
				`Standard Test Skill rule '${skillId}' is missing from the audited Skill identity registry.`,
			);
		}
	}

	for (const sentinel of ["acrobatics", "pickLock", "specialistWeapon"]) {
		if (!IMPLEMENTED_CORE_SKILL_IDS.has(sentinel)) {
			throw new Error(
				`Regression sentinel '${sentinel}' is no longer marked as mechanics-linked.`,
			);
		}
	}
}

function requiredText(value, message) {
	const text = String(value ?? "").trim();
	if (!text) {
		throw new Error(message);
	}
	return text;
}
