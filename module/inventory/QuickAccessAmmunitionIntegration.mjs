import { LootPileService } from "../loot/LootPileService.mjs";
import { AmmunitionInventory } from "./AmmunitionInventory.mjs";

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor") return;
	const sheet = classicSheetRoot(element);
	if (!sheet) return;

	decorateQuickAccessRows(sheet, actor, application);
	installQuickAccessMutationObserver(sheet, actor, application);
});

Hooks.on("createItem", (item) => refreshQuickContainerActor(item));
Hooks.on("updateItem", (item) => refreshQuickContainerActor(item));
Hooks.on("deleteItem", (item) => refreshQuickContainerActor(item));

function decorateQuickAccessRows(root, actor, application) {
	for (const row of root.querySelectorAll(".classic-inventory__row[data-item-id]")) {
		const container = actor.items?.get?.(String(row.dataset.itemId ?? ""));
		if (!AmmunitionInventory.isQuickAccessContainer(container)) continue;
		decorateCapacity(row, container);
		installCapacityDropTarget(row, actor, container, application);
	}
}

/**
 * ClassicInventoryIntegration rebuilds only the inventory host for interactions
 * such as expand/collapse and quantity/location edits. Those partial renders do
 * not fire renderApplicationV2 again, so any presentation decorator attached
 * only to the application render would disappear until the whole Actor sheet
 * was reopened. Observe only the inventory hosts and reapply this integration
 * after their DOM is rebuilt.
 */
function installQuickAccessMutationObserver(root, actor, application) {
	if (root.__wfrpQuickAccessAmmunitionObserver) return;

	const hosts = [...root.querySelectorAll("[data-wfrp1ed-inventory]")];
	if (!hosts.length) return;

	let queued = false;
	const observer = new MutationObserver(() => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			decorateQuickAccessRows(root, actor, application);
		});
	});
	for (const host of hosts) observer.observe(host, { childList: true, subtree: true });
	Object.defineProperty(root, "__wfrpQuickAccessAmmunitionObserver", {
		value: observer,
		configurable: true,
	});
}

function decorateCapacity(row, container) {
	const state = AmmunitionInventory.containerState(container);
	if (!state) return;

	decorateContainerName(row, container, state);

	const capacityText = `${state.current}/${state.capacity}`;
	const capacityTitle = localize(
		`Quick-access ammunition: ${capacityText}`,
		`Amunicja z łatwym dostępem: ${capacityText}`,
	);
	const existing = row.querySelector("[data-wfrp-ammunition-capacity]");
	if (existing) {
		if (existing.textContent !== capacityText) existing.textContent = capacityText;
		existing.title = capacityTitle;
		return;
	}

	const quantityControl = row.querySelector(".classic-inventory__quantity");
	if (!quantityControl) return;

	/* A Quick Access container is one concrete storage Item, so its ordinary
	 * Equipment-stack quantity is not useful in the compact inventory row. Use
	 * that same slot for its mechanically relevant ammunition capacity instead
	 * of adding a second badge beside the quantity control. */
	const capacity = document.createElement("span");
	capacity.className = "classic-inventory__ammunition-capacity";
	capacity.dataset.wfrpAmmunitionCapacity = "";
	capacity.textContent = capacityText;
	capacity.title = capacityTitle;
	quantityControl.replaceWith(capacity);
}

function decorateContainerName(row, container, state) {
	const ammunitionLabel = ammunitionTypeLabel(state);
	const name = row.querySelector(".classic-inventory__name");
	if (!name) return;

	const rawName = String(container.name ?? "");
	const fullDisplayName = ammunitionLabel ? `${rawName} (${ammunitionLabel})` : rawName;
	name.title = fullDisplayName;
	if (!ammunitionLabel) {
		if (name.textContent !== rawName) name.textContent = rawName;
		name.classList.remove("classic-inventory__name--quick-ammunition");
		return;
	}

	name.classList.add("classic-inventory__name--quick-ammunition");
	let primary = name.querySelector("[data-wfrp-quick-ammo-primary]");
	let specialisation = name.querySelector("[data-wfrp-quick-ammo-specialisation]");
	if (!primary || !specialisation) {
		primary = document.createElement("span");
		primary.className = "classic-inventory__name-primary";
		primary.dataset.wfrpQuickAmmoPrimary = "";
		specialisation = document.createElement("span");
		specialisation.className = "classic-inventory__name-specialisation";
		specialisation.dataset.wfrpQuickAmmoSpecialisation = "";
		name.replaceChildren(primary, specialisation);
	}
	if (primary.textContent !== rawName) primary.textContent = rawName;
	const specialisationText = `(${ammunitionLabel})`;
	if (specialisation.textContent !== specialisationText) {
		specialisation.textContent = specialisationText;
	}
}

function installCapacityDropTarget(row, actor, container, application) {
	if (row.dataset.wfrpQuickAmmoDrop === "true") return;
	row.dataset.wfrpQuickAmmoDrop = "true";

	row.addEventListener("dragover", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		row.classList.add("is-ammunition-drop-target");
	}, true);

	row.addEventListener("dragleave", (event) => {
		if (!row.contains(event.relatedTarget)) row.classList.remove("is-ammunition-drop-target");
	}, true);

	row.addEventListener("drop", (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		row.classList.remove("is-ammunition-drop-target");
		void handleDrop(event, actor, container, application).catch((error) => {
			console.error("WFRP1ED | Quick-access ammunition drop failed.", error);
			ui.notifications.error(error?.message ?? String(error));
		});
	}, true);
}

async function handleDrop(event, actor, container, application) {
	const data = foundry.applications.ux.TextEditor.getDragEventData(event);
	if (String(data?.type ?? "") !== "Item") return;
	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return;
	const source = await foundry.utils.fromUuid(uuid);
	if (!(source instanceof foundry.documents.Item) || source.type !== "equipment") {
		throw new Error(localize(
			"Quick Access Ammunition containers accept only Ammunition Equipment.",
			"Pojemniki z łatwym dostępem do amunicji przyjmują wyłącznie Ekwipunek typu Amunicja.",
		));
	}
	assertCompatible(container, source);

	/* Dragging a stack onto the container which already owns it is a no-op. The
	 * stack already counts against capacity; treating it as incoming ammunition
	 * would make the current contents look like overflow and could split the same
	 * Item into duplicate stacks. */
	if (
		source.parent === actor &&
		String(source.system?.containerId ?? "") === String(container.id ?? "")
	) return;

	const state = AmmunitionInventory.containerState(container);
	if (!state || state.remaining <= 0) {
		throw new Error(localize("This ammunition container is full.", "Ten pojemnik na amunicję jest pełny."));
	}

	let owned = source;
	let overflowDestination = "origin";
	if (source.parent === actor) {
		/* same Actor: leave overflow exactly where it was */
	} else if (LootPileService.isLootPile(source.parent)) {
		const result = await LootPileService.takeItem(source.parent, source, actor, { containerId: "" });
		owned = actor.items?.get?.(String(result?.itemId ?? ""));
		overflowDestination = "top";
	} else if (source.pack || !(source.parent instanceof foundry.documents.Actor)) {
		owned = await createActorEquipmentCopy(source, actor);
		overflowDestination = "top";
	} else {
		throw new Error(localize(
			"This Equipment cannot be moved into the ammunition container from its current owner.",
			"Nie można przenieść tego Ekwipunku do pojemnika na amunicję od jego obecnego właściciela.",
		));
	}

	if (!(owned instanceof foundry.documents.Item)) {
		throw new Error(localize("The ammunition could not be transferred.", "Nie udało się przenieść amunicji."));
	}
	assertCompatible(container, owned);

	const amount = quantity(owned);
	const accepted = Math.min(amount, state.remaining);
	const overflow = Math.max(0, amount - accepted);
	if (accepted <= 0) return;

	const matching = matchingAmmunitionStack(actor, owned, String(container.id ?? ""));
	if (matching) {
		await matching.update({
			"system.quantity": quantity(matching) + accepted,
		});
		if (overflow === 0) {
			await owned.delete();
		} else {
			await owned.update({
				"system.quantity": overflow,
				...(overflowDestination === "top" ? {
					"system.containerId": "",
					"system.storageLocation": "",
				} : {}),
			});
		}
	} else if (overflow === 0) {
		await owned.update({
			"system.containerId": String(container.id ?? ""),
			"system.storageLocation": String(container.name ?? ""),
		});
	} else {
		/* Keep the source stack as overflow. For external sources it is already at
		 * Actor top level; for same-Actor movement it stays in its original place. */
		await owned.update({
			"system.quantity": overflow,
			...(overflowDestination === "top" ? {
				"system.containerId": "",
				"system.storageLocation": "",
			} : {}),
		});
		const sourceData = owned.toObject();
		delete sourceData._id;
		delete sourceData.folder;
		delete sourceData.ownership;
		sourceData.system ??= {};
		sourceData.system.quantity = accepted;
		sourceData.system.containerId = String(container.id ?? "");
		sourceData.system.storageLocation = String(container.name ?? "");
		await actor.createEmbeddedDocuments("Item", [sourceData]);
	}

	if (overflow > 0) {
		ui.notifications.info(localize(
			`Stored ${accepted}; ${overflow} remained outside because ${container.name} reached capacity.`,
			`Umieszczono ${accepted}; ${overflow} pozostało poza pojemnikiem, ponieważ ${container.name} osiągnął pojemność.`,
		));
	}

	await Promise.resolve(application?.render?.({ force: true }));
}

function assertCompatible(container, ammunition) {
	const containerState = AmmunitionInventory.containerState(container);
	const ammo = ammunition?.type === "equipment"
		? ammunition.system
		: null;
	if (!containerState || !AmmunitionInventory.isAmmunition(ammunition)) {
		throw new Error(localize(
			"This Item is not ammunition compatible with the container.",
			"Ten przedmiot nie jest amunicją zgodną z pojemnikiem.",
		));
	}
	const identity = {
		type: ammo?.ammunitionType,
		customId: ammo?.ammunitionCustomId,
	};
	if (containerState.key !== ammunitionKey(identity)) {
		throw new Error(localize(
			"This ammunition type does not match the Quick Access container.",
			"Ten typ amunicji nie pasuje do pojemnika z łatwym dostępem.",
		));
	}
}

function matchingAmmunitionStack(actor, source, containerId) {
	const sourceSnapshot = AmmunitionInventory.ammunitionVariantSnapshot(source);
	if (!sourceSnapshot?.variantKey) return null;
	return [...(actor.items ?? [])].find((candidate) => {
		if (
			candidate?.type !== "equipment" ||
			candidate.id === source.id ||
			String(candidate.system?.containerId ?? "") !== String(containerId ?? "")
		) return false;
		const candidateSnapshot = AmmunitionInventory.ammunitionVariantSnapshot(candidate);
		return candidateSnapshot?.variantKey === sourceSnapshot.variantKey;
	}) ?? null;
}

function ammunitionTypeLabel(state) {
	switch (String(state?.type ?? "")) {
		case "arrow": return localize("arrows", "strzały");
		case "bolt": return localize("bolts", "bełty");
		case "sling": return localize("sling ammunition", "pociski do procy");
		case "firearmLoad": return localize("firearm loads", "ładunki broni palnej");
		case "custom": return String(state?.customId ?? "").trim() ||
			localize("custom ammunition", "inna amunicja");
		default: return "";
	}
}

function ammunitionKey(identity) {
	const type = String(identity?.type ?? "");
	return type === "custom"
		? `custom:${String(identity?.customId ?? "").trim().toLowerCase().replace(/\s+/g, "-")}`
		: type;
}

async function createActorEquipmentCopy(source, actor) {
	const data = source.toObject();
	delete data._id;
	delete data.folder;
	delete data.ownership;
	data.system ??= {};
	data.system.containerId = "";
	data.system.storageLocation = "";
	const [created] = await actor.createEmbeddedDocuments("Item", [data]);
	return created ?? null;
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function refreshQuickContainerActor(item) {
	const actor = item?.actor ?? item?.parent;
	if (actor?.documentName === "Actor" && actor.sheet?.rendered) {
		void actor.sheet.render({ force: true });
	}
}

function classicSheetRoot(root) {
	if (root?.matches?.(".wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
