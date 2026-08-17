const {
	ArrayField,
	BooleanField,
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

export const CAREER_CLASS = Object.freeze({
	WARRIOR: "warrior",
	RANGER: "ranger",
	ROGUE: "rogue",
	ACADEMIC: "academic",
});

export const CAREER_TIER = Object.freeze({
	BASIC: "basic",
	ADVANCED: "advanced",
});

/** How alternatives inside one Career entry are resolved. */
export const CAREER_ENTRY_MODE = Object.freeze({
	ALL: "all",
	PLAYER_CHOICE: "player-choice",
	RANDOM_CHOICE: "random-choice",
});

export const CAREER_DOCUMENT_TYPE = Object.freeze({
	ITEM: "Item",
	ACTOR: "Actor",
});

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);

/**
 * Native Foundry v14 data model for a WFRP 1e Career Item.
 *
 * The model follows the Career descriptions in the Core Rulebook rather than
 * later-edition career concepts. A Career definition owns:
 * - Career Class and Basic/Advanced classification;
 * - the Advance Scheme ceiling;
 * - additional Skills, including percentage-gated and alternative entries;
 * - additional Trappings, using the same chance/alternative representation;
 * - race-dependent Magic Point formulae where present;
 * - Career Exits and any authored transition restriction;
 * - narrative description.
 *
 * `current` and `complete` remain top-level instance state for compatibility
 * with the existing initial-Career integration. World/Compendium Career
 * definitions should leave both false; embedded Career copies may set them.
 */
export class CareerData extends TypeDataModel {
	static defineSchema() {
		return {
			rulesId: textField(),
			class: textField(CAREER_CLASS.WARRIOR),
			tier: textField(CAREER_TIER.BASIC),
			description: textField(),

			advanceScheme: new SchemaField(
				Object.fromEntries(
					CHARACTERISTIC_IDS.map((id) => [id, nonNegativeIntegerField()]),
				),
			),

			skills: careerEntryArrayField(),
			trappings: careerEntryArrayField(),
			magicPoints: new ArrayField(
				magicPointEntryField(),
				arrayOptions(),
			),
			exits: new ArrayField(
				careerExitField(),
				arrayOptions(),
			),

			current: booleanField(false),
			complete: booleanField(false),
		};
	}

	/**
	 * Migrate the former prototype/later-edition Career structure without
	 * inventing WFRP 1e facts. Legacy text wrappers are unwrapped and recognizable
	 * arrays are preserved as simple single-option entries. Unknown status/level
	 * data is deliberately discarded instead of being reinterpreted as Core rules.
	 */
	static migrateData(source, options = {}) {
		const original = source && typeof source === "object" ? source : {};
		const migrated = foundry.utils.deepClone(original);

		if (Object.hasOwn(original, "rulesId")) {
			migrated.rulesId = unwrapText(original.rulesId);
		}
		if (Object.hasOwn(original, "class")) {
			migrated.class = normalizeCareerClass(unwrapText(original.class));
		}
		if (Object.hasOwn(original, "tier")) {
			migrated.tier = normalizeAllowed(
				unwrapText(original.tier),
				Object.values(CAREER_TIER),
				CAREER_TIER.BASIC,
			);
		}
		if (Object.hasOwn(original, "description")) {
			migrated.description = unwrapText(original.description);
		}
		if (Object.hasOwn(original, "current")) {
			migrated.current = unwrapBoolean(original.current);
		}
		if (Object.hasOwn(original, "complete")) {
			migrated.complete = unwrapBoolean(original.complete);
		}

		if (Object.hasOwn(original, "advanceScheme")) {
			migrated.advanceScheme = normalizeAdvanceScheme(original.advanceScheme);
		} else if (Object.hasOwn(original, "characteristics")) {
			migrated.advanceScheme = migrateLegacyCharacteristics(original.characteristics);
		}

		if (Object.hasOwn(original, "skills")) {
			migrated.skills = normalizeCareerEntries(original.skills, "skill");
		}
		if (Object.hasOwn(original, "trappings")) {
			migrated.trappings = normalizeCareerEntries(original.trappings, "trapping");
		}
		if (Object.hasOwn(original, "magicPoints")) {
			migrated.magicPoints = normalizeMagicPointEntries(original.magicPoints);
		}
		if (Object.hasOwn(original, "exits")) {
			migrated.exits = normalizeCareerExits(original.exits);
		}

		/* Prototype/later-edition keys are not part of WFRP 1e Career data. */
		delete migrated.careergroup;
		delete migrated.level;
		delete migrated.status;
		delete migrated.talents;
		delete migrated.incomeSkill;
		delete migrated.earning;
		delete migrated.characteristics;

		return super.migrateData(migrated, options);
	}
}

function careerEntryArrayField() {
	return new ArrayField(careerEntryField(), arrayOptions());
}

function careerEntryField() {
	return new SchemaField({
		id: textField(),
		chance: percentageField(100),
		mode: textField(CAREER_ENTRY_MODE.ALL),
		choose: positiveIntegerField(1),
		note: textField(),
		choices: new ArrayField(careerChoiceField(), arrayOptions()),
	});
}

function careerChoiceField() {
	return new SchemaField({
		id: textField(),
		label: textField(),
		grants: new ArrayField(careerGrantField(), arrayOptions()),
	});
}

function careerGrantField() {
	return new SchemaField({
		uuid: textField(),
		rulesId: textField(),
		name: textField(),
		documentType: textField(CAREER_DOCUMENT_TYPE.ITEM),
		documentSubtype: textField(),
		quantity: positiveIntegerField(1),
	});
}

function magicPointEntryField() {
	return new SchemaField({
		races: new ArrayField(textField(), arrayOptions()),
		formula: textField(),
		note: textField(),
	});
}

function careerExitField() {
	return new SchemaField({
		uuid: textField(),
		rulesId: textField(),
		name: textField(),
		condition: textField(),
		requiresComplete: booleanField(false),
		excludedRaces: new ArrayField(textField(), arrayOptions()),
	});
}

function arrayOptions() {
	return {
		required: true,
		nullable: false,
		initial: [],
	};
}

function textField(initial = "") {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial,
		trim: true,
	});
}

function booleanField(initial = false) {
	return new BooleanField({
		required: true,
		nullable: false,
		initial,
	});
}

function nonNegativeIntegerField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		min: 0,
		initial,
	});
}

function positiveIntegerField(initial = 1) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		min: 1,
		initial,
	});
}

function percentageField(initial = 100) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		min: 0,
		max: 100,
		initial,
	});
}

function normalizeAdvanceScheme(source) {
	const raw = source && typeof source === "object" ? source : {};
	return Object.fromEntries(
		CHARACTERISTIC_IDS.map((id) => [id, toNonNegativeInteger(unwrapValue(raw[id]))]),
	);
}

function migrateLegacyCharacteristics(source) {
	const result = Object.fromEntries(CHARACTERISTIC_IDS.map((id) => [id, 0]));
	if (!Array.isArray(source)) return result;

	for (const entry of source) {
		if (!entry || typeof entry !== "object") continue;
		const id = canonicalCharacteristicId(
			entry.id ?? entry.characteristicId ?? entry.key ?? entry.name,
		);
		if (!id) continue;
		result[id] = toNonNegativeInteger(
			unwrapValue(entry.steps ?? entry.value ?? entry.advance ?? entry.amount),
		);
	}
	return result;
}

function normalizeCareerEntries(source, kind) {
	if (!Array.isArray(source)) return [];
	return source
		.map((entry, index) => normalizeCareerEntry(entry, kind, index))
		.filter(Boolean);
}

function normalizeCareerEntry(source, kind, index) {
	if (source === undefined || source === null) return null;

	if (typeof source === "string") {
		const name = source.trim();
		if (!name) return null;
		return simpleCareerEntry(name, kind, index);
	}
	if (typeof source !== "object" || Array.isArray(source)) return null;

	if (Array.isArray(source.choices)) {
		return {
			id: normalizeText(source.id) || generatedEntryId(kind, index),
			chance: toPercentage(source.chance, 100),
			mode: normalizeAllowed(
				source.mode,
				Object.values(CAREER_ENTRY_MODE),
				CAREER_ENTRY_MODE.ALL,
			),
			choose: Math.max(1, toNonNegativeInteger(source.choose) || 1),
			note: normalizeText(source.note),
			choices: source.choices
				.map((choice, choiceIndex) => normalizeChoice(choice, kind, choiceIndex))
				.filter(Boolean),
		};
	}

	const name = unwrapText(source.name ?? source.label ?? source.value);
	const uuid = normalizeText(source.uuid);
	const rulesId = normalizeText(source.rulesId);
	if (!name && !uuid && !rulesId) return null;
	return simpleCareerEntry(name, kind, index, { uuid, rulesId, source });
}

function simpleCareerEntry(name, kind, index, { uuid = "", rulesId = "", source = {} } = {}) {
	const documentSubtype = kind === "skill"
		? "skill"
		: normalizeText(source.type ?? source.documentSubtype);
	return {
		id: normalizeText(source.id) || generatedEntryId(kind, index),
		chance: toPercentage(source.chance, 100),
		mode: CAREER_ENTRY_MODE.ALL,
		choose: 1,
		note: normalizeText(source.note),
		choices: [{
			id: `${generatedEntryId(kind, index)}-choice-1`,
			label: name,
			grants: [{
				uuid,
				rulesId,
				name,
				documentType: CAREER_DOCUMENT_TYPE.ITEM,
				documentSubtype,
				quantity: Math.max(1, toNonNegativeInteger(source.quantity) || 1),
			}],
		}],
	};
}

function normalizeChoice(source, kind, index) {
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	const grants = Array.isArray(source.grants)
		? source.grants.map((grant) => normalizeGrant(grant, kind)).filter(Boolean)
		: [];
	if (!grants.length) return null;
	return {
		id: normalizeText(source.id) || `choice-${index + 1}`,
		label: normalizeText(source.label) || grants.map((grant) => grant.name).filter(Boolean).join(" + "),
		grants,
	};
}

function normalizeGrant(source, kind) {
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	const name = normalizeText(source.name);
	const uuid = normalizeText(source.uuid);
	const rulesId = normalizeText(source.rulesId);
	if (!name && !uuid && !rulesId) return null;
	return {
		uuid,
		rulesId,
		name,
		documentType: normalizeAllowed(
			source.documentType,
			Object.values(CAREER_DOCUMENT_TYPE),
			CAREER_DOCUMENT_TYPE.ITEM,
		),
		documentSubtype: normalizeText(source.documentSubtype) || (kind === "skill" ? "skill" : ""),
		quantity: Math.max(1, toNonNegativeInteger(source.quantity) || 1),
	};
}

function normalizeMagicPointEntries(source) {
	if (!Array.isArray(source)) return [];
	return source
		.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
			const formula = normalizeText(entry.formula ?? entry.value);
			if (!formula) return null;
			return {
				races: Array.isArray(entry.races)
					? entry.races.map(normalizeText).filter(Boolean)
					: [],
				formula,
				note: normalizeText(entry.note),
			};
		})
		.filter(Boolean);
}

function normalizeCareerExits(source) {
	if (!Array.isArray(source)) return [];
	return source
		.map((entry) => {
			if (typeof entry === "string") {
				const name = entry.trim();
				return name ? {
					uuid: "",
					rulesId: "",
					name,
					condition: "",
					requiresComplete: false,
					excludedRaces: [],
				} : null;
			}
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
			const name = normalizeText(entry.name);
			const uuid = normalizeText(entry.uuid);
			const rulesId = normalizeText(entry.rulesId);
			if (!name && !uuid && !rulesId) return null;
			return {
				uuid,
				rulesId,
				name,
				condition: normalizeText(entry.condition),
				requiresComplete: unwrapBoolean(entry.requiresComplete),
				excludedRaces: Array.isArray(entry.excludedRaces)
					? entry.excludedRaces.map(normalizeText).filter(Boolean)
					: [],
			};
		})
		.filter(Boolean);
}

function normalizeCareerClass(value) {
	const normalized = normalizeText(value).toLowerCase();
	const aliases = {
		warrior: CAREER_CLASS.WARRIOR,
		wojownik: CAREER_CLASS.WARRIOR,
		ranger: CAREER_CLASS.RANGER,
		"ranger class": CAREER_CLASS.RANGER,
		"wędrowiec": CAREER_CLASS.RANGER,
		wedrowiec: CAREER_CLASS.RANGER,
		rogue: CAREER_CLASS.ROGUE,
		łotrzyk: CAREER_CLASS.ROGUE,
		lotrzyk: CAREER_CLASS.ROGUE,
		academic: CAREER_CLASS.ACADEMIC,
		uczony: CAREER_CLASS.ACADEMIC,
	};
	return aliases[normalized] ?? CAREER_CLASS.WARRIOR;
}

function canonicalCharacteristicId(value) {
	const normalized = normalizeText(value).toLowerCase();
	if (normalized === "sp" || normalized === "sz") return "m";
	return CHARACTERISTIC_IDS.includes(normalized) ? normalized : "";
}

function generatedEntryId(kind, index) {
	return `${kind}-${index + 1}`;
}

function normalizeAllowed(value, allowed, fallback) {
	const normalized = normalizeText(value);
	return allowed.includes(normalized) ? normalized : fallback;
}

function unwrapText(value) {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
		return normalizeText(value.value);
	}
	return normalizeText(value);
}

function unwrapBoolean(value) {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
		return value.value === true;
	}
	return value === true;
}

function unwrapValue(value) {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
		return value.value;
	}
	return value;
}

function normalizeText(value) {
	return value === undefined || value === null ? "" : String(value).trim();
}

function toNonNegativeInteger(value) {
	const numeric = Number(unwrapValue(value));
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function toPercentage(value, fallback = 100) {
	const numeric = Number(unwrapValue(value));
	if (!Number.isFinite(numeric)) return fallback;
	return Math.max(0, Math.min(100, Math.trunc(numeric)));
}
