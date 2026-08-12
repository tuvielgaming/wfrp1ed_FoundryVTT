import { ARMOUR_CLASS } from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import { ArmourEquipValidator } from "./ArmourEquipValidator.mjs";
import { HandEquipValidator } from "./HandEquipValidator.mjs";

const SUPPORTED_ITEM_TYPES = new Set([
	"weapon",
	"armour",
	"equipment",
]);

/**
 * User-facing two-state view over the more precise physical Item state.
 *
 * The Classic sheet presents Equipped / Carried. Persistent data remains more
 * exact because combat and consequences need held/worn plus Main/Off/Both hand
 * slots. All equip transitions are validated before the Item update commits.
 */
export class CombatEquipmentState {
	static isUsed(item) {
		assertSupportedItem(item);
		return String(item.system?.state?.mode ?? "") === this.usedMode(item);
	}

	static usedMode(item) {
		assertSupportedItem(item);

		if (item.type === "weapon" || item.type === "equipment") {
			return INVENTORY_MODE.HELD;
		}

		return item.system?.armourClass === ARMOUR_CLASS.SHIELD
			? INVENTORY_MODE.HELD
			: INVENTORY_MODE.WORN;
	}

	static allowedHands(item) {
		return HandEquipValidator.allowedHands(item);
	}

	static preferredHand(item) {
		return HandEquipValidator.preferredHand(item);
	}

	static async setUsed(item, used) {
		assertSupportedItem(item);
		assertEditPermission(item);

		const mode = used === true
			? this.usedMode(item)
			: INVENTORY_MODE.CARRIED;
		const actor = item.actor ?? item.parent;
		const system = systemSource(item);
		let hand = String(system.state?.hand ?? INVENTORY_HAND.NONE);
		let armourValidation = null;

		if (used === true && mode === INVENTORY_MODE.HELD) {
			hand = HandEquipValidator.preferredHand(item);
			if (actor?.documentName === "Actor") {
				const validation = HandEquipValidator.validate(actor, item, hand);
				if (!validation.valid) {
					throw new Error(handConflictMessage(validation));
				}
			}
		}

		if (
			used === true &&
			item.type === "armour" &&
			mode === INVENTORY_MODE.WORN &&
			actor?.documentName === "Actor"
		) {
			armourValidation = ArmourEquipValidator.validate(actor, item);
			if (!armourValidation.valid) {
				throw new Error(armourConflictMessage(armourValidation));
			}
		}

		if (
			String(item.system?.state?.mode ?? "") === mode &&
			String(item.system?.state?.hand ?? "") === hand
		) {
			return item;
		}

		system.state = {
			...(system.state ?? {}),
			mode,
			hand,
		};

		await item.update({ system }, { wfrp1edValidatedEquipmentState: true });

		for (const warning of armourValidation?.warnings ?? []) {
			ui.notifications.warn(warning.message);
		}

		return item;
	}

	static async toggleUsed(item) {
		return this.setUsed(item, !this.isUsed(item));
	}

	static async setHand(item, hand) {
		assertSupportedItem(item);
		assertEditPermission(item);

		const allowed = HandEquipValidator.allowedHands(item);
		if (!allowed.includes(hand)) {
			throw new Error(localize(
				"That hand position is not valid for this Item.",
				"Ten układ dłoni nie jest prawidłowy dla tego przedmiotu.",
			));
		}

		const actor = item.actor ?? item.parent;
		if (
			this.isUsed(item) &&
			this.usedMode(item) === INVENTORY_MODE.HELD &&
			actor?.documentName === "Actor"
		) {
			const validation = HandEquipValidator.validate(actor, item, hand);
			if (!validation.valid) {
				throw new Error(handConflictMessage(validation));
			}
		}

		if (String(item.system?.state?.hand ?? "") === hand) {
			return item;
		}

		const system = systemSource(item);
		system.state = {
			...(system.state ?? {}),
			hand,
		};
		await item.update({ system }, { wfrp1edValidatedEquipmentState: true });
		return item;
	}

	static async cycleHand(item, direction = 1) {
		const current = HandEquipValidator.preferredHand(item);
		const next = HandEquipValidator.nextHand(item, current, direction);
		return this.setHand(item, next);
	}
}

function systemSource(item) {
	const model = item.system;

	if (typeof model?.toObject === "function") {
		return model.toObject(true);
	}

	return foundry.utils.deepClone(model ?? {});
}

function handConflictMessage(validation) {
	const first = validation?.conflicts?.[0];
	return first?.message || localize(
		"The selected hand position conflicts with another equipped Item.",
		"Wybrany układ dłoni koliduje z innym używanym przedmiotem.",
	);
}

function armourConflictMessage(validation) {
	const first = validation?.conflicts?.[0];
	if (!first) {
		return localize(
			"This armour combination is not legal under the Core rules.",
			"Ta kombinacja pancerza jest niedozwolona według zasad podstawowych.",
		);
	}

	const existing = (first.existingItems ?? [])
		.map((entry) => entry.itemName)
		.filter(Boolean)
		.join(", ");
	const suffix = existing
		? localize(` Conflict: ${existing}.`, ` Konflikt: ${existing}.`)
		: "";
	return `${first.message}${suffix}`;
}

function assertSupportedItem(item) {
	if (
		!(item instanceof foundry.documents.Item) ||
		!SUPPORTED_ITEM_TYPES.has(item.type)
	) {
		throw new Error(
			"Inventory state requires a Weapon, Armour, or Equipment Item.",
		);
	}
}

function assertEditPermission(item) {
	if (game.user?.isGM || item.isOwner) {
		return;
	}

	throw new Error(
		"Only the GM or an Item owner may change equipment state.",
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
