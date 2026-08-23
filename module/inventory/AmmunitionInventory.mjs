import {
	AMMUNITION_TYPE,
	ammunitionIdentityMatches,
} from "../data-models/item/AmmunitionTypes.mjs";
import {
	equipmentAmmunitionSnapshot,
	quickAmmunitionContainerSnapshot,
} from "../data-models/item/EquipmentData.mjs";
import {
	weaponAmmunitionSnapshot,
	weaponRangedCycleSnapshot,
} from "../data-models/item/WeaponData.mjs";

const SETTING_KEY = "trackAccessibleAmmunition";

/**
 * Optional ammunition bookkeeping layered on top of normal Equipment.
 *
 * Compatibility is type-based; the concrete Equipment Item is the ammunition
 * variant and therefore remains the owner of name, quantity and ActiveEffects.
 * Only ammunition stored directly in a matching Quick Access Ammunition
 * container is automatically available to ranged combat. Compatible reserves
 * elsewhere on the Actor are reported to the GM/player but never consumed
 * silently.
 */
export class AmmunitionInventory {
	static trackingEnabled() {
		try {
			return game.settings.get(game.system.id, SETTING_KEY) === true;
		} catch (_error) {
			return false;
		}
	}

	static weaponIdentity(weapon) {
		return weaponAmmunitionSnapshot(weapon);
	}

	static requiresExternalAmmunition(weapon) {
		const identity = this.weaponIdentity(weapon);
		return identity?.type && identity.type !== AMMUNITION_TYPE.NONE;
	}

	static isAmmunition(item) {
		return equipmentAmmunitionSnapshot(item) !== null;
	}

	static isQuickAccessContainer(item) {
		return quickAmmunitionContainerSnapshot(item) !== null;
	}

	static containerState(container) {
		const definition = quickAmmunitionContainerSnapshot(container);
		if (!definition) return null;
		const actor = itemActor(container);
		const children = actor
			? [...(actor.items ?? [])].filter((item) =>
				item?.type === "equipment" &&
				String(item.system?.containerId ?? "") === String(container.id ?? "")
			)
			: [];
		const ammunition = children.filter((item) => {
			const snapshot = equipmentAmmunitionSnapshot(item);
			return snapshot && ammunitionIdentityMatches(snapshot, definition);
		});
		const current = ammunition.reduce(
			(total, item) => total + quantity(item),
			0,
		);
		return Object.freeze({
			...definition,
			current,
			remaining: Math.max(0, definition.capacity - current),
			ammunition: Object.freeze(ammunition),
		});
	}

	static compatibleQuickContainers(actor, weaponOrIdentity) {
		const identity = identityFor(weaponOrIdentity);
		if (!actor || !identity || identity.type === AMMUNITION_TYPE.NONE) return [];
		return [...(actor.items ?? [])].filter((item) => {
			const container = quickAmmunitionContainerSnapshot(item);
			return container && ammunitionIdentityMatches(container, identity);
		});
	}

	static accessibleStacks(actor, weaponOrIdentity) {
		const identity = identityFor(weaponOrIdentity);
		if (!actor || !identity || identity.type === AMMUNITION_TYPE.NONE) return [];
		const containerIds = new Set(
			this.compatibleQuickContainers(actor, identity).map((item) => String(item.id ?? "")),
		);
		return [...(actor.items ?? [])]
			.filter((item) => {
				const ammo = equipmentAmmunitionSnapshot(item);
				return ammo &&
					quantity(item) > 0 &&
					ammunitionIdentityMatches(ammo, identity) &&
					containerIds.has(String(item.system?.containerId ?? ""));
			})
			.sort(ammunitionSort);
	}

	static reserveStacks(actor, weaponOrIdentity) {
		const identity = identityFor(weaponOrIdentity);
		if (!actor || !identity || identity.type === AMMUNITION_TYPE.NONE) return [];
		const accessible = new Set(this.accessibleStacks(actor, identity).map((item) => item.id));
		return [...(actor.items ?? [])]
			.filter((item) => {
				const ammo = equipmentAmmunitionSnapshot(item);
				return ammo &&
					quantity(item) > 0 &&
					ammunitionIdentityMatches(ammo, identity) &&
					!accessible.has(item.id);
			})
			.sort(ammunitionSort);
	}

	static fireGate(actor, weapon, runtime = null) {
		if (!this.trackingEnabled() || !this.requiresExternalAmmunition(weapon)) {
			return Object.freeze({ allowed: true, reason: "", accessible: [], reserves: [] });
		}

		const cycle = weaponRangedCycleSnapshot(weapon);
		/* Repeating/internal-magazine weapons consume the weapon magazine while
		 * firing. External ammunition is consulted only when that magazine is
		 * refilled. */
		if ((cycle?.magazineCapacity ?? 0) > 0) {
			return Object.freeze({ allowed: true, reason: "", accessible: [], reserves: [] });
		}

		const accessible = this.accessibleStacks(actor, weapon);
		const reserves = this.reserveStacks(actor, weapon);
		if (accessible.length > 0) {
			return Object.freeze({ allowed: true, reason: "", accessible, reserves });
		}

		const reason = reserves.length
			? localize(
				`No readily accessible ammunition is available. Compatible reserve ammunition exists elsewhere: ${stackSummary(reserves)}. The GM decides the time or complication required to prepare it.`,
				`Brak łatwo dostępnej amunicji. Zgodna amunicja zapasowa znajduje się w innym miejscu: ${stackSummary(reserves)}. MG rozstrzyga czas lub komplikację potrzebną do jej przygotowania.`,
			)
			: localize(
				"No readily accessible ammunition is available.",
				"Brak łatwo dostępnej amunicji.",
			);
		return Object.freeze({ allowed: false, reason, accessible, reserves });
	}

	static validateSelectedShot(actor, weapon, ammunitionUuid) {
		if (!this.trackingEnabled() || !this.requiresExternalAmmunition(weapon)) return null;
		const cycle = weaponRangedCycleSnapshot(weapon);
		if ((cycle?.magazineCapacity ?? 0) > 0) return null;
		const selected = this.accessibleStacks(actor, weapon).find(
			(item) => String(item.uuid ?? "") === String(ammunitionUuid ?? ""),
		);
		if (!selected) {
			throw new Error(localize(
				"Choose an available ammunition variant from a Quick Access Ammunition container.",
				"Wybierz dostępną odmianę amunicji z pojemnika z łatwym dostępem do amunicji.",
			));
		}
		return selected;
	}

	static async consumeSelectedShot(actor, weapon, ammunitionUuid) {
		const selected = this.validateSelectedShot(actor, weapon, ammunitionUuid);
		if (!selected) return null;
		const before = quantity(selected);
		if (before <= 0) throw new Error(localize("The selected ammunition stack is empty.", "Wybrany stos amunicji jest pusty."));
		await selected.update({ "system.quantity": before - 1 });
		return ammunitionVariantSnapshot(selected, before - 1);
	}

	static ammunitionVariantSnapshot(item, remainingQuantity = null) {
		return ammunitionVariantSnapshot(item, remainingQuantity);
	}

	static async completeMagazineRefill(actor, weapon, runtime) {
		const capacity = Math.max(0, Number(runtime?.magazineCapacity ?? 0));
		const current = Math.max(0, Number(runtime?.magazineRemaining ?? 0));
		const needed = Math.max(0, capacity - current);
		if (needed <= 0) {
			return Object.freeze({ loaded: 0, magazineRemaining: current, full: true, variant: runtime?.magazineVariant ?? null });
		}

		if (!this.trackingEnabled() || !this.requiresExternalAmmunition(weapon)) {
			return Object.freeze({ loaded: needed, magazineRemaining: capacity, full: true, variant: runtime?.magazineVariant ?? null });
		}

		const uuid = String(runtime?.magazineReloadSourceUuid ?? "");
		const source = this.accessibleStacks(actor, weapon).find((item) => item.uuid === uuid);
		if (!source) {
			return Object.freeze({ loaded: 0, magazineRemaining: current, full: false, variant: runtime?.magazineVariant ?? null });
		}
		const available = quantity(source);
		const loaded = Math.min(needed, available);
		if (loaded > 0) await source.update({ "system.quantity": available - loaded });
		return Object.freeze({
			loaded,
			magazineRemaining: current + loaded,
			full: current + loaded >= capacity,
			variant: ammunitionVariantSnapshot(source, available - loaded),
		});
	}
}

Hooks.once("i18nInit", () => {
	game.settings.register(game.system.id, SETTING_KEY, {
		name: localize("Track readily accessible ammunition", "Śledzenie łatwo dostępnej amunicji"),
		hint: localize(
			"Optional. Ranged weapons automatically consume compatible ammunition only from Quick Access Ammunition containers. Compatible reserves elsewhere are reported but never consumed without GM adjudication.",
			"Opcjonalne. Broń dystansowa automatycznie zużywa zgodną amunicję wyłącznie z pojemników z łatwym dostępem do amunicji. Zgodne zapasy w innych miejscach są zgłaszane, ale nigdy nie są zużywane bez rozstrzygnięcia MG.",
		),
		scope: "world",
		config: true,
		type: Boolean,
		default: false,
	});
});

function identityFor(value) {
	if (value?.type === "weapon") return weaponAmmunitionSnapshot(value);
	if (value && typeof value === "object" && "type" in value) return value;
	return null;
}

function itemActor(item) {
	const actor = item?.actor ?? item?.parent;
	return actor?.documentName === "Actor" ? actor : null;
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function ammunitionSort(a, b) {
	return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), game.i18n.lang, { sensitivity: "base" });
}

function stackSummary(items) {
	return items.map((item) => `${item.name} ×${quantity(item)}`).join(", ");
}

function ammunitionVariantSnapshot(item, remainingQuantity = null) {
	const identity = equipmentAmmunitionSnapshot(item);
	if (!identity) return null;
	const effects = [...(item.effects ?? [])]
		.filter((effect) => effect.disabled !== true)
		.map((effect) => effect.toObject());
	return Object.freeze({
		version: 2,
		uuid: String(item.uuid ?? ""),
		name: String(item.name ?? ""),
		type: identity.type,
		customId: identity.customId,
		key: identity.key,
		/* Compatibility (`key`) answers Arrow vs Bolt. Variant identity must also
		 * distinguish a normal Arrow from another Arrow carrying different
		 * ActiveEffects. It intentionally ignores embedded Effect ids/origin so
		 * split/copy stacks with the same name and mechanics remain one variant. */
		variantKey: variantKey(item, identity, effects),
		remainingQuantity: remainingQuantity === null ? quantity(item) : Math.max(0, Number(remainingQuantity) || 0),
		effects,
	});
}

function variantKey(item, identity, effects) {
	const normalizedEffects = effects.map((effect) => normalizeEffectForVariant(effect));
	return `${identity.key}|${String(item?.name ?? "").trim()}|${stableStringify(normalizedEffects)}`;
}

function normalizeEffectForVariant(effect) {
	const source = foundry.utils.deepClone(effect ?? {});
	delete source._id;
	delete source.origin;
	return source;
}

function stableStringify(value) {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
