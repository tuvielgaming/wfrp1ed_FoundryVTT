import { ARMOUR_CLASS } from "../data-models/item/ArmourData.mjs";
import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";

const SUPPORTED_ITEM_TYPES = new Set([
	"weapon",
	"armour",
]);

/**
 * User-facing two-state view over the more precise physical Item state.
 *
 * The Classic sheet only needs to answer whether combat equipment is currently
 * in use. Persistent data remains more exact because other rules need to know
 * whether an Item is held or worn:
 *
 * weapon used  -> held
 * shield used  -> held
 * armour used  -> worn
 * not used     -> carried
 *
 * This keeps the simple Carried / Used interaction without throwing away the
 * distinction required by effects such as dropping held Items.
 */
export class CombatEquipmentState {
	static isUsed(item) {
		assertSupportedItem(item);

		const mode = String(item.system?.state?.mode ?? "");

		return mode === this.usedMode(item);
	}

	static usedMode(item) {
		assertSupportedItem(item);

		if (item.type === "weapon") {
			return INVENTORY_MODE.HELD;
		}

		return item.system?.armourClass === ARMOUR_CLASS.SHIELD
			? INVENTORY_MODE.HELD
			: INVENTORY_MODE.WORN;
	}

	static async setUsed(item, used) {
		assertSupportedItem(item);
		assertEditPermission(item);

		const mode = used === true
			? this.usedMode(item)
			: INVENTORY_MODE.CARRIED;

		if (String(item.system?.state?.mode ?? "") === mode) {
			return item;
		}

		/*
		 * Update the complete TypeDataModel source, not only a dotted state key.
		 *
		 * WeaponData/ArmourData still contain compatibility migrations which are
		 * allowed to receive candidate system data during Foundry's update
		 * cleaning workflow. Supplying only `system.state.mode` can therefore
		 * make omitted authored fields look like legacy/missing data and reset
		 * them to migration defaults. That showed up at runtime as Armour Points
		 * and coverage disappearing after a Carried/Used toggle.
		 *
		 * Keeping the whole current source in this explicit state transaction
		 * makes the operation lossless while the legacy migration layer exists.
		 */
		const system = systemSource(item);
		system.state = {
			...(system.state ?? {}),
			mode,
		};

		await item.update({ system });

		return item;
	}

	static async toggleUsed(item) {
		return this.setUsed(item, !this.isUsed(item));
	}
}

function systemSource(item) {
	const model = item.system;

	if (typeof model?.toObject === "function") {
		return model.toObject(true);
	}

	return foundry.utils.deepClone(model ?? {});
}

function assertSupportedItem(item) {
	if (
		!(item instanceof foundry.documents.Item) ||
		!SUPPORTED_ITEM_TYPES.has(item.type)
	) {
		throw new Error(
			"Combat equipment state requires a Weapon or Armour Item.",
		);
	}
}

function assertEditPermission(item) {
	if (game.user?.isGM || item.isOwner) {
		return;
	}

	throw new Error(
		"Only the GM or an Item owner may change combat equipment state.",
	);
}
