import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
} from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import {
	weaponOptionalModifierSnapshot,
} from "../data-models/item/WeaponData.mjs";

/**
 * Read-only combat view over Actor-owned physical Items.
 *
 * This service deliberately does not spend actions, roll attacks, apply damage,
 * or mutate equipment. It is the single boundary future combat procedures use
 * to answer questions such as "which weapons are held?" and "how many Armour
 * Points protect this location?".
 */
export class CombatEquipment {
	static heldItems(actor) {
		assertActor(actor);

		return Object.freeze(
			[...(actor.items ?? [])]
				.filter((item) => item?.system?.state?.mode === INVENTORY_MODE.HELD),
		);
	}

	static heldWeapons(actor) {
		return Object.freeze(
			this.heldItems(actor).filter((item) => item.type === "weapon"),
		);
	}

	static activeArmour(actor) {
		assertActor(actor);

		return Object.freeze(
			[...(actor.items ?? [])].filter((item) => {
				if (item?.type !== "armour") return false;

				const mode = String(item.system?.state?.mode ?? "");
				const armourClass = String(item.system?.armourClass ?? "");

				return armourClass === ARMOUR_CLASS.SHIELD
					? mode === INVENTORY_MODE.HELD
					: mode === INVENTORY_MODE.WORN;
			}),
		);
	}

	/**
	 * Sum Armour Points from active held Shield Items.
	 *
	 * The Classic sheet has a dedicated Shield box in addition to the six body
	 * locations. Keep that presentation value derived from the same Item state
	 * used by armourAt instead of persisting another Actor field.
	 */
	static shieldArmour(actor) {
		assertActor(actor);
		const sources = [];
		let total = 0;

		for (const item of this.activeArmour(actor)) {
			if (item.system?.armourClass !== ARMOUR_CLASS.SHIELD) continue;

			const points = nonNegativeInteger(item.system?.armourPoints);
			if (points <= 0) continue;

			total += points;
			sources.push(Object.freeze({
				itemUuid: String(item.uuid ?? ""),
				itemName: String(item.name ?? ""),
				points,
			}));
		}

		return foundry.utils.deepFreeze({
			total,
			sources,
		});
	}

	/**
	 * Sum active Armour Points covering one canonical humanoid hit location.
	 *
	 * Combat callers use the default and therefore include an active Shield.
	 * The Classic printed sheet records worn body armour in its six location
	 * boxes and the Shield in its own shield symbol, so presentation may request
	 * `includeShields: false` without changing the actual combat protection.
	 *
	 * Layer legality is intentionally audited/applied elsewhere; this function
	 * only answers the value represented by the Actor's current Item state.
	 */
	static armourAt(actor, hitLocation, { includeShields = true } = {}) {
		assertActor(actor);
		const location = normalizeHitLocation(hitLocation);
		const sources = [];
		let total = 0;

		for (const item of this.activeArmour(actor)) {
			if (
				includeShields !== true &&
				item.system?.armourClass === ARMOUR_CLASS.SHIELD
			) {
				continue;
			}

			if (item.system?.coverage?.[location] !== true) continue;

			const points = nonNegativeInteger(item.system?.armourPoints);
			if (points <= 0) continue;

			total += points;
			sources.push(Object.freeze({
				itemUuid: String(item.uuid ?? ""),
				itemName: String(item.name ?? ""),
				armourClass: String(item.system?.armourClass ?? ""),
				points,
			}));
		}

		return foundry.utils.deepFreeze({
			location,
			total,
			sources,
		});
	}

	/**
	 * Return currently available held parrying Items.
	 *
	 * Main-rule parry bonuses are always included. Optional Weapon Modifiers are
	 * included only when the caller explicitly enables that optional rule.
	 */
	static parryOptions(actor, { optionalWeaponModifiers = false } = {}) {
		assertActor(actor);
		const options = [];

		for (const item of this.heldItems(actor)) {
			if (item.type === "weapon") {
				if (item.system?.parry?.suitable !== true) continue;

				const optional = weaponOptionalModifierSnapshot(item);
				const baseBonus = integer(item.system?.parry?.bonus);
				const optionalBonus = optionalWeaponModifiers
					? integer(optional?.parry)
					: 0;

				options.push(Object.freeze({
					itemUuid: String(item.uuid ?? ""),
					itemName: String(item.name ?? ""),
					itemType: "weapon",
					baseBonus,
					optionalBonus,
					totalBonus: baseBonus + optionalBonus,
				}));
				continue;
			}

			if (
				item.type === "armour" &&
				item.system?.armourClass === ARMOUR_CLASS.SHIELD &&
				item.system?.parry?.suitable === true
			) {
				const baseBonus = integer(item.system?.parry?.bonus);
				options.push(Object.freeze({
					itemUuid: String(item.uuid ?? ""),
					itemName: String(item.name ?? ""),
					itemType: "armour",
					baseBonus,
					optionalBonus: 0,
					totalBonus: baseBonus,
				}));
			}
		}

		return Object.freeze(options);
	}

	static optionalWeaponModifiers(weapon) {
		return weaponOptionalModifierSnapshot(weapon);
	}
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Combat equipment resolution requires an Actor.");
	}
}

function normalizeHitLocation(value) {
	const location = String(value ?? "").trim();
	if (!ARMOUR_LOCATIONS.includes(location)) {
		throw new Error(
			`Armour lookup requires one of: ${ARMOUR_LOCATIONS.join(", ")}. Received '${location || "none"}'.`,
		);
	}
	return location;
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	return Math.max(0, integer(value));
}