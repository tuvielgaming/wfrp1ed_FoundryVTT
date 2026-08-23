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
 * slots. Hand-slot clashes are treated as a loadout change: conflicting held
 * Items are moved to Carried before the requested Item takes the slot. Invalid
 * hand choices and illegal worn-armour combinations remain hard validation
 * errors.
 */
export class CombatEquipmentState {
	static isUsed(item) {
		assertSupportedItem(item);
		return String(item.system?.state?.mode ?? "") === this.usedMode(item);
	}

	static usedMode(item) {
		assertSupportedItem(item);

		if (item.type === "equipment" && item.system?.isClothing === true) {
			return INVENTORY_MODE.WORN;
		}

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
		let displaced = [];

		if (used === true && mode === INVENTORY_MODE.HELD) {
			hand = HandEquipValidator.preferredHand(item);
			if (actor?.documentName === "Actor") {
				displaced = await displaceHandConflicts(actor, item, hand);
			}
		} else if (used === true && mode === INVENTORY_MODE.WORN) {
			hand = INVENTORY_HAND.NONE;
		}

		if (
			used === true &&
			item.type === "armour" &&
			mode === INVENTORY_MODE.WORN &&
			actor?.documentName === "Actor"
		) {
			armourValidation = ArmourEquipValidator.validate(actor, item);
			if (!armourValidation.valid) {
				await restoreDisplaced(displaced);
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

		try {
			await item.update({ system }, { wfrp1edValidatedEquipmentState: true });
		} catch (error) {
			await restoreDisplaced(displaced);
			throw error;
		}

		const seenWarnings = new Set();
		for (const warning of armourValidation?.warnings ?? []) {
			if (seenWarnings.has(warning.message)) continue;
			seenWarnings.add(warning.message);
			ui.notifications.warn(warning.message);
		}

		if (displaced.length > 0) {
			notifyHandReplacement(item, hand, displaced);
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
		let displaced = [];
		if (
			this.isUsed(item) &&
			this.usedMode(item) === INVENTORY_MODE.HELD &&
			actor?.documentName === "Actor"
		) {
			displaced = await displaceHandConflicts(actor, item, hand);
		}

		if (String(item.system?.state?.hand ?? "") === hand) {
			return item;
		}

		const system = systemSource(item);
		system.state = {
			...(system.state ?? {}),
			hand,
		};
		try {
			await item.update({ system }, { wfrp1edValidatedEquipmentState: true });
		} catch (error) {
			await restoreDisplaced(displaced);
			throw error;
		}

		if (displaced.length > 0) {
			notifyHandReplacement(item, hand, displaced);
		}
		return item;
	}

	static async cycleHand(item, direction = 1) {
		const current = HandEquipValidator.preferredHand(item);
		const next = HandEquipValidator.nextHand(item, current, direction);
		return this.setHand(item, next);
	}
}

/**
 * Move real slot conflicts to Carried. A validation failure caused by the
 * candidate itself (for example an impossible hand choice) is never repaired by
 * unequipping unrelated Items.
 */
async function displaceHandConflicts(actor, candidate, hand) {
	const validation = HandEquipValidator.validate(actor, candidate, hand);
	if (validation.valid) return [];

	const conflicts = validation.conflicts ?? [];
	if (
		conflicts.length === 0 ||
		conflicts.some((entry) => String(entry.itemUuid ?? "") === String(candidate.uuid ?? ""))
	) {
		throw new Error(handConflictMessage(validation));
	}

	const displaced = [];
	for (const entry of conflicts) {
		const conflict = [...(actor.items ?? [])].find(
			(item) => String(item.uuid ?? "") === String(entry.itemUuid ?? ""),
		);
		if (!conflict) {
			await restoreDisplaced(displaced);
			throw new Error(handConflictMessage(validation));
		}
		if (conflict.system?.state?.mode !== INVENTORY_MODE.HELD) continue;

		const previousState = foundry.utils.deepClone(conflict.system?.state ?? {});
		displaced.push({ item: conflict, previousState });
		await conflict.update({
			"system.state.mode": INVENTORY_MODE.CARRIED,
		}, { wfrp1edValidatedEquipmentState: true });
	}

	const after = HandEquipValidator.validate(actor, candidate, hand);
	if (!after.valid) {
		await restoreDisplaced(displaced);
		throw new Error(handConflictMessage(after));
	}
	return displaced;
}

async function restoreDisplaced(displaced) {
	for (const entry of [...(displaced ?? [])].reverse()) {
		try {
			await entry.item?.update?.({
				"system.state": foundry.utils.deepClone(entry.previousState ?? {}),
			}, { wfrp1edValidatedEquipmentState: true });
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to restore a displaced held Item after a failed loadout change.",
				error,
			);
		}
	}
}

function notifyHandReplacement(candidate, hand, displaced) {
	const names = displaced
		.map((entry) => String(entry.item?.name ?? "").trim())
		.filter(Boolean)
		.join(", ");
	if (!names) return;

	ui.notifications.info(localize(
		`Unequipped: ${names}. ${candidate.name} is now held in ${handLabel(hand, false)}.`,
		`Odłożono: ${names}. ${candidate.name} jest teraz trzymana ${handLabel(hand, true)}.`,
	));
}

function handLabel(hand, polish) {
	if (polish) {
		switch (hand) {
			case INVENTORY_HAND.MAIN: return "w głównej dłoni";
			case INVENTORY_HAND.OFF: return "w drugiej dłoni";
			case INVENTORY_HAND.BOTH: return "w obu dłoniach";
			default: return "bez przypisanej dłoni";
		}
	}

	switch (hand) {
		case INVENTORY_HAND.MAIN: return "the main hand";
		case INVENTORY_HAND.OFF: return "the off hand";
		case INVENTORY_HAND.BOTH: return "both hands";
		default: return "no hand slot";
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
