import { AmmunitionInventory } from "./AmmunitionInventory.mjs";

const OWNED_ITEM_DRAG_TYPE = "application/x-wfrp1ed-owned-item";

/*
 * Ammunition is a stackable Equipment subtype. ClassicActorItemDragIntegration
 * owns the generic move/container behaviour, but historically a drop anywhere
 * outside a container only changed location: dropping one ammunition stack onto
 * another never merged them. Install this capture handler before the generic
 * inventory drag integration so matching ammunition can consume the gesture
 * first, while every non-stack drop continues through the normal path.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (application.isEditable !== true) return;
	const sheet = classicSheetRoot(element);
	if (!sheet || sheet.dataset.wfrpAmmunitionStacking === "true") return;
	sheet.dataset.wfrpAmmunitionStacking = "true";

	sheet.addEventListener("drop", (event) => {
		const marker = ownedItemDragMarker(event.dataTransfer);
		if (!isSameActorEquipmentMarker(marker, actor)) return;

		const source = ownedItemFromMarker(actor, marker);
		if (!AmmunitionInventory.isAmmunition(source)) return;

		const targetRow = event.target?.closest?.(
			".classic-inventory__row[data-item-id]",
		);
		const target = targetRow
			? actor.items?.get?.(String(targetRow.dataset.itemId ?? ""))
			: null;

		/* A container row owns capacity/compatibility adjudication. Never bypass
		 * that path by treating the container itself as a stacking destination. */
		if (target?.system?.isContainer === true) return;

		const explicitTarget = stackableDropTarget(source, target);
		if (explicitTarget) {
			/* Moving onto a stack inside another container would bypass that
			 * container's capacity rules. Same-container merges are safe, and a
			 * top-level target is always a legal destination. */
			const sourceContainerId = containerId(source);
			const targetContainerId = containerId(explicitTarget);
			if (targetContainerId && targetContainerId !== sourceContainerId) return;
			consumeDrop(event);
			void mergeStacks(source, explicitTarget, application)
				.catch(reportStackingError);
			return;
		}

		/* Dropping ammunition out of a container onto empty/top-level inventory
		 * should also coalesce with an already-existing equivalent reserve stack.
		 * If there is no match, do nothing here and let the generic integration
		 * perform its normal move-to-top-level operation. */
		if (!containerId(source)) return;
		if (target && containerId(target)) return;
		const matchingTopLevel = topLevelMatchingStack(actor, source);
		if (!matchingTopLevel) return;

		consumeDrop(event);
		void mergeStacks(source, matchingTopLevel, application)
			.catch(reportStackingError);
	}, true);
});

function stackableDropTarget(source, target) {
	if (!(target instanceof foundry.documents.Item) || target === source) return null;
	if (!AmmunitionInventory.isAmmunition(target)) return null;
	return sameStackVariant(source, target) ? target : null;
}

function topLevelMatchingStack(actor, source) {
	return [...(actor.items ?? [])].find((candidate) =>
		candidate !== source &&
		AmmunitionInventory.isAmmunition(candidate) &&
		!containerId(candidate) &&
		sameStackVariant(source, candidate)
	) ?? null;
}

function sameStackVariant(first, second) {
	const firstSnapshot = AmmunitionInventory.ammunitionVariantSnapshot(first);
	const secondSnapshot = AmmunitionInventory.ammunitionVariantSnapshot(second);
	if (!firstSnapshot || !secondSnapshot) return false;
	if (firstSnapshot.key !== secondSnapshot.key) return false;
	if (normalizedName(first) !== normalizedName(second)) return false;

	/* Prefer the strict ammunition identity when it already agrees. The fallback
	 * below deliberately ignores only runtime ActiveEffect identity/timing data
	 * (embedded ids, origins and start markers) so copied/split instances of the
	 * same authored special ammunition still stack. Mechanical changes, effect
	 * system data, statuses and duration limits remain part of the signature. */
	if (firstSnapshot.variantKey === secondSnapshot.variantKey) return true;
	return effectSignature(first) === effectSignature(second);
}

function effectSignature(item) {
	const definitions = [...(item.effects ?? [])]
		.filter((effect) => effect.disabled !== true)
		.map((effect) => normalizedEffect(effect))
		.map((effect) => stableStringify(effect))
		.sort();
	return `[${definitions.join(",")}]`;
}

function normalizedEffect(effect) {
	const source = effect?.toObject?.() ?? {};
	const duration = source.duration && typeof source.duration === "object"
		? {
			/* Foundry v14 replaced the legacy seconds/rounds/turns accessors with
			 * a canonical value + units pair. Compare only that authored duration
			 * contract so stacking never touches deprecated compatibility getters. */
			value: nullableNumber(source.duration.value),
			units: String(source.duration.units ?? ""),
		}
		: null;
	const changes = [...(source.changes ?? [])]
		.map((change) => ({
			key: String(change?.key ?? ""),
			mode: Number(change?.mode ?? 0),
			value: change?.value ?? "",
			priority: nullableNumber(change?.priority),
		}))
		.map((change) => stableStringify(change))
		.sort();
	const statuses = [...(source.statuses ?? [])].map(String).sort();

	return {
		name: String(source.name ?? ""),
		type: String(source.type ?? ""),
		transfer: source.transfer === true,
		duration,
		changes,
		statuses,
		system: source.system && typeof source.system === "object"
			? stripRuntimeMetadata(source.system)
			: {},
		flags: source.flags && typeof source.flags === "object"
			? stripRuntimeMetadata(source.flags)
			: {},
	};
}

function stripRuntimeMetadata(value) {
	if (Array.isArray(value)) return value.map((entry) => stripRuntimeMetadata(entry));
	if (!value || typeof value !== "object") return value;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (["_id", "id", "origin", "sourceId", "startTime", "startRound", "startTurn", "updatedAt", "createdAt"].includes(key)) continue;
		result[key] = stripRuntimeMetadata(entry);
	}
	return result;
}

async function mergeStacks(source, target, application) {
	const sourceQuantity = quantity(source);
	if (sourceQuantity <= 0) return;
	await target.update({
		"system.quantity": quantity(target) + sourceQuantity,
	});
	await source.delete();
	if (typeof application?.render === "function") {
		await Promise.resolve(application.render({ force: true }));
	}
}

function ownedItemFromMarker(actor, marker) {
	const uuid = String(marker?.itemUuid ?? "").trim();
	if (!uuid) return null;
	return [...(actor.items ?? [])].find(
		(item) => String(item?.uuid ?? "") === uuid,
	) ?? null;
}

function ownedItemDragMarker(dataTransfer) {
	if (!dataTransfer) return null;
	try {
		const raw = dataTransfer.getData(OWNED_ITEM_DRAG_TYPE);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch (_error) {
		return null;
	}
}

function isSameActorEquipmentMarker(marker, actor) {
	return Boolean(
		marker &&
		String(marker.actorUuid ?? "") === String(actor?.uuid ?? "") &&
		String(marker.itemType ?? "") === "equipment"
	);
}

function consumeDrop(event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}

function containerId(item) {
	return String(item?.system?.containerId ?? "").trim();
}

function normalizedName(item) {
	return String(item?.name ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function nullableNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
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

function classicSheetRoot(root) {
	if (root?.matches?.(".wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function reportStackingError(error) {
	console.error("WFRP1ED | Ammunition stacking failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
