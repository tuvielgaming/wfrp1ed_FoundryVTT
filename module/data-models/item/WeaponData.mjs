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
 * weapon stores stable equipment state and authored rule facts; combat remains
 * responsible for attack economy, tests, damage, parry and ranged timing.
 *
 * `optionalModifiers` mirrors the optional melee Weapon Modifiers table. The
 * values stay on the common Weapon data model so an Item can be re-authored,
 * but ranged presentation and ranged attack resolution must not consume them.
 *
 * Ranged cadence uses one canonical Reload value. It is the number of complete
 * preparation rounds which must pass before another firing round is available:
 * - Reload 0: the weapon may fire every round;
 * - Reload 1: one preparation round between firing rounds (e.g. Crossbow);
 * - Reload 2: two preparation rounds between firing rounds (e.g. Pistol/Lasso
 *   according to the relevant Core timing entry).
 *
 * `shotsPerFireRound` and magazine fields are separate because repeating
 * weapons can fire more than once in their legal firing round and may require a
 * distinct magazine-refill procedure.
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

			/** Main-rule parry eligibility/bonus for melee use. */
			parry: new SchemaField({
				suitable: new BooleanField({
					required: true,
					nullable: false,
					initial: true,
				}),
				bonus: integerField(),
			}),

			/** Optional Core melee Weapon Modifiers. */
			optionalModifiers: new SchemaField({
				initiative: integerField(),
				toHit: integerField(),
				damage: integerField(),
				parry: integerField(),
			}),

			/** Authored ranged/thrown-weapon facts shown by the printed sheet. */
			range: new SchemaField({
				short: nonNegativeIntegerField(),
				long: nonNegativeIntegerField(),
				max: nonNegativeIntegerField(),
			}),
			effectiveStrength: nonNegativeIntegerField(),
			firingCycle: new SchemaField({
				reloadRounds: nonNegativeIntegerField(),
				shotsPerFireRound: positiveIntegerField(1),
				magazineCapacity: nonNegativeIntegerField(),
				magazineReloadRounds: nonNegativeIntegerField(),
			}),
		};
	}

	/**
	 * Read-only compatibility alias for the printed Classic `Ład.`/Reload column.
	 * The authoritative persisted value lives in firingCycle.reloadRounds.
	 */
	get reload() {
		return toNonNegativeInteger(this.firingCycle?.reloadRounds);
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
		const firingCycle = objectValue(sourceObject.firingCycle);
		const kind = normalizeAllowed(
			sourceObject.kind,
			Object.values(WEAPON_KIND),
			inferWeaponKind(sourceObject, range),
		);

		migrated.rulesId = unwrapText(sourceObject.rulesId);
		migrated.weaponClass = unwrapText(sourceObject.weaponClass);
		migrated.kind = kind;
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
				kind === WEAPON_KIND.MELEE
					? sourceObject.damage
					: 0,
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
		migrated.effectiveStrength = toNonNegativeInteger(
			unwrapValue(
				Object.hasOwn(sourceObject, "effectiveStrength")
					? sourceObject.effectiveStrength
					: kind === WEAPON_KIND.RANGED
						? sourceObject.damage
						: 0,
			),
		);

		/*
		 * Accept every temporary/legacy timing shape which has existed in this
		 * project. `reloadRounds` is authoritative. The short-lived split model is
		 * collapsed without summing values. A non-zero load value wins; otherwise
		 * a non-zero recovery value is preserved (important for e.g. a Lasso which
		 * may have been authored during that short-lived model), then the original
		 * scalar reload value is used as the last fallback.
		 */
		migrated.firingCycle = {
			reloadRounds: migratedReloadRounds(sourceObject, firingCycle),
			shotsPerFireRound: positiveIntegerValue(
				unwrapValue(firingCycle.shotsPerFireRound),
				1,
			),
			magazineCapacity: toNonNegativeInteger(
				unwrapValue(firingCycle.magazineCapacity),
			),
			magazineReloadRounds: toNonNegativeInteger(
				unwrapValue(firingCycle.magazineReloadRounds),
			),
		};

		return super.migrateData(migrated, options);
	}
}

function migratedReloadRounds(sourceObject, firingCycle) {
	if (Object.hasOwn(firingCycle, "reloadRounds")) {
		return toNonNegativeInteger(unwrapValue(firingCycle.reloadRounds));
	}

	const splitLoad = Object.hasOwn(firingCycle, "loadRounds")
		? toNonNegativeInteger(unwrapValue(firingCycle.loadRounds))
		: 0;
	const splitRecovery = Object.hasOwn(firingCycle, "recoveryRounds")
		? toNonNegativeInteger(unwrapValue(firingCycle.recoveryRounds))
		: 0;

	if (splitLoad > 0) return splitLoad;
	if (splitRecovery > 0) return splitRecovery;

	const legacyReload = toNonNegativeInteger(unwrapValue(sourceObject.reload));
	if (legacyReload > 0) return legacyReload;
	return 0;
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

function positiveIntegerField(initial = 1) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min: 1,
	});
}

function positiveIntegerValue(value, fallback = 1) {
	const number = Number(value);
	return Number.isFinite(number) && Number.isInteger(number) && number > 0
		? number
		: fallback;
}

function legacyModifier(container, key, legacyValue) {
	if (Object.hasOwn(container, key)) {
		return toInteger(unwrapValue(container[key]));
	}
	return toInteger(unwrapValue(legacyValue));
}

function inferWeaponKind(source, range) {
	if (source?.isRanged === true) {
		return WEAPON_KIND.RANGED;
	}

	if (source?.isRanged === false) {
		return WEAPON_KIND.MELEE;
	}

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

export function weaponRangedCycleSnapshot(weapon) {
	if (weapon?.type !== "weapon") return null;
	const source = weapon.system?.firingCycle ?? {};
	const magazineCapacity = toNonNegativeInteger(source.magazineCapacity);
	return Object.freeze({
		reloadRounds: toNonNegativeInteger(source.reloadRounds),
		shotsPerFireRound: positiveIntegerValue(source.shotsPerFireRound, 1),
		magazineCapacity,
		magazineReloadRounds: magazineCapacity > 0
			? toNonNegativeInteger(source.magazineReloadRounds)
			: 0,
	});
}
