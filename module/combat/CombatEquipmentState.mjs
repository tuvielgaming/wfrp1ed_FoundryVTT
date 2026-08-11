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

		await item.update({
			"system.state.mode": mode,
		});

		return item;
	}

	static async toggleUsed(item) {
		return this.setUsed(item, !this.isUsed(item));
	}
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
