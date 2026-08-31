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
import {
	AMMUNITION_TYPE,
	ammunitionIdentity,
	normalizeAmmunitionType,
	normalizeCustomId,
} from "./AmmunitionTypes.mjs";
import { coreSkillSpecialisationId } from "../../core/CoreSkillSpecialisationCatalog.mjs";

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

export const EFFECTIVE_STRENGTH_MODE = Object.freeze({
	FIXED: "fixed",
	CHARACTER: "character",
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
 * Weapon mechanics are described by explicit structured fields: kind, group,
 * Specialist Weapon binding, handedness, range, ammunition compatibility,
 * firing cycle and Item-owned Active Effects.
 *
 * `specialistSkillId` stores a stable language-neutral id from the audited Core
 * Specialist Weapon catalogue. The value "custom" means the homebrew binding is
 * stored in `specialistSkillCustom`. The historical free-text `weaponClass`
 * field is intentionally discarded: it had no independent mechanical consumer
 * and duplicated the structured fields above.
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

			kind: textField(WEAPON_KIND.MELEE),
			group: textField(WEAPON_GROUP.ORDINARY),
			specialistSkillId: textField(),
			specialistSkillCustom: textField(),
			handedness: textField(WEAPON_HANDEDNESS.ONE),

			parry: new SchemaField({
				suitable: new BooleanField({ required: true, nullable: false, initial: true }),
				bonus: integerField(),
			}),

			optionalModifiers: new SchemaField({
				initiative: integerField(),
				toHit: integerField(),
				damage: integerField(),
				parry: integerField(),
			}),

			range: new SchemaField({
				short: rangeField(),
				long: rangeField(),
				max: rangeField(),
			}),
			effectiveStrengthMode: textField(EFFECTIVE_STRENGTH_MODE.FIXED),
			effectiveStrength: nonNegativeIntegerField(),
			ammunitionType: textField(AMMUNITION_TYPE.NONE),
			ammunitionCustomId: textField(),
			firingCycle: new SchemaField({
				reloadRounds: nonNegativeIntegerField(),
				shotsPerFireRound: positiveIntegerField(1),
				magazineCapacity: nonNegativeIntegerField(),
				magazineReloadRounds: nonNegativeIntegerField(),
			}),
		};
	}

	get reload() {
		return toNonNegativeInteger(this.firingCycle?.reloadRounds);
	}

	static migrateData(source, options = {}) {
		if (options?.partial === true) {
			return TypeDataModel.migrateData.call(this, source, options);
		}

		const migrated = migrateInventoryData(source, {
			allowedModes: [INVENTORY_MODE.CARRIED, INVENTORY_MODE.HELD],
			legacyEquippedMode: INVENTORY_MODE.HELD,
		});
		const sourceObject = source && typeof source === "object" ? source : {};
		const oldParry = objectValue(sourceObject.parry);
		const optional = objectValue(sourceObject.optionalModifiers);
		const range = objectValue(sourceObject.range);
		const firingCycle = objectValue(sourceObject.firingCycle);
		const kind = normalizeAllowed(
			sourceObject.kind,
			Object.values(WEAPON_KIND),
			inferWeaponKind(sourceObject, range),
		);

		delete migrated.rulesId;
		delete migrated.weaponClass;

		migrated.kind = kind;
		migrated.group = normalizeAllowed(
			sourceObject.group,
			Object.values(WEAPON_GROUP),
			WEAPON_GROUP.ORDINARY,
		);

		const oldSpecialist = unwrapText(sourceObject.specialistSkillId);
		const knownSpecialist = coreSkillSpecialisationId("specialistWeapon", oldSpecialist);
		const explicitCustom = unwrapText(sourceObject.specialistSkillCustom);
		if (knownSpecialist) {
			migrated.specialistSkillId = knownSpecialist;
			migrated.specialistSkillCustom = "";
		} else if (oldSpecialist === "custom") {
			migrated.specialistSkillId = "custom";
			migrated.specialistSkillCustom = explicitCustom;
		} else if (oldSpecialist) {
			migrated.specialistSkillId = "custom";
			migrated.specialistSkillCustom = explicitCustom || oldSpecialist;
		} else {
			migrated.specialistSkillId = "";
			migrated.specialistSkillCustom = explicitCustom;
		}

		migrated.handedness = normalizeAllowed(
			sourceObject.handedness,
			Object.values(WEAPON_HANDEDNESS),
			WEAPON_HANDEDNESS.ONE,
		);

		migrated.parry = {
			suitable: Object.hasOwn(oldParry, "suitable") ? toBoolean(oldParry.suitable) : true,
			bonus: toInteger(oldParry.bonus),
		};

		migrated.optionalModifiers = {
			initiative: legacyModifier(optional, "initiative", sourceObject.initiative),
			toHit: legacyModifier(optional, "toHit", sourceObject.weaponSkill),
			damage: legacyModifier(optional, "damage", kind === WEAPON_KIND.MELEE ? sourceObject.damage : 0),
			parry: legacyModifier(optional, "parry", sourceObject.parry),
		};

		migrated.range = {
			short: normalizeRangeValue(range.short),
			long: normalizeRangeValue(range.long),
			max: normalizeRangeValue(range.max),
		};
		migrated.effectiveStrengthMode = normalizeAllowed(
			sourceObject.effectiveStrengthMode,
			Object.values(EFFECTIVE_STRENGTH_MODE),
			EFFECTIVE_STRENGTH_MODE.FIXED,
		);
		migrated.effectiveStrength = toNonNegativeInteger(
			unwrapValue(
				Object.hasOwn(sourceObject, "effectiveStrength")
					? sourceObject.effectiveStrength
					: kind === WEAPON_KIND.RANGED
						? sourceObject.damage
						: 0,
			),
		);
		migrated.ammunitionType = normalizeAmmunitionType(
			unwrapText(sourceObject.ammunitionType),
			AMMUNITION_TYPE.NONE,
		);
		migrated.ammunitionCustomId = normalizeCustomId(
			unwrapText(sourceObject.ammunitionCustomId),
		);

		migrated.firingCycle = {
			reloadRounds: migratedReloadRounds(sourceObject, firingCycle),
			shotsPerFireRound: positiveIntegerValue(unwrapValue(firingCycle.shotsPerFireRound), 1),
			magazineCapacity: toNonNegativeInteger(unwrapValue(firingCycle.magazineCapacity)),
			magazineReloadRounds: toNonNegativeInteger(unwrapValue(firingCycle.magazineReloadRounds)),
		};

		return super.migrateData(migrated, options);
	}
}

function migratedReloadRounds(sourceObject, firingCycle) {
	if (Object.hasOwn(firingCycle, "reloadRounds")) {
		return toNonNegativeInteger(unwrapValue(firingCycle.reloadRounds));
	}
	const splitLoad = Object.hasOwn(firingCycle, "loadRounds")
		? toNonNegativeInteger(unwrapValue(firingCycle.loadRounds)) : 0;
	const splitRecovery = Object.hasOwn(firingCycle, "recoveryRounds")
		? toNonNegativeInteger(unwrapValue(firingCycle.recoveryRounds)) : 0;
	if (splitLoad > 0) return splitLoad;
	if (splitRecovery > 0) return splitRecovery;
	const legacyReload = toNonNegativeInteger(unwrapValue(sourceObject.reload));
	return legacyReload > 0 ? legacyReload : 0;
}

function textField(initial = "") {
	return new StringField({ required: true, nullable: false, blank: true, initial, trim: true });
}
function rangeField(initial = "0") {
	return new StringField({ required: true, nullable: false, blank: false, initial, trim: true });
}
function integerField(initial = 0) {
	return new NumberField({ required: true, nullable: false, integer: true, initial });
}
function nonNegativeIntegerField(initial = 0) {
	return new NumberField({ required: true, nullable: false, integer: true, initial, min: 0 });
}
function positiveIntegerField(initial = 1) {
	return new NumberField({ required: true, nullable: false, integer: true, initial, min: 1 });
}
function positiveIntegerValue(value, fallback = 1) {
	const number = Number(value);
	return Number.isFinite(number) && Number.isInteger(number) && number > 0 ? number : fallback;
}
function legacyModifier(container, key, legacyValue) {
	return Object.hasOwn(container, key) ? toInteger(unwrapValue(container[key])) : toInteger(unwrapValue(legacyValue));
}
function inferWeaponKind(source, range) {
	if (source?.isRanged === true) return WEAPON_KIND.RANGED;
	if (source?.isRanged === false) return WEAPON_KIND.MELEE;
	return [range.short, range.long, range.max].some((value) => (rangeNumericValue(value) ?? 0) > 0)
		? WEAPON_KIND.RANGED : WEAPON_KIND.MELEE;
}
function normalizeAllowed(value, allowed, fallback) {
	const normalized = unwrapText(value);
	return allowed.includes(normalized) ? normalized : fallback;
}
function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function normalizeRangeValue(value) {
	const raw = unwrapValue(value);
	const text = String(raw ?? "").trim();
	if (text === "-" || text === "—") return "-";
	const number = Number(text);
	return Number.isFinite(number) && Number.isInteger(number) && number >= 0 ? String(number) : "0";
}

export function rangeNumericValue(value) {
	const raw = unwrapValue(value);
	const text = String(raw ?? "").trim();
	if (text === "-" || text === "—") return null;
	const number = Number(text);
	return Number.isFinite(number) && Number.isInteger(number) && number >= 0 ? number : null;
}

export function rangeDisplayValue(value) {
	const raw = unwrapValue(value);
	const text = String(raw ?? "").trim();
	if (text === "-" || text === "—") return "-";
	const number = rangeNumericValue(value);
	return number === null ? "-" : String(number);
}

export function weaponOptionalModifierSnapshot(weapon) {
	if (weapon?.type !== "weapon") return null;
	const source = weapon.system?.optionalModifiers ?? {};
	return Object.freeze(Object.fromEntries(WEAPON_MODIFIER_KEYS.map((key) => [key, toInteger(source[key])])));
}

export function weaponRangedCycleSnapshot(weapon) {
	if (weapon?.type !== "weapon") return null;
	const source = weapon.system?.firingCycle ?? {};
	const magazineCapacity = toNonNegativeInteger(source.magazineCapacity);
	return Object.freeze({
		reloadRounds: toNonNegativeInteger(source.reloadRounds),
		shotsPerFireRound: positiveIntegerValue(source.shotsPerFireRound, 1),
		magazineCapacity,
		magazineReloadRounds: magazineCapacity > 0 ? toNonNegativeInteger(source.magazineReloadRounds) : 0,
	});
}

export function weaponAmmunitionSnapshot(weapon) {
	if (weapon?.type !== "weapon") return null;
	return ammunitionIdentity({ type: weapon.system?.ammunitionType, customId: weapon.system?.ammunitionCustomId });
}
