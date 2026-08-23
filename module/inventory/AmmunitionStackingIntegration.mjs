const OWNED_ITEM_DRAG_TYPE = "application/x-wfrp1ed-owned-item";

/*
 * Equipment quantities represent stacks, so identical Equipment Items should be
 * able to coalesce by drag-and-drop instead of leaving duplicate rows. This
 * module started as ammunition-only support; the identity contract is now
 * deliberately generic and stricter: name, authored Equipment system data and
 * the complete ActiveEffect definition must match. Only quantity and physical
 * storage fields are ignored because those are exactly what stacking changes.
 *
 * The handler is loaded before ClassicActorItemDragIntegration and runs in the
 * capture phase. It consumes confirmed stack merges and stackable Equipment
 * leaving a container; every unrelated drop is left to the normal inventory and
 * container implementation.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (application.isEditable !== true) return;
	const sheet = classicSheetRoot(element);
	if (!sheet || sheet.dataset.wfrpEquipmentStacking === "true") return;
	sheet.dataset.wfrpEquipmentStacking = "true";

	sheet.addEventListener("drop", (event) => {
		const marker = ownedItemDragMarker(event.dataTransfer);
		if (!isSameActorEquipmentMarker(marker, actor)) return;

		const source = ownedItemFromMarker(actor, marker);
		if (!isStackableEquipment(source)) return;

		const targetRow = event.target?.closest?.(
			".classic-inventory__row[data-item-id]",
		);
		const target = targetRow
			? actor.items?.get?.(String(targetRow.dataset.itemId ?? ""))
			: null;

		/* Container rows own capacity/compatibility adjudication. A container is
		 * never itself a stack destination. */
		if (target?.system?.isContainer === true) return;

		const explicitTarget = stackableDropTarget(source, target);
		if (explicitTarget) {
			/* Do not smuggle an Item into another container by dropping it onto a
			 * child row. Same-container merges are safe, while a top-level target
			 * is always a legal destination for a source leaving a container. */
			const sourceContainerId = containerId(source);
			const targetContainerId = containerId(explicitTarget);
			if (targetContainerId && targetContainerId !== sourceContainerId) return;
			consumeDrop(event);
			void mergeStacks(source, explicitTarget, application)
				.catch(reportStackingError);
			return;
		}

		/* Stackable Equipment leaving a container is fully owned here. This is
		 * important for ammunition too: the older generic drag integration still
		 * contains a legacy ammunition-only coalescer with a looser identity test.
		 * Consuming the drop here prevents that fallback from ever merging two
		 * stacks that fail our strict Equipment + ActiveEffect identity contract. */
		if (!containerId(source)) return;
		if (target && containerId(target)) return;
		const matchingTopLevel = topLevelMatchingStack(actor, source);

		consumeDrop(event);
		if (matchingTopLevel) {
			void mergeStacks(source, matchingTopLevel, application)
				.catch(reportStackingError);
			return;
		}
		void moveStackToTopLevel(source, application)
			.catch(reportStackingError);
	}, true);
});

function isStackableEquipment(item) {
	return Boolean(
		item instanceof foundry.documents.Item &&
		item.type === "equipment" &&
		item.system?.isContainer !== true &&
		item.system?.isWealth !== true
	);
}

function stackableDropTarget(source, target) {
	if (!isStackableEquipment(target) || target === source) return null;
	return sameStackVariant(source, target) ? target : null;
}

function topLevelMatchingStack(actor, source) {
	return [...(actor.items ?? [])].find((candidate) =>
		candidate !== source &&
		isStackableEquipment(candidate) &&
		!containerId(candidate) &&
		sameStackVariant(source, candidate)
	) ?? null;
}

/**
 * Stack identity is intentionally conservative. Two Items merge only when they
 * are the same authored Equipment definition, apart from current quantity and
 * current storage. This automatically protects ammunition variants: Arrow and
 * Special Arrow, or two Special Arrows with different ActiveEffects, remain
 * separate stacks.
 */
function sameStackVariant(first, second) {
	if (!isStackableEquipment(first) || !isStackableEquipment(second)) return false;
	if (normalizedName(first) !== normalizedName(second)) return false;
	if (equipmentSystemSignature(first) !== equipmentSystemSignature(second)) return false;
	if (itemFlagsSignature(first) !== itemFlagsSignature(second)) return false;
	return effectSignature(first) === effectSignature(second);
}

function equipmentSystemSignature(item) {
	const source = item?.toObject?.()?.system ?? {};
	const normalized = stripRuntimeMetadata(source);

	/* Quantity and physical storage are instance state, not item identity. The
	 * remaining Equipment fields (reference quantity, Encumbrance, price,
	 * availability, subtype/ammunition identity, clothing state, etc.) stay in
	 * the signature so mechanically different Items never collapse together. */
	delete normalized.quantity;
	delete normalized.containerId;
	delete normalized.storageLocation;
	delete normalized.totalEncumbrance;
	return stableStringify(normalized);
}

function itemFlagsSignature(item) {
	const flags = item?.toObject?.()?.flags ?? {};
	return stableStringify(stripRuntimeMetadata(flags));
}

function effectSignature(item) {
	const definitions = [...(item.effects ?? [])]
		.map((effect) => normalizedEffect(effect))
		.map((effect) => stableStringify(effect))
		.sort();
	return `[${definitions.join(",")}]`;
}

function normalizedEffect(effect) {
	const source = effect?.toObject?.() ?? {};
	const duration = source.duration && typeof source.duration === "object"
		? {
			/* Foundry v14 duration contract. Runtime start markers are intentionally
			 * excluded below, but authored value/units remain mechanical identity. */
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
		disabled: source.disabled === true,
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
		if ([
			"_id",
			"id",
			"origin",
			"sourceId",
			"startTime",
			"startRound",
			"startTurn",
			"updatedAt",
			"createdAt",
		].includes(key)) continue;
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
	await rerender(application);
}

async function moveStackToTopLevel(source, application) {
	await source.update({
		"system.containerId": "",
		"system.storageLocation": "",
	});
	await rerender(application);
}

async function rerender(application) {
	if (typeof application?.render !== "function") return;
	await Promise.resolve(application.render({ force: true }));
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
	console.error("WFRP1ED | Equipment stacking failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
