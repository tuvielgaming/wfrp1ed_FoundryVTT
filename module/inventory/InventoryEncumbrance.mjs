import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";

const PHYSICAL_ITEM_TYPES = new Set(["equipment", "weapon", "armour"]);
const EQUIPMENT_SECTION = Object.freeze({
	EQUIPMENT: "equipment",
	WEALTH: "wealth",
});

/**
 * Canonical WFRP 1e personal Encumbrance calculations.
 *
 * Core rules:
 * - normal carrying capacity is Strength × 100 Encumbrance;
 * - every started 50 Encumbrance above capacity reduces Movement by 1;
 * - clothing worn on the character does not count toward personal Encumbrance;
 *   clothing carried in a bag/container does count.
 *
 * Free-text storageLocation is deliberately descriptive only. Mechanical load
 * changes must come from explicit inventory state/relationships, never from a
 * localized or user-entered string such as "horse" or "home".
 */
export class InventoryEncumbrance {
	static itemStack(item) {
		if (!isPhysicalItem(item)) return 0;

		if (item.type === "equipment") {
			return nonNegativeNumber(
				item.system?.totalEncumbrance ?? item.system?.encumbrance,
			);
		}

		return nonNegativeInteger(item.system?.quantity, 1) *
			nonNegativeNumber(item.system?.encumbrance);
	}

	/**
	 * Encumbrance this Item contributes to the owning character's carried load.
	 *
	 * A real container relationship means the Item is physically carried inside
	 * another Item, so even a Clothing Item with stale `worn` state must count.
	 */
	static itemLoad(item, actor = item?.actor ?? item?.parent) {
		const stack = this.itemStack(item);
		if (stack <= 0) return 0;

		if (
			item?.type === "equipment" &&
			item.system?.isClothing === true &&
			String(item.system?.state?.mode ?? "") === INVENTORY_MODE.WORN &&
			!hasValidContainer(item, actor)
		) {
			return 0;
		}

		return stack;
	}

	/**
	 * Sum ordinary Equipment exactly as it is physically grouped on the Classic
	 * sheet. Nested Items inherit the section of their top-level container, so a
	 * Wealth Item placed inside an Equipment backpack contributes to Ekwipunek
	 * until it is removed from that container.
	 */
	static equipmentSectionTotal(actor, section = EQUIPMENT_SECTION.EQUIPMENT) {
		assertActor(actor);
		const wealth = normalizeSection(section) === EQUIPMENT_SECTION.WEALTH;
		const byId = equipmentMap(actor);
		let total = 0;

		for (const item of byId.values()) {
			const root = topLevelContainerRoot(item, byId);
			if (Boolean(root.system?.isWealth) !== wealth) continue;
			total += this.itemLoad(item, actor);
		}

		return total;
	}

	static evaluate(actor) {
		assertActor(actor);
		let load = 0;
		for (const item of actor.items ?? []) {
			if (!isPhysicalItem(item)) continue;
			load += this.itemLoad(item, actor);
		}

		const strength = characteristicValue(actor, "s");
		const baseMovement = characteristicValue(actor, "m");
		const capacity = strength * 100;
		const excess = Math.max(0, load - capacity);
		const movementPenalty = excess > 0
			? Math.ceil(excess / 50)
			: 0;
		const effectiveMovement = Math.max(0, baseMovement - movementPenalty);

		return Object.freeze({
			load,
			capacity,
			excess,
			overloaded: excess > 0,
			movementPenalty,
			baseMovement,
			effectiveMovement,
			equipment: this.equipmentSectionTotal(actor, EQUIPMENT_SECTION.EQUIPMENT),
			wealth: this.equipmentSectionTotal(actor, EQUIPMENT_SECTION.WEALTH),
		});
	}
}

function isPhysicalItem(item) {
	return item instanceof foundry.documents.Item && PHYSICAL_ITEM_TYPES.has(item.type);
}

function characteristicValue(actor, id) {
	if (typeof actor?.getCharacteristicValue === "function") {
		const value = Number(actor.getCharacteristicValue(id));
		return Number.isFinite(value) ? Math.max(0, value) : 0;
	}

	const value = Number(actor?.system?.characteristics?.[id]?.current);
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function equipmentMap(actor) {
	return new Map(
		[...(actor?.items ?? [])]
			.filter((item) => item?.type === "equipment")
			.map((item) => [String(item.id ?? ""), item]),
	);
}

function hasValidContainer(item, actor) {
	if (item?.type !== "equipment") return false;
	const byId = equipmentMap(actor);
	return Boolean(validParent(item, byId));
}

function topLevelContainerRoot(item, byId) {
	let current = item;
	const seen = new Set();

	while (current) {
		const currentId = String(current.id ?? "");
		if (!currentId || seen.has(currentId)) return item;
		seen.add(currentId);

		const parent = validParent(current, byId);
		if (!parent) return current;
		current = parent;
	}

	return item;
}

function validParent(item, byId) {
	const parentId = String(item?.system?.containerId ?? "").trim();
	if (!parentId) return null;
	const parent = byId.get(parentId);
	if (!parent || parent.system?.isContainer !== true) return null;
	if (String(parent.id ?? "") === String(item.id ?? "")) return null;
	return parent;
}

function normalizeSection(value) {
	return String(value ?? "").trim().toLowerCase() === EQUIPMENT_SECTION.WEALTH
		? EQUIPMENT_SECTION.WEALTH
		: EQUIPMENT_SECTION.EQUIPMENT;
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Encumbrance calculation requires an Actor document.");
	}
}

function nonNegativeInteger(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.max(0, Math.trunc(number))
		: Math.max(0, Math.trunc(Number(fallback) || 0));
}

function nonNegativeNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, number) : 0;
}
