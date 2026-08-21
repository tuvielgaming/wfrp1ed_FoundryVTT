import { ARMOUR_CLASS } from "../data-models/item/ArmourData.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
	normalizeInventoryHand,
} from "../data-models/item/InventoryItemFields.mjs";
import { WEAPON_HANDEDNESS } from "../data-models/item/WeaponData.mjs";

const HAND_OCCUPANCY = Object.freeze({
	[INVENTORY_HAND.MAIN]: Object.freeze([INVENTORY_HAND.MAIN]),
	[INVENTORY_HAND.OFF]: Object.freeze([INVENTORY_HAND.OFF]),
	[INVENTORY_HAND.BOTH]: Object.freeze([
		INVENTORY_HAND.MAIN,
		INVENTORY_HAND.OFF,
	]),
	[INVENTORY_HAND.NONE]: Object.freeze([]),
});

/**
 * Validate the relative Main / Off / Both hand slots used by physical Items.
 *
 * WFRP 1e Core p.118 allows a blow with a weapon held in either hand and gives
 * -10 To Hit for a weapon used wrong-handed. The Ambidextrous / Oburęczność
 * Skill removes that disadvantage. This service only maintains the loadout;
 * the attack resolver will apply or waive the modifier when it is implemented.
 */
export class HandEquipValidator {
	static allowedHands(item) {
		assertPhysicalItem(item);

		if (item.type === "weapon") {
			switch (String(item.system?.handedness ?? "")) {
				case WEAPON_HANDEDNESS.TWO:
					return Object.freeze([INVENTORY_HAND.BOTH]);
				case WEAPON_HANDEDNESS.EITHER:
					return Object.freeze([
						INVENTORY_HAND.MAIN,
						INVENTORY_HAND.OFF,
						INVENTORY_HAND.BOTH,
					]);
				default:
					return Object.freeze([
						INVENTORY_HAND.MAIN,
						INVENTORY_HAND.OFF,
					]);
			}
		}

		if (item.type === "armour") {
			return item.system?.armourClass === ARMOUR_CLASS.SHIELD
				? Object.freeze([
					INVENTORY_HAND.MAIN,
					INVENTORY_HAND.OFF,
				])
				: Object.freeze([INVENTORY_HAND.NONE]);
		}

		if (item.type === "equipment" && item.system?.isClothing === true) {
			return Object.freeze([INVENTORY_HAND.NONE]);
		}

		return Object.freeze([
			INVENTORY_HAND.MAIN,
			INVENTORY_HAND.OFF,
			INVENTORY_HAND.BOTH,
		]);
	}

	static defaultHand(item) {
		assertPhysicalItem(item);
		const allowed = this.allowedHands(item);

		if (item.type === "armour" && item.system?.armourClass === ARMOUR_CLASS.SHIELD) {
			return INVENTORY_HAND.OFF;
		}

		if (allowed.includes(INVENTORY_HAND.MAIN)) {
			return INVENTORY_HAND.MAIN;
		}

		return allowed[0] ?? INVENTORY_HAND.NONE;
	}

	static preferredHand(item) {
		assertPhysicalItem(item);
		const allowed = this.allowedHands(item);
		const current = normalizeInventoryHand(item.system?.state?.hand);
		return allowed.includes(current) ? current : this.defaultHand(item);
	}

	static validate(actor, candidate, proposedHand = this.preferredHand(candidate)) {
		assertActor(actor);
		assertPhysicalItem(candidate);

		const hand = normalizeInventoryHand(proposedHand);
		const allowed = this.allowedHands(candidate);
		if (!allowed.includes(hand)) {
			return foundry.utils.deepFreeze({
				valid: false,
				hand,
				conflicts: [{
					itemUuid: String(candidate.uuid ?? ""),
					itemName: String(candidate.name ?? ""),
					message: localize(
						"This Item cannot use the selected hand slot.",
						"Ten przedmiot nie może używać wybranego układu dłoni.",
					),
				}],
			});
		}

		const requestedSlots = occupiedSlots(hand);
		if (requestedSlots.length === 0) {
			return validResult(hand);
		}

		const conflicts = [];

		for (const item of heldHandItems(actor, candidate)) {
			const existingHand = normalizeInventoryHand(item.system?.state?.hand);
			const overlap = occupiedSlots(existingHand).filter(
				(slot) => requestedSlots.includes(slot),
			);

			if (overlap.length === 0) continue;

			conflicts.push(Object.freeze({
				itemUuid: String(item.uuid ?? ""),
				itemName: String(item.name ?? ""),
				hand: existingHand,
				overlap: Object.freeze(overlap),
				message: localize(
					`Hand slot already occupied by ${item.name}.`,
					`Miejsce w dłoni jest już zajęte przez: ${item.name}.`,
				),
			}));
		}

		return conflicts.length > 0
			? foundry.utils.deepFreeze({ valid: false, hand, conflicts })
			: validResult(hand);
	}

	static nextHand(item, current, direction = 1) {
		assertPhysicalItem(item);
		const allowed = this.allowedHands(item);
		if (allowed.length <= 1) return allowed[0] ?? INVENTORY_HAND.NONE;

		const normalized = normalizeInventoryHand(current);
		const index = Math.max(0, allowed.indexOf(normalized));
		const step = Number(direction) < 0 ? -1 : 1;
		return allowed[(index + step + allowed.length) % allowed.length];
	}
}

function heldHandItems(actor, candidate) {
	return [...(actor.items ?? [])].filter((item) =>
		item?.id !== candidate.id &&
		["weapon", "armour", "equipment"].includes(item?.type) &&
		item.system?.state?.mode === INVENTORY_MODE.HELD &&
		occupiedSlots(normalizeInventoryHand(item.system?.state?.hand)).length > 0,
	);
}

function occupiedSlots(hand) {
	return HAND_OCCUPANCY[hand] ?? HAND_OCCUPANCY[INVENTORY_HAND.NONE];
}

function validResult(hand) {
	return foundry.utils.deepFreeze({
		valid: true,
		hand,
		conflicts: [],
	});
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Hand-slot validation requires an Actor.");
	}
}

function assertPhysicalItem(item) {
	if (
		!(item instanceof foundry.documents.Item) ||
		!["weapon", "armour", "equipment"].includes(item.type)
	) {
		throw new Error("Hand-slot validation requires a physical Item.");
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
