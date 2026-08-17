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

/** Native WFRP 1e Career definition plus embedded-instance state. */
export class CareerData extends TypeDataModel {
	static defineSchema() {
		return {
			rulesId: textField(),
			class: textField(CAREER_CLASS.WARRIOR),
			tier: textField(CAREER_TIER.BASIC),
			description: textField(),
			advanceScheme: new SchemaField(Object.fromEntries(
				CHARACTERISTIC_IDS.map((id) => [id, integerField(0)]),
			)),
			skills: new ArrayField(entryField(), arrayOptions()),
			trappings: new ArrayField(entryField(), arrayOptions()),
			magicPoints: new ArrayField(magicPointsField(), arrayOptions()),
			exits: new ArrayField(exitField(), arrayOptions()),
			current: booleanField(false),
			complete: booleanField(false),
		};
	}

	/**
	 * Preserve recognizable legacy Career content while discarding prototype
	 * later-edition concepts rather than inventing WFRP 1e meanings for them.
	 */
	static migrateData(source, options = {}) {
		const raw = source && typeof source === "object" ? source : {};
		const migrated = foundry.utils.deepClone(raw);
		migrated.rulesId = unwrapText(raw.rulesId);
		migrated.class = normalizeClass(unwrapText(raw.class));
		migrated.tier = allowed(unwrapText(raw.tier), Object.values(CAREER_TIER), CAREER_TIER.BASIC);
		migrated.description = unwrapText(raw.description);
		migrated.current = unwrapBoolean(raw.current);
		migrated.complete = unwrapBoolean(raw.complete);
		migrated.advanceScheme = raw.advanceScheme
			? normalizeScheme(raw.advanceScheme)
			: migrateLegacyCharacteristics(raw.characteristics);
		migrated.skills = normalizeEntries(raw.skills, "skill");
		migrated.trappings = normalizeEntries(raw.trappings, "trapping");
		migrated.magicPoints = normalizeMagicPoints(raw.magicPoints);
		migrated.exits = normalizeExits(raw.exits);

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

function entryField() {
	return new SchemaField({
		id: textField(),
		chance: percentageField(100),
		mode: textField(CAREER_ENTRY_MODE.ALL),
		choose: integerField(1, 1),
		note: textField(),
		choices: new ArrayField(choiceField(), arrayOptions()),
	});
}

function choiceField() {
	return new SchemaField({
		id: textField(),
		label: textField(),
		grants: new ArrayField(grantField(), arrayOptions()),
	});
}

function grantField() {
	return new SchemaField({
		uuid: textField(),
		rulesId: textField(),
		name: textField(),
		specialisation: textField(),
		documentType: textField(CAREER_DOCUMENT_TYPE.ITEM),
		documentSubtype: textField(),
		quantity: integerField(1, 1),
	});
}

function magicPointsField() {
	return new SchemaField({
		races: new ArrayField(textField(), arrayOptions()),
		formula: textField(),
		note: textField(),
	});
}

function exitField() {
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
	return { required: true, nullable: false, initial: [] };
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

function booleanField(initial) {
	return new BooleanField({ required: true, nullable: false, initial });
}

function integerField(initial = 0, min = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		min,
		initial,
	});
}

function percentageField(initial) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		min: 0,
		max: 100,
		initial,
	});
}

function normalizeScheme(source) {
	const raw = source && typeof source === "object" ? source : {};
	return Object.fromEntries(CHARACTERISTIC_IDS.map((id) => [
		id,
		nonNegativeInteger(unwrapValue(raw[id])),
	]));
}

function migrateLegacyCharacteristics(source) {
	const scheme = Object.fromEntries(CHARACTERISTIC_IDS.map((id) => [id, 0]));
	if (!Array.isArray(source)) return scheme;
	for (const entry of source) {
		if (!entry || typeof entry !== "object") continue;
		const id = canonicalCharacteristic(entry.id ?? entry.characteristicId ?? entry.key ?? entry.name);
		if (!id) continue;
		scheme[id] = nonNegativeInteger(unwrapValue(
			entry.steps ?? entry.value ?? entry.advance ?? entry.amount,
		));
	}
	return scheme;
}

function normalizeEntries(source, kind) {
	if (!Array.isArray(source)) return [];
	return source.map((entry, index) => normalizeEntry(entry, kind, index)).filter(Boolean);
}

function normalizeEntry(source, kind, index) {
	if (typeof source === "string") {
		return simpleEntry({ name: source }, kind, index);
	}
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	if (!Array.isArray(source.choices)) return simpleEntry(source, kind, index);
	return {
		id: text(source.id) || `${kind}-${index + 1}`,
		chance: percentage(source.chance, 100),
		mode: allowed(text(source.mode), Object.values(CAREER_ENTRY_MODE), CAREER_ENTRY_MODE.ALL),
		choose: Math.max(1, nonNegativeInteger(source.choose) || 1),
		note: text(source.note),
		choices: source.choices.map((choice, choiceIndex) => normalizeChoice(choice, kind, choiceIndex)).filter(Boolean),
	};
}

function simpleEntry(source, kind, index) {
	const name = unwrapText(source?.name ?? source?.label ?? source?.value);
	const uuid = text(source?.uuid);
	const rulesId = text(source?.rulesId);
	if (!name && !uuid && !rulesId) return null;
	const grant = normalizeGrant({
		uuid,
		rulesId,
		name,
		specialisation: source?.specialisation ?? source?.specialization,
		documentType: CAREER_DOCUMENT_TYPE.ITEM,
		documentSubtype: source?.documentSubtype ?? source?.type ?? (kind === "skill" ? "skill" : ""),
		quantity: source?.quantity,
	}, kind);
	return {
		id: text(source?.id) || `${kind}-${index + 1}`,
		chance: percentage(source?.chance, 100),
		mode: CAREER_ENTRY_MODE.ALL,
		choose: 1,
		note: text(source?.note),
		choices: [{
			id: `${kind}-${index + 1}-choice-1`,
			label: name,
			grants: grant ? [grant] : [],
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
		id: text(source.id) || `choice-${index + 1}`,
		label: text(source.label) || grants.map((grant) => grant.name).filter(Boolean).join(" + "),
		grants,
	};
}

function normalizeGrant(source, kind) {
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	const name = text(source.name);
	const uuid = text(source.uuid);
	const rulesId = text(source.rulesId);
	if (!name && !uuid && !rulesId) return null;
	return {
		uuid,
		rulesId,
		name,
		specialisation: unwrapText(source.specialisation ?? source.specialization),
		documentType: allowed(
			text(source.documentType),
			Object.values(CAREER_DOCUMENT_TYPE),
			CAREER_DOCUMENT_TYPE.ITEM,
		),
		documentSubtype: text(source.documentSubtype) || (kind === "skill" ? "skill" : ""),
		quantity: Math.max(1, nonNegativeInteger(source.quantity) || 1),
	};
}

function normalizeMagicPoints(source) {
	if (!Array.isArray(source)) return [];
	return source.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const formula = text(entry.formula ?? entry.value);
		if (!formula) return null;
		return {
			races: Array.isArray(entry.races) ? entry.races.map(text).filter(Boolean) : [],
			formula,
			note: text(entry.note),
		};
	}).filter(Boolean);
}

function normalizeExits(source) {
	if (!Array.isArray(source)) return [];
	return source.map((entry) => {
		if (typeof entry === "string") entry = { name: entry };
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const name = text(entry.name);
		const uuid = text(entry.uuid);
		const rulesId = text(entry.rulesId);
		if (!name && !uuid && !rulesId) return null;
		return {
			uuid,
			rulesId,
			name,
			condition: text(entry.condition),
			requiresComplete: unwrapBoolean(entry.requiresComplete),
			excludedRaces: Array.isArray(entry.excludedRaces)
				? entry.excludedRaces.map(text).filter(Boolean)
				: [],
		};
	}).filter(Boolean);
}

function normalizeClass(value) {
	const normalized = text(value).toLocaleLowerCase();
	const aliases = {
		warrior: CAREER_CLASS.WARRIOR,
		wojownik: CAREER_CLASS.WARRIOR,
		ranger: CAREER_CLASS.RANGER,
		"wędrowiec": CAREER_CLASS.RANGER,
		wedrowiec: CAREER_CLASS.RANGER,
		rogue: CAREER_CLASS.ROGUE,
		"łotrzyk": CAREER_CLASS.ROGUE,
		lotrzyk: CAREER_CLASS.ROGUE,
		academic: CAREER_CLASS.ACADEMIC,
		uczony: CAREER_CLASS.ACADEMIC,
	};
	return aliases[normalized] ?? CAREER_CLASS.WARRIOR;
}

function canonicalCharacteristic(value) {
	const normalized = text(value).toLocaleLowerCase();
	if (["sp", "sz"].includes(normalized)) return "m";
	return CHARACTERISTIC_IDS.includes(normalized) ? normalized : "";
}

function allowed(value, values, fallback) {
	return values.includes(value) ? value : fallback;
}

function unwrapText(value) {
	return text(unwrapValue(value));
}

function unwrapBoolean(value) {
	const unwrapped = unwrapValue(value);
	return unwrapped === true;
}

function unwrapValue(value) {
	if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
		return value.value;
	}
	return value;
}

function text(value) {
	return value === undefined || value === null ? "" : String(value).trim();
}

function nonNegativeInteger(value) {
	const numeric = Number(unwrapValue(value));
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function percentage(value, fallback) {
	const numeric = Number(unwrapValue(value));
	return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.trunc(numeric))) : fallback;
}
