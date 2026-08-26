const {
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

export const SPELL_TRADITION = Object.freeze({
	PETTY: "petty",
	BATTLE: "battle",
	DEMONIC: "demonic",
	DRUIDIC: "druidic",
	ELEMENTAL: "elemental",
	ILLUSION: "illusion",
	NECROMANTIC: "necromantic",
	CLERIC: "cleric",
});

export const SPELL_COST_INTERVAL = Object.freeze({
	CAST: "cast",
	MISSILE: "missile",
	ROUND: "round",
	TURN: "turn",
	MINUTE: "minute",
	HOUR: "hour",
	DAY: "day",
	WEEK: "week",
	MONTH: "month",
	YEAR: "year",
});

/**
 * Native Foundry v14 data model for WFRP 1e Spell Items.
 *
 * Core spell records consistently publish a level, Magic Point cost, range,
 * duration, ingredients and descriptive procedure. Range and duration remain
 * authored rule text because the Core deliberately uses values such as
 * Personal, Touch, Until triggered, 1+D6 turns and spell-specific conditions.
 * Consumers must not try to infer executable mechanics from localized prose.
 *
	* Magic Point cost is structured because resource spending is shared casting
	* state: an amount may be paid once when cast, per magical missile, or
	* repeatedly per turn/hour/week.
	* Spell-specific outcomes belong to Active Effects or future audited procedure
	* providers identified by the stable, language-neutral `rulesId`. That internal
	* field is not exposed for free-text authoring; the casting registry provides
	* the allowed selections displayed by the sheet.
 */
export class SpellData extends TypeDataModel {
	static defineSchema() {
		return {
			rulesId: textField(),
			tradition: textField(SPELL_TRADITION.PETTY),
			spellLevel: integerField(0, 0, 4),
			magicPointCost: new SchemaField({
				amount: integerField(0, 0),
				interval: textField(SPELL_COST_INTERVAL.CAST),
			}),
			range: textField(),
			duration: textField(),
			ingredients: textField(),
			description: textField(),
		};
	}

	static migrateData(source, options = {}) {
		const raw = objectValue(source);
		const migrated = foundry.utils.deepClone(raw);

		if (Object.hasOwn(raw, "rulesId")) {
			migrated.rulesId = unwrapText(raw.rulesId);
		}
		if (Object.hasOwn(raw, "tradition")) {
			migrated.tradition = allowed(
				unwrapText(raw.tradition),
				Object.values(SPELL_TRADITION),
				SPELL_TRADITION.PETTY,
			);
		}
		if (Object.hasOwn(raw, "spellLevel")) {
			migrated.spellLevel = spellLevel(raw.spellLevel);
		}
		if (Object.hasOwn(raw, "magicPointCost")) {
			migrated.magicPointCost = normalizeMagicPointCost(
				raw.magicPointCost,
			);
		}
		for (const key of ["range", "duration", "ingredients", "description"]) {
			if (Object.hasOwn(raw, key)) migrated[key] = unwrapText(raw[key]);
		}

		return super.migrateData(migrated, options);
	}
}

function normalizeMagicPointCost(value) {
	const raw = objectValue(value);
	const migrated = {};
	if (Object.hasOwn(raw, "amount")) {
		migrated.amount = nonNegativeInteger(raw.amount);
	}
	if (Object.hasOwn(raw, "interval")) {
		migrated.interval = allowed(
			unwrapText(raw.interval),
			Object.values(SPELL_COST_INTERVAL),
			SPELL_COST_INTERVAL.CAST,
		);
	}
	return migrated;
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

function integerField(initial = 0, min = 0, max = undefined) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min,
		...(max === undefined ? {} : { max }),
	});
}

function spellLevel(value) {
	const unwrapped = unwrapValue(value);
	if (String(unwrapped ?? "").trim().toUpperCase() === "P") return 0;
	return Math.min(4, nonNegativeInteger(unwrapped));
}

function nonNegativeInteger(value) {
	const numeric = Number(unwrapValue(value));
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function allowed(value, values, fallback) {
	return values.includes(value) ? value : fallback;
}

function unwrapText(value) {
	const unwrapped = unwrapValue(value);
	return unwrapped === undefined || unwrapped === null
		? ""
		: String(unwrapped).trim();
}

function unwrapValue(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "value")
	) {
		return value.value;
	}
	return value;
}

function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}
