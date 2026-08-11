import {
	INVENTORY_MODE,
	inventorySchema,
	migrateInventoryData,
	toBoolean,
	toInteger,
	toNonNegativeInteger,
	unwrapText,
	unwrapValue,
} from "./InventoryItemFields.mjs";

const {
	BooleanField,
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

export const WEAPON_KIND = Object.freeze({
	MELEE: "melee",
	RANGED: "ranged",
});

export const WEAPON_GROUP = Object.freeze({
	ORDINARY: "ordinary",
	SPECIALIST: "specialist",
	IMPROVISED: "improvised",
});

export const WEAPON_HANDEDNESS = Object.freeze({
	ONE: "one",
	TWO: "two",
	EITHER: "either",
});

const WEAPON_MODIFIER_KEYS = Object.freeze([
	"initiative",
	"toHit",
	"damage",
	"parry",
]);

/**
 * Native Foundry v14 data model for a WFRP 1e Weapon Item.
 *
 * The Core combat procedure uses a held weapon as one input to an attack. The
 * weapon stores stable equipment state and authored rule facts; the combat
 * subsystem remains responsible for attack economy, WS tests, damage, parry,
 * and optional-rules policy.
 *
 * `optionalModifiers` mirrors the optional Weapon Modifiers table. Merely
 * storing these values never enables that optional rule.
 */
export class WeaponData extends TypeDataModel {
	static defineSchema() {
		return {
			...inventorySchema({
				allowedModes: [
					INVENTORY_MODE.CARRIED,
					INVENTORY_MODE.HELD,
				],
			}),

			/** Stable package/module identity when one exists. */
			rulesId: textField(),

			/** Human-readable weapon class, e.g. Hand Weapon or Dagger. */
			weaponClass: textField(),

			kind: textField(WEAPON_KIND.MELEE),
			group: textField(WEAPON_GROUP.ORDINARY),

			/** Stable Skill/rule identity required by a Specialist Weapon. */
			specialistSkillId: textField(),

			handedness: textField(WEAPON_HANDEDNESS.ONE),

			/** Main-rule parry eligibility/bonus, independent of optional modifiers. */
			parry: new SchemaField({
				suitable: new BooleanField({
					required: true,
					nullable: false,
					initial: true,
				}),
				bonus: integerField(),
			}),

			/** Optional Core Weapon Modifiers; combat policy decides whether to use them. */
			optionalModifiers: new SchemaField({
				initiative: integerField(),
				toHit: integerField(),
				damage: integerField(),
				parry: integerField(),
			}),

			/** Transitional ranged-weapon facts retained for future ranged audit. */
			range: new SchemaField({
				short: nonNegativeIntegerField(),
				long: nonNegativeIntegerField(),
				max: nonNegativeIntegerField(),
			}),
			reload: nonNegativeIntegerField(),
		};
	}

	static migrateData(source, options = {}) {
		const migrated = migrateInventoryData(source, {
			allowedModes: [
				INVENTORY_MODE.CARRIED,
				INVENTORY_MODE.HELD,
			],
			legacyEquippedMode: INVENTORY_MODE.HELD,
		});
		const sourceObject = source && typeof source === "object"
			? source
			: {};
		const oldParry = objectValue(sourceObject.parry);
		const optional = objectValue(sourceObject.optionalModifiers);
		const range = objectValue(sourceObject.range);

		migrated.rulesId = unwrapText(sourceObject.rulesId);
		migrated.weaponClass = unwrapText(sourceObject.weaponClass);
		migrated.kind = normalizeAllowed(
			sourceObject.kind,
			Object.values(WEAPON_KIND),
			inferWeaponKind(range),
		);
		migrated.group = normalizeAllowed(
			sourceObject.group,
			Object.values(WEAPON_GROUP),
			WEAPON_GROUP.ORDINARY,
		);
		migrated.specialistSkillId = unwrapText(
			sourceObject.specialistSkillId,
		);
		migrated.handedness = normalizeAllowed(
			sourceObject.handedness,
			Object.values(WEAPON_HANDEDNESS),
			WEAPON_HANDEDNESS.ONE,
		);

		migrated.parry = {
			suitable: Object.hasOwn(oldParry, "suitable")
				? toBoolean(oldParry.suitable)
				: true,
			bonus: toInteger(oldParry.bonus),
		};

		migrated.optionalModifiers = {
			initiative: legacyModifier(
				optional,
				"initiative",
				sourceObject.initiative,
			),
			toHit: legacyModifier(
				optional,
				"toHit",
				sourceObject.weaponSkill,
			),
			damage: legacyModifier(
				optional,
				"damage",
				sourceObject.damage,
			),
			parry: legacyModifier(
				optional,
				"parry",
				sourceObject.parry,
			),
		};

		migrated.range = {
			short: toNonNegativeInteger(unwrapValue(range.short)),
			long: toNonNegativeInteger(unwrapValue(range.long)),
			max: toNonNegativeInteger(unwrapValue(range.max)),
		};
		migrated.reload = toNonNegativeInteger(
			unwrapValue(sourceObject.reload),
		);

		return super.migrateData(migrated, options);
	}
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

function integerField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
	});
}

function nonNegativeIntegerField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min: 0,
	});
}

function legacyModifier(container, key, legacyValue) {
	if (Object.hasOwn(container, key)) {
		return toInteger(unwrapValue(container[key]));
	}
	return toInteger(unwrapValue(legacyValue));
}

function inferWeaponKind(range) {
	return [range.short, range.long, range.max].some(
		(value) => toNonNegativeInteger(unwrapValue(value)) > 0,
	)
		? WEAPON_KIND.RANGED
		: WEAPON_KIND.MELEE;
}

function normalizeAllowed(value, allowed, fallback) {
	const normalized = unwrapText(value);
	return allowed.includes(normalized) ? normalized : fallback;
}

function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

export function weaponOptionalModifierSnapshot(weapon) {
	if (weapon?.type !== "weapon") return null;
	const source = weapon.system?.optionalModifiers ?? {};
	return Object.freeze(
		Object.fromEntries(
			WEAPON_MODIFIER_KEYS.map((key) => [key, toInteger(source[key])]),
		),
	);
}
