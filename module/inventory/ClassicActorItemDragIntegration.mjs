import { LootPileService } from "../loot/LootPileService.mjs";

const OWNED_ITEM_DRAG_TYPE = "application/x-wfrp1ed-owned-item";

const HELP_TEXT = Object.freeze({
	en: "Quantity: left/right click changes by 1; Shift/Ctrl/Cmd changes by 10; double-click to type. Double-click LOC to type a location or choose a container. Drag Equipment owned by this character, or Equipment from Loot, directly onto a container to store it there. Drag an Item out of a container and drop it anywhere else on this character sheet to return it to the top level. Drag physical Items onto empty chat to create a Loot Pile, or onto an existing Loot card to add them to that pile. Items taken from Loot return to the top level unless they are dropped directly onto a container. Use the arrow to expand containers. Hover a row to reveal Delete. Scroll the list when it is full.",
	pl: "Ilość: lewy/prawy klik zmienia o 1; Shift/Ctrl/Cmd zmienia o 10; dwuklik pozwala wpisać wartość. Dwuklik LOK pozwala wpisać lokalizację lub wybrać pojemnik. Przeciągnij Ekwipunek należący do tej postaci albo Ekwipunek z Łupu bezpośrednio na pojemnik, aby go w nim umieścić. Przeciągnij przedmiot z pojemnika i upuść go w dowolnym innym miejscu tej karty postaci, aby przenieść go na poziom główny. Przeciągnij fizyczny przedmiot na pusty obszar czatu, aby utworzyć stos łupu, albo na istniejącą kartę łupu, aby dodać go do tego stosu. Przedmioty podniesione z Łupu wracają na poziom główny, chyba że zostaną upuszczone bezpośrednio na pojemnik. Strzałka rozwija pojemniki. Usuń pojawia się po najechaniu na wiersz. Po zapełnieniu listę można przewijać.",
});

Hooks.on("renderApplicationV2", (application, element) => {
	const root = asElement(element);
	if (!root) return;

	if (isChatApplication(application, root)) {
		installChatLootDropTarget(root);
	}

	const actor = application?.document;
	if (
		!(actor instanceof foundry.documents.Actor) ||
		!classicSheetRoot(root)
	) return;

	installInventoryHelp(root);

	if (application.isEditable !== true) return;
	installItemDragSources(root, actor);
	installContainerDropTargets(root, actor, application);
	installSheetTopLevelDropTarget(root, actor, application);
	installInventoryMutationObserver(root, actor, application);
});

/* Compatibility hook for the ChatLog presentation path. ApplicationV2 also
 * reaches this code in Foundry v14, but keeping the named Chat hook makes the
 * empty-chat drop target resilient to detached/popout chat rendering. */
Hooks.on("renderChatLog", (application, html) => {
	const root = asElement(html);
	if (root) installChatLootDropTarget(root);
});

/**
 * Make every rendered embedded Item row on the Classic Actor sheet a standard
 * Foundry Item drag source. This is intentionally Item-type agnostic: weapons,
 * armour, equipment, skills, and future Item-backed panels all use the same
 * drag payload instead of each panel inventing its own behaviour.
 */
function installItemDragSources(root, actor) {
	for (const item of actor.items ?? []) {
		const surface = dragSurfaceForItem(root, item.id);
		if (!(surface instanceof HTMLElement)) continue;
		if (surface.dataset.wfrpItemDragSource === "true") continue;

		surface.draggable = true;
		surface.dataset.wfrpItemDragSource = "true";
		surface.dataset.itemId = String(item.id ?? "");
		surface.dataset.itemUuid = String(item.uuid ?? "");

		/* Native image dragging can steal the drag gesture from the containing
		 * Item row. Let the row own the gesture so grabbing either the image,
		 * name, or another non-control part produces the same Item payload. */
		for (const image of surface.querySelectorAll("img")) image.draggable = false;

		surface.addEventListener("dragstart", (event) => {
			if (interactiveDragOrigin(event.target, surface)) {
				event.preventDefault();
				return;
			}

			const current = actor.items?.get?.(String(surface.dataset.itemId ?? ""));
			if (!(current instanceof foundry.documents.Item)) {
				event.preventDefault();
				return;
			}
			const data = current.toDragData();
			const serialized = JSON.stringify(data);
			const ownedMarker = JSON.stringify({
				actorUuid: String(actor.uuid ?? ""),
				itemUuid: String(current.uuid ?? ""),
				itemType: String(current.type ?? ""),
			});
			event.dataTransfer?.setData("text/plain", serialized);
			event.dataTransfer?.setData("application/json", serialized);
			event.dataTransfer?.setData(OWNED_ITEM_DRAG_TYPE, ownedMarker);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
		});
	}
}

/**
 * Equipment containers are direct drop targets. The payload remains standard
 * Foundry Item drag data so the same drag gesture also works with Loot Piles
 * and other normal Foundry Item drop consumers.
 */
function installContainerDropTargets(root, actor, application) {
	for (const row of root.querySelectorAll(".classic-inventory__row[data-item-id]")) {
		if (!(row instanceof HTMLElement)) continue;
		if (row.dataset.wfrpContainerDropTarget === "true") continue;

		const target = actor.items?.get?.(String(row.dataset.itemId ?? ""));
		if (
			!(target instanceof foundry.documents.Item) ||
			target.type !== "equipment" ||
			target.system?.isContainer !== true
		) continue;

		row.dataset.wfrpContainerDropTarget = "true";

		row.addEventListener("dragover", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setContainerDropHighlight(row, true);
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		});

		row.addEventListener("dragleave", (event) => {
			if (row.contains(event.relatedTarget)) return;
			setContainerDropHighlight(row, false);
		});

		row.addEventListener("drop", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setContainerDropHighlight(row, false);
			void placeDroppedEquipmentInContainer(
				event,
				actor,
				target,
				application,
			).catch(reportInventoryDropError);
		});
	}
}

/**
 * The rest of the Classic sheet acts as the inverse of a container target.
 * A same-character Equipment drag that does not land on a container returns
 * that Item to the root inventory level. World/sidebar and Loot drags keep the
 * normal Foundry/loot drop paths because they do not carry this same-Actor marker.
 */
function installSheetTopLevelDropTarget(root, actor, application) {
	const sheet = classicSheetRoot(root);
	if (!sheet || sheet.dataset.wfrpTopLevelDropTarget === "true") return;
	sheet.dataset.wfrpTopLevelDropTarget = "true";

	sheet.addEventListener("dragover", (event) => {
		if (event.target?.closest?.(".classic-inventory__row[data-wfrp-container-drop-target='true']")) {
			return;
		}
		const marker = ownedItemDragMarker(event.dataTransfer);
		if (!isSameActorEquipmentMarker(marker, actor)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
	}, true);

	sheet.addEventListener("drop", (event) => {
		if (event.target?.closest?.(".classic-inventory__row[data-wfrp-container-drop-target='true']")) {
			return;
		}
		const marker = ownedItemDragMarker(event.dataTransfer);
		if (!isSameActorEquipmentMarker(marker, actor)) return;

		event.preventDefault();
		event.stopImmediatePropagation();
		void moveOwnedEquipmentToTopLevel(marker, actor, application)
			.catch(reportInventoryDropError);
	}, true);
}

async function moveOwnedEquipmentToTopLevel(marker, actor, application) {
	const uuid = String(marker?.itemUuid ?? "").trim();
	if (!uuid) return;
	const item = await foundry.utils.fromUuid(uuid);
	if (
		!(item instanceof foundry.documents.Item) ||
		item.type !== "equipment" ||
		item.parent !== actor
	) return;

	const containerId = String(item.system?.containerId ?? "").trim();
	if (!containerId) return;

	await item.update({
		"system.containerId": "",
		"system.storageLocation": "",
	});
	await rerenderActorSheet(application);
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

async function placeDroppedEquipmentInContainer(event, actor, container, application) {
	const data = foundry.applications.ux.TextEditor.getDragEventData(event);
	if (String(data?.type ?? "") !== "Item") return;

	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return;
	const item = await foundry.utils.fromUuid(uuid);
	if (!(item instanceof foundry.documents.Item)) return;

	if (item.type !== "equipment") {
		throw new Error(localize(
			"Only ordinary Equipment can currently be placed inside Equipment containers. Weapon and Armour container support will be audited with those Item types.",
			"Obecnie w pojemnikach można umieszczać tylko zwykły Ekwipunek. Obsługa Broni i Pancerza w pojemnikach zostanie sprawdzona podczas audytu tych typów przedmiotów.",
		));
	}

	if (item.parent === actor) {
		if (!canPlaceInContainer(item, container, actor)) {
			throw new Error(localize(
				"That drop would create an invalid or circular container relationship.",
				"To przeniesienie utworzyłoby nieprawidłową lub zapętloną relację pojemników.",
			));
		}

		if (String(item.system?.containerId ?? "") === String(container.id ?? "")) {
			return;
		}

		await item.update({
			"system.containerId": String(container.id ?? ""),
			"system.storageLocation": String(container.name ?? ""),
		});
	} else if (LootPileService.isLootPile(item.parent)) {
		await LootPileService.takeItem(item.parent, item, actor, {
			containerId: String(container.id ?? ""),
		});
	} else {
		throw new Error(localize(
			"Drag Equipment owned by this character or Equipment from a Loot Pile onto the container.",
			"Na pojemnik przeciągnij Ekwipunek należący do tej postaci albo Ekwipunek ze stosu łupu.",
		));
	}

	await rerenderActorSheet(application);
	autoExpandContainer(application, container.id);
}

function canPlaceInContainer(item, container, actor) {
	if (
		item?.type !== "equipment" ||
		container?.type !== "equipment" ||
		container.system?.isContainer !== true
	) return false;

	const itemId = String(item.id ?? "");
	const containerId = String(container.id ?? "");
	if (!itemId || !containerId || itemId === containerId) return false;

	const seen = new Set();
	let current = container;
	while (current instanceof foundry.documents.Item) {
		const currentId = String(current.id ?? "");
		if (!currentId || seen.has(currentId)) return false;
		if (currentId === itemId) return false;
		seen.add(currentId);

		const parentId = String(current.system?.containerId ?? "").trim();
		if (!parentId) return true;
		current = actor.items?.get?.(parentId);
		if (!(current instanceof foundry.documents.Item)) return true;
	}
	return true;
}

async function rerenderActorSheet(application) {
	if (typeof application?.render !== "function") return;
	await Promise.resolve(application.render({ force: true }));
}

function autoExpandContainer(application, containerId) {
	requestAnimationFrame(() => {
		const root = asElement(application?.element);
		if (!root) return;
		const escaped = CSS.escape(String(containerId ?? ""));
		const row = root.querySelector(`.classic-inventory__row[data-item-id="${escaped}"]`);
		const toggle = row?.querySelector?.(".classic-inventory__container-toggle");
		if (
			toggle instanceof HTMLButtonElement &&
			!toggle.disabled &&
			toggle.getAttribute("aria-expanded") !== "true"
		) toggle.click();
	});
}

function setContainerDropHighlight(row, active) {
	if (!(row instanceof HTMLElement)) return;
	if (active) {
		row.style.outline = "1px dashed rgb(91 63 34 / 85%)";
		row.style.outlineOffset = "-2px";
		return;
	}
	row.style.removeProperty("outline");
	row.style.removeProperty("outline-offset");
}

/** Keep enhancements alive when ClassicInventoryIntegration rebuilds only one
 * inventory host instead of rerendering the whole Actor sheet. */
function installInventoryMutationObserver(root, actor, application) {
	const sheet = classicSheetRoot(root);
	if (!sheet || sheet.__wfrpInventoryEnhancementObserver) return;

	let queued = false;
	const observer = new MutationObserver(() => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			installInventoryHelp(root);
			installItemDragSources(root, actor);
			installContainerDropTargets(root, actor, application);
		});
	});
	observer.observe(sheet, { childList: true, subtree: true });
	Object.defineProperty(sheet, "__wfrpInventoryEnhancementObserver", {
		value: observer,
		configurable: true,
	});
}

/** Add one small localized ? marker to each Equipment/Wealth toolbar. */
function installInventoryHelp(root) {
	for (const toolbar of root.querySelectorAll(".classic-inventory__toolbar")) {
		if (toolbar.querySelector(".classic-inventory__help")) continue;

		const marker = document.createElement("span");
		marker.className = "classic-inventory__create classic-inventory__help";
		marker.tabIndex = 0;
		marker.setAttribute("role", "img");
		marker.setAttribute("aria-label", localize("Inventory help", "Pomoc ekwipunku"));
		marker.title = localizedHelpText();
		marker.dataset.tooltip = localizedHelpText();
		marker.dataset.tooltipDirection = "UP";

		const icon = document.createElement("i");
		icon.className = "fas fa-circle-question";
		icon.setAttribute("aria-hidden", "true");
		marker.append(icon);
		toolbar.append(marker);
	}
}

/** Empty chat is the creation drop target. Existing Loot cards already own
 * their own drop handlers and stop propagation, so they continue to add Items
 * to the selected existing pile instead of creating another one. */
function installChatLootDropTarget(root) {
	const surface = chatDropSurface(root);
	if (!surface || surface.dataset.wfrpLootCreationDropTarget === "true") return;
	surface.dataset.wfrpLootCreationDropTarget = "true";

	surface.addEventListener("dragover", (event) => {
		if (isChatInputTarget(event.target)) return;
		if (event.target?.closest?.("[data-wfrp-loot-card]")) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
	});

	surface.addEventListener("drop", (event) => {
		if (isChatInputTarget(event.target)) return;
		if (event.target?.closest?.("[data-wfrp-loot-card]")) return;
		event.preventDefault();
		event.stopPropagation();
		void createLootPileFromChatDrop(event).catch(reportLootDropError);
	});
}

async function createLootPileFromChatDrop(event) {
	const data = foundry.applications.ux.TextEditor.getDragEventData(event);
	if (String(data?.type ?? "") !== "Item") return;
	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return;

	const item = await foundry.utils.fromUuid(uuid);
	if (!LootPileService.isPhysicalItem(item)) {
		throw new Error(localize(
			"Only Weapon, Armour, or Equipment Items can create Loot Piles.",
			"Stos łupu można utworzyć tylko z Broni, Pancerza lub Ekwipunku.",
		));
	}

	const sourceActor = item.parent instanceof foundry.documents.Actor
		? item.parent
		: null;
	if (!sourceActor || LootPileService.isLootPile(sourceActor)) {
		throw new Error(localize(
			"Create a new Loot Pile by dragging an Item owned by a normal Actor.",
			"Nowy stos łupu utworzysz, przeciągając przedmiot należący do zwykłego Aktora.",
		));
	}

	await LootPileService.createFromActorItems({
		sourceActor,
		items: [item],
		reason: localize("Dropped to chat", "Upuszczono na czat"),
		sourceLabel: String(sourceActor.name ?? ""),
	});
}

function chatDropSurface(root) {
	return root.querySelector?.(
		"#chat-log, .chat-log, [data-application-part='log'], .chat-scroll",
	) ?? root;
}

function isChatApplication(application, root) {
	const name = String(application?.constructor?.name ?? "");
	const id = String(application?.id ?? application?.options?.id ?? "").toLowerCase();
	return name === "ChatLog" ||
		id === "chat" ||
		root?.id === "chat" ||
		Boolean(root?.querySelector?.("#chat-log"));
}

function isChatInputTarget(target) {
	return Boolean(target?.closest?.(
		"textarea, input, [contenteditable='true'], .chat-form, [data-application-part='input']",
	));
}

function dragSurfaceForItem(root, itemId) {
	const escaped = CSS.escape(String(itemId ?? ""));
	if (!escaped) return null;
	const selector = `[data-item-id="${escaped}"]`;
	const candidates = [...root.querySelectorAll(selector)];
	if (!candidates.length) return null;

	return candidates.find((element) =>
		element.matches?.(
			"[role='row'], .classic-inventory__row, .skill-row, [data-item-uuid]",
		) && !isInteractiveElement(element)
	) ?? candidates.find((element) => !isInteractiveElement(element)) ?? null;
}

function interactiveDragOrigin(target, surface) {
	if (!(target instanceof Element)) return false;
	const control = target.closest("button, input, textarea, select, option, a");
	return Boolean(control && surface.contains(control));
}

function isInteractiveElement(element) {
	return element.matches?.("button, input, textarea, select, option, a") === true;
}

function classicSheetRoot(root) {
	if (root?.matches?.(".wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localizedHelpText() {
	return game.i18n.lang === "pl" ? HELP_TEXT.pl : HELP_TEXT.en;
}

function reportInventoryDropError(error) {
	console.error("WFRP1ED | Container/inventory drop failed.", error);
	ui.notifications.warn(error?.message ?? localize(
		"Unable to move that Item in the inventory.",
		"Nie udało się przenieść tego przedmiotu w ekwipunku.",
	));
}

function reportLootDropError(error) {
	console.error("WFRP1ED | Loot chat drop failed.", error);
	ui.notifications.warn(error?.message ?? localize(
		"Unable to create the Loot Pile.",
		"Nie udało się utworzyć stosu łupu.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
