import { InventoryManagerWindow } from "./InventoryManagerWindow.mjs";

const { DialogV2 } = foundry.applications.api;

const INVENTORY_SECTION = Object.freeze({
	EQUIPMENT: "equipment",
	WEALTH: "wealth",
});

const QUANTITY_CLICK_DELAY_MS = 220;
const EXPANDED_CONTAINERS = new Set();
const CASCADE_DELETE_IDS = new Set();
let closeActiveLocationMenu = null;

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor") return;

	const hosts = element?.querySelectorAll?.("[data-wfrp1ed-inventory]") ?? [];
	if (hosts.length === 0) return;

	for (const host of hosts) {
		if (!(host instanceof HTMLElement)) continue;

		renderInventory(
			host,
			actor,
			application.isEditable === true,
			normalizeSection(host.dataset.inventorySection),
		);
	}
});

Hooks.on("createItem", (item) => refreshOwnedInventory(item));
Hooks.on("updateItem", (item, changes) => {
	refreshOwnedInventory(item);
	if (
		item?.type === "equipment" &&
		itemActor(item)?.documentName === "Actor" &&
		changedPath(changes, "system.isContainer") &&
		item.system?.isContainer !== true
	) {
		void releaseContainerChildren(itemActor(item), item.id);
	}
});
Hooks.on("deleteItem", (item) => {
	const actor = itemActor(item);
	if (actor?.documentName !== "Actor") return;

	const id = String(item?.id ?? "");
	if (
		item?.type === "equipment" &&
		!CASCADE_DELETE_IDS.has(id)
	) {
		void releaseContainerChildren(actor, id);
	}
	void InventoryManagerWindow.refresh(actor);
});

function refreshOwnedInventory(item) {
	const actor = itemActor(item);
	if (actor?.documentName === "Actor") {
		void InventoryManagerWindow.refresh(actor);
	}
}

function renderInventory(host, actor, editable, section) {
	host.replaceChildren();

	const toolbar = document.createElement("div");
	toolbar.className = "classic-inventory__toolbar";

	if (editable) {
		toolbar.append(createEquipmentButton(actor, section));
	}
	toolbar.append(createManagerButton(actor));

	/*
	 * The scan supplies the left Ekwipunek/Majątek header cell. The two narrow
	 * right cells are completed digitally so their localized labels remain
	 * readable and visually continuous with the printed black heading strip.
	 * Equipment and Wealth hosts have separate CSS tuning variables because the
	 * two printed header strips are not vertically identical in the scan.
	 */
	const paperHeader = document.createElement("div");
	paperHeader.className = "classic-inventory__paper-header";
	paperHeader.setAttribute("aria-hidden", "true");

	const nameHeader = document.createElement("span");
	nameHeader.className = "classic-inventory__paper-header-name";

	const locationHeader = document.createElement("span");
	locationHeader.className = "classic-inventory__paper-header-label";
	locationHeader.textContent = localize("LOC", "LOK");

	const encumbranceHeader = document.createElement("span");
	encumbranceHeader.className = "classic-inventory__paper-header-label";
	encumbranceHeader.textContent = localize("ENC", "OBC");

	paperHeader.append(nameHeader, locationHeader, encumbranceHeader);

	const list = document.createElement("div");
	list.className = "classic-inventory__list";

	const tree = buildInventoryTree(actor);
	const wealth = section === INVENTORY_SECTION.WEALTH;
	for (const node of tree.roots) {
		if (Boolean(node.item.system?.isWealth) !== wealth) continue;
		appendInventoryNode(list, node, actor, editable, host, section, 0);
	}

	host.append(toolbar, paperHeader, list);
}

function rerenderInventory(host, actor, editable, section) {
	const scrollTop = host.querySelector(".classic-inventory__list")?.scrollTop ?? 0;
	renderInventory(host, actor, editable, section);
	const nextList = host.querySelector(".classic-inventory__list");
	if (nextList) nextList.scrollTop = scrollTop;
}

function appendInventoryNode(
	list,
	node,
	actor,
	editable,
	host,
	section,
	depth,
) {
	const key = expansionKey(actor, node.item);
	const expanded = EXPANDED_CONTAINERS.has(key);
	const refreshView = () => rerenderInventory(
		host,
		actor,
		editable,
		section,
	);
	const toggle = () => {
		if (EXPANDED_CONTAINERS.has(key)) {
			EXPANDED_CONTAINERS.delete(key);
		} else {
			EXPANDED_CONTAINERS.add(key);
		}
		refreshView();
	};

	list.append(inventoryRow(
		node.item,
		actor,
		editable,
		depth,
		node.children.length,
		expanded,
		toggle,
		refreshView,
	));

	if (!expanded) return;
	for (const child of node.children) {
		appendInventoryNode(
			list,
			child,
			actor,
			editable,
			host,
			section,
			depth + 1,
		);
	}
}

function createEquipmentButton(actor, section) {
	const wealth = section === INVENTORY_SECTION.WEALTH;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-inventory__create";
	button.title = wealth
		? localize("Add Wealth.", "Dodaj majątek.")
		: localize("Add Equipment.", "Dodaj ekwipunek.");
	button.setAttribute("aria-label", button.title);

	const icon = document.createElement("i");
	icon.className = wealth ? "fas fa-coins" : "fas fa-bag-shopping";
	icon.setAttribute("aria-hidden", "true");
	button.append(icon);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void createEquipment(actor, section);
	});

	return button;
}

function createManagerButton(actor) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-inventory__create classic-inventory__manager";
	button.title = localize(
		"Open full Inventory Manager.",
		"Otwórz pełny menedżer ekwipunku.",
	);
	button.setAttribute("aria-label", button.title);

	const icon = document.createElement("i");
	icon.className = "fas fa-box-open";
	icon.setAttribute("aria-hidden", "true");
	button.append(icon);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void InventoryManagerWindow.open(actor);
	});

	return button;
}

function inventoryRow(
	item,
	actor,
	editable,
	depth,
	childCount,
	expanded,
	toggleContainer,
	refreshView,
) {
	const row = document.createElement("div");
	row.className = "classic-inventory__row";
	if (depth > 0) row.classList.add("classic-inventory__row--nested");
	row.dataset.itemId = String(item.id ?? "");
	row.style.setProperty("--classic-inventory-depth", String(depth));
	row.title = localize(
		`Double-click the item name to open ${item.name}.`,
		`Kliknij dwukrotnie nazwę, aby otworzyć ${item.name}.`,
	);

	row.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void item.sheet?.render?.({ force: true });
	});

	const nameCell = document.createElement("span");
	nameCell.className = "classic-inventory__name-cell";

	if (item.system?.isContainer === true) {
		nameCell.append(createContainerToggle(
			item,
			childCount,
			expanded,
			toggleContainer,
		));
	}

	const name = document.createElement("span");
	name.className = "classic-inventory__name";
	name.textContent = String(item.name ?? "");
	name.title = String(item.name ?? "");
	nameCell.append(name);
	nameCell.append(createQuantityControl(item, editable));

	const location = createLocationControl(
		item,
		actor,
		editable,
		refreshView,
	);

	const encumbranceCell = document.createElement("span");
	encumbranceCell.className = "classic-inventory__encumbrance-cell";

	const encumbrance = textCell(
		formatNumber(
			nonNegativeNumber(
				item.system?.totalEncumbrance ?? item.system?.encumbrance,
			),
		),
	);
	encumbrance.classList.add("classic-inventory__number");
	encumbrance.title = localize(
		"Current stack Encumbrance.",
		"Aktualne Obciążenie całej ilości.",
	);
	encumbranceCell.append(encumbrance);

	if (editable) {
		encumbranceCell.append(createDeleteButton(item));
	}

	row.append(nameCell, location, encumbranceCell);
	return row;
}

function createContainerToggle(item, childCount, expanded, toggleContainer) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-inventory__container-toggle";
	button.disabled = childCount === 0;
	button.title = childCount === 0
		? localize("Empty container.", "Pusty pojemnik.")
		: expanded
			? localize("Collapse container.", "Zwiń pojemnik.")
			: localize("Expand container.", "Rozwiń pojemnik.");
	button.setAttribute("aria-label", button.title);
	button.setAttribute("aria-expanded", String(expanded));

	const icon = document.createElement("i");
	icon.className = childCount === 0
		? "fas fa-box"
		: expanded
			? "fas fa-caret-down"
			: "fas fa-caret-right";
	icon.setAttribute("aria-hidden", "true");
	button.append(icon);

	for (const eventName of ["pointerdown", "dblclick"]) {
		button.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (childCount > 0) toggleContainer();
	});

	return button;
}

function createDeleteButton(item) {
	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.className = "classic-inventory__delete";
	deleteButton.title = localize(
		"Delete this Item from the character.",
		"Usuń ten przedmiot z postaci.",
	);
	deleteButton.setAttribute("aria-label", deleteButton.title);

	const icon = document.createElement("i");
	icon.className = "fas fa-trash";
	icon.setAttribute("aria-hidden", "true");
	deleteButton.append(icon);

	for (const eventName of ["pointerdown", "dblclick"]) {
		deleteButton.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}

	deleteButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void deleteItem(item);
	});

	return deleteButton;
}

function createQuantityControl(item, editable) {
	const input = document.createElement("input");
	input.type = "number";
	input.min = "0";
	input.step = "1";
	input.inputMode = "numeric";
	input.className = "classic-inventory__quantity";
	input.value = String(nonNegativeInteger(item.system?.quantity));
	input.readOnly = true;
	input.disabled = !editable;
	input.title = localize(
		"Quantity: left-click +1, Shift/Ctrl-click +10, right-click -1, Shift/Ctrl-right-click -10, double-click to type a value.",
		"Ilość: lewy klik +1, Shift/Ctrl+klik +10, prawy klik -1, Shift/Ctrl+prawy klik -10, dwuklik pozwala wpisać wartość.",
	);
	input.setAttribute("aria-label", localize("Current quantity", "Aktualna ilość"));

	const pendingClicks = new Set();
	let editing = false;
	let editStartValue = input.value;

	const clearPendingClicks = () => {
		for (const timer of pendingClicks) clearTimeout(timer);
		pendingClicks.clear();
	};

	input.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!editable || editing) return;

		const step = quantityStep(event);
		const timer = setTimeout(() => {
			pendingClicks.delete(timer);
			void adjustQuantity(item, input, step);
		}, QUANTITY_CLICK_DELAY_MS);
		pendingClicks.add(timer);
	});

	input.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!editable) return;

		clearPendingClicks();
		editing = true;
		editStartValue = String(nonNegativeInteger(item.system?.quantity));
		input.readOnly = false;
		input.value = editStartValue;
		input.focus();
		input.select();
	});

	input.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!editable || editing) return;
		void adjustQuantity(item, input, -quantityStep(event));
	});

	input.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (!editing) return;

		if (event.key === "Enter") {
			event.preventDefault();
			void commitQuantityEdit(item, input).then(() => {
				editing = false;
				input.readOnly = true;
				input.blur();
			});
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			input.value = editStartValue;
			editing = false;
			input.readOnly = true;
			input.blur();
		}
	});

	input.addEventListener("blur", () => {
		if (!editing) return;
		editing = false;
		input.readOnly = true;
		void commitQuantityEdit(item, input);
	});

	return input;
}

function createLocationControl(item, actor, editable, refreshView) {
	const input = document.createElement("input");
	input.type = "text";
	input.className = "classic-inventory__location";
	input.value = displayedLocation(item, actor);
	input.readOnly = true;
	input.disabled = !editable;
	input.autocomplete = "off";
	input.title = editable
		? localize(
			"Double-click to edit location or choose a container.",
			"Kliknij dwukrotnie, aby edytować miejsce lub wybrać pojemnik.",
		)
		: input.value;
	input.setAttribute("aria-label", localize("Location", "Miejsce"));

	let editing = false;
	let editStartValue = input.value;

	input.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (!editable) return;

		editing = true;
		editStartValue = displayedLocation(item, actor);
		input.readOnly = false;
		input.value = editStartValue;
		input.focus();
		input.select();
		openLocationMenu(input, item, actor, {
			onContainer: async (container) => {
				editing = false;
				input.readOnly = true;
				await assignContainer(item, container);
				EXPANDED_CONTAINERS.add(expansionKey(actor, container));
				refreshView();
			},
			onFreeText: () => {
				editing = true;
				input.readOnly = false;
				input.value = "";
				input.focus();
				input.select();
			},
		});
	});

	input.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (!editing) return;

		if (event.key === "Enter") {
			event.preventDefault();
			closeLocationMenu();
			void commitLocationEdit(item, actor, input).then((changed) => {
				editing = false;
				input.readOnly = true;
				if (changed) refreshView();
				else input.blur();
			});
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			closeLocationMenu();
			input.value = editStartValue;
			editing = false;
			input.readOnly = true;
			input.blur();
		}
	});

	input.addEventListener("blur", () => {
		if (!editing) return;
		closeLocationMenu();
		editing = false;
		input.readOnly = true;
		void commitLocationEdit(item, actor, input).then((changed) => {
			if (changed) refreshView();
		});
	});

	return input;
}

function openLocationMenu(input, item, actor, handlers) {
	closeLocationMenu();

	const menu = document.createElement("div");
	menu.className = "classic-inventory-location-menu";
	menu.setAttribute("role", "listbox");

	const freeText = locationMenuButton(
		"fas fa-pen",
		localize("Enter location", "Wpisz lokalizację"),
	);
	freeText.classList.add("classic-inventory-location-menu__free");
	freeText.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		closeLocationMenu();
		void handlers.onFreeText();
	});
	menu.append(freeText);

	const containers = availableContainers(item, actor);
	for (const container of containers) {
		const button = locationMenuButton("fas fa-box", String(container.name ?? ""));
		button.dataset.containerId = String(container.id ?? "");
		if (String(item.system?.containerId ?? "") === String(container.id ?? "")) {
			button.classList.add("is-selected");
		}
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			closeLocationMenu();
			void handlers.onContainer(container);
		});
		menu.append(button);
	}

	menu.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		event.stopPropagation();
	});

	document.body.append(menu);
	positionLocationMenu(menu, input);

	const outsidePointerDown = (event) => {
		if (event.target === input || menu.contains(event.target)) return;
		closeLocationMenu();
	};
	const closeOnViewportChange = () => closeLocationMenu();

	document.addEventListener("pointerdown", outsidePointerDown, true);
	window.addEventListener("resize", closeOnViewportChange, true);
	window.addEventListener("scroll", closeOnViewportChange, true);

	closeActiveLocationMenu = () => {
		document.removeEventListener("pointerdown", outsidePointerDown, true);
		window.removeEventListener("resize", closeOnViewportChange, true);
		window.removeEventListener("scroll", closeOnViewportChange, true);
		menu.remove();
		closeActiveLocationMenu = null;
	};
}

function closeLocationMenu() {
	closeActiveLocationMenu?.();
}

function locationMenuButton(iconClass, label) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-inventory-location-menu__option";
	button.setAttribute("role", "option");

	const icon = document.createElement("i");
	icon.className = iconClass;
	icon.setAttribute("aria-hidden", "true");

	const text = document.createElement("span");
	text.textContent = label;

	button.append(icon, text);
	return button;
}

function positionLocationMenu(menu, input) {
	const rect = input.getBoundingClientRect();
	const width = 230;
	const margin = 8;
	const left = Math.max(
		margin,
		Math.min(rect.left, window.innerWidth - width - margin),
	);

	menu.style.width = `${width}px`;
	menu.style.left = `${left}px`;
	menu.style.top = `${rect.bottom + 2}px`;

	const menuRect = menu.getBoundingClientRect();
	if (menuRect.bottom > window.innerHeight - margin) {
		menu.style.top = `${Math.max(margin, rect.top - menuRect.height - 2)}px`;
	}
}

async function adjustQuantity(item, input, delta) {
	const current = nonNegativeInteger(item.system?.quantity);
	const next = Math.max(0, current + Math.trunc(delta));
	if (next === current) {
		input.value = String(current);
		return;
	}

	await item.update({ "system.quantity": next });
	input.value = String(nonNegativeInteger(item.system?.quantity));
}

async function commitQuantityEdit(item, input) {
	const next = nonNegativeInteger(input.value);
	const current = nonNegativeInteger(item.system?.quantity);
	input.value = String(next);
	if (next === current) return;
	await item.update({ "system.quantity": next });
	input.value = String(nonNegativeInteger(item.system?.quantity));
}

async function commitLocationEdit(item, actor, input) {
	const next = String(input.value ?? "").trim();
	const currentContainer = resolvedContainer(item, actor);
	const current = currentContainer
		? String(currentContainer.name ?? "")
		: String(item.system?.storageLocation ?? "");
	input.value = next;
	input.title = localize(
		"Double-click to edit location or choose a container.",
		"Kliknij dwukrotnie, aby edytować miejsce lub wybrać pojemnik.",
	);
	if (next === current) return false;
	await commitFreeLocation(item, next);
	return true;
}

async function commitFreeLocation(item, value) {
	const next = String(value ?? "").trim();
	await item.update({
		"system.containerId": "",
		"system.storageLocation": next,
	});
}

async function assignContainer(item, container) {
	const actor = itemActor(item);
	if (actor?.documentName !== "Actor") {
		throw new Error("Only owned Equipment can be placed in a container.");
	}
	if (!canUseContainer(item, container, equipmentMap(actor))) {
		throw new Error(localize(
			"This container would create an invalid or circular inventory relationship.",
			"Ten pojemnik utworzyłby nieprawidłową lub zapętloną relację ekwipunku.",
		));
	}

	await item.update({
		"system.containerId": String(container.id ?? ""),
		"system.storageLocation": String(container.name ?? ""),
	});
}

function displayedLocation(item, actor) {
	const container = resolvedContainer(item, actor);
	return container
		? String(container.name ?? "")
		: String(item.system?.storageLocation ?? "");
}

function resolvedContainer(item, actor) {
	const byId = equipmentMap(actor);
	const parentId = resolveParentId(item, byId);
	return parentId ? byId.get(parentId) ?? null : null;
}

function availableContainers(item, actor) {
	const byId = equipmentMap(actor);
	return [...byId.values()]
		.filter((candidate) => canUseContainer(item, candidate, byId))
		.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function canUseContainer(item, candidate, byId) {
	if (!item || !candidate) return false;
	if (candidate.type !== "equipment" || candidate.system?.isContainer !== true) {
		return false;
	}
	if (String(candidate.id ?? "") === String(item.id ?? "")) return false;

	const forbiddenId = String(item.id ?? "");
	const seen = new Set([forbiddenId]);
	let current = candidate;

	while (current) {
		const currentId = String(current.id ?? "");
		if (seen.has(currentId)) return false;
		seen.add(currentId);

		const nextId = String(current.system?.containerId ?? "").trim();
		if (!nextId) return true;
		const next = byId.get(nextId);
		if (!next || next.type !== "equipment" || next.system?.isContainer !== true) {
			return true;
		}
		current = next;
	}

	return true;
}

function buildInventoryTree(actor) {
	const byId = equipmentMap(actor);
	const nodes = new Map(
		[...byId.values()].map((item) => [String(item.id ?? ""), {
			item,
			children: [],
		}]),
	);
	const roots = [];

	for (const node of nodes.values()) {
		const parentId = resolveParentId(node.item, byId);
		const parentNode = parentId ? nodes.get(String(parentId)) : null;
		if (parentNode) {
			parentNode.children.push(node);
		} else {
			roots.push(node);
		}
	}

	return { byId, nodes, roots };
}

function resolveParentId(item, byId) {
	const requestedId = String(item.system?.containerId ?? "").trim();
	if (!requestedId) return "";
	const candidate = byId.get(requestedId);
	if (!candidate || !canUseContainer(item, candidate, byId)) return "";
	return requestedId;
}

function equipmentMap(actor) {
	return new Map(
		[...(actor?.items ?? [])]
			.filter((item) => item?.type === "equipment")
			.map((item) => [String(item.id ?? ""), item]),
	);
}

function directContainerChildren(actor, containerId) {
	const id = String(containerId ?? "");
	if (!id) return [];
	return [...(actor?.items ?? [])].filter((item) =>
		item?.type === "equipment" &&
		String(item.system?.containerId ?? "") === id,
	);
}

function collectContainerSubtreeIds(actor, rootId) {
	const root = String(rootId ?? "");
	if (!root) return [];

	const result = [];
	const visited = new Set();
	const queue = [root];

	while (queue.length > 0) {
		const id = queue.shift();
		if (!id || visited.has(id)) continue;
		visited.add(id);
		result.push(id);
		for (const child of directContainerChildren(actor, id)) {
			queue.push(String(child.id ?? ""));
		}
	}

	return result;
}

async function releaseContainerChildren(actor, containerId) {
	if (actor?.documentName !== "Actor") return;
	const updates = directContainerChildren(actor, containerId).map((item) => ({
		_id: item.id,
		"system.containerId": "",
		"system.storageLocation": "",
	}));

	if (updates.length === 0) return;
	await actor.updateEmbeddedDocuments("Item", updates);
}

function quantityStep(event) {
	return event.shiftKey || event.ctrlKey || event.metaKey ? 10 : 1;
}

async function createEquipment(actor, section) {
	const wealth = section === INVENTORY_SECTION.WEALTH;

	try {
		const created = await actor.createEmbeddedDocuments("Item", [{
			name: wealth
				? localize("New Wealth", "Nowy majątek")
				: localize("New Equipment", "Nowy przedmiot"),
			type: "equipment",
			system: {
				isWealth: wealth,
			},
		}]);
		const item = created?.[0];
		if (item) await item.sheet?.render?.({ force: true });
	} catch (error) {
		console.error("WFRP1ED | Unable to create inventory Item.", error);
		ui.notifications.error(error.message);
	}
}

async function deleteItem(item) {
	const actor = itemActor(item);
	if (actor?.documentName !== "Actor") {
		throw new Error("Inventory Item is not owned by an Actor.");
	}

	const children = item.type === "equipment" && item.system?.isContainer === true
		? directContainerChildren(actor, item.id)
		: [];

	if (children.length === 0) {
		const confirmed = await DialogV2.confirm({
			window: { title: localize("Delete Item", "Usuń przedmiot") },
			content: localize(
				`Delete '${item.name}' from this character?`,
				`Usunąć „${item.name}” z tej postaci?`,
			),
			rejectClose: false,
			modal: true,
		});
		if (!confirmed) return;
		await actor.deleteEmbeddedDocuments("Item", [item.id]);
		return;
	}

	const subtreeIds = collectContainerSubtreeIds(actor, item.id);
	const descendantCount = Math.max(0, subtreeIds.length - 1);
	const choice = await DialogV2.wait({
		window: {
			title: localize("Delete Container", "Usuń pojemnik"),
		},
		content: localize(
			`'${item.name}' contains ${descendantCount} item(s). Delete only the container and return its contents to the top level, or delete the container together with all nested contents?`,
			`„${item.name}” zawiera ${descendantCount} przedmiot(ów). Usunąć tylko pojemnik i przenieść jego zawartość na poziom główny, czy usunąć pojemnik razem z całą zagnieżdżoną zawartością?`,
		),
		buttons: [
			{
				action: "container-only",
				icon: "fas fa-box-open",
				label: localize("Delete container only", "Usuń tylko pojemnik"),
				default: true,
			},
			{
				action: "with-contents",
				icon: "fas fa-trash",
				label: localize("Delete with contents", "Usuń z zawartością"),
			},
			{
				action: "cancel",
				icon: "fas fa-xmark",
				label: localize("Cancel", "Anuluj"),
			},
		],
		rejectClose: false,
		modal: true,
	});

	if (!choice || choice === "cancel") return;

	if (choice === "container-only") {
		await releaseContainerChildren(actor, item.id);
		await actor.deleteEmbeddedDocuments("Item", [item.id]);
		return;
	}

	if (choice === "with-contents") {
		for (const id of subtreeIds) CASCADE_DELETE_IDS.add(String(id));
		try {
			await actor.deleteEmbeddedDocuments("Item", subtreeIds);
		} finally {
			for (const id of subtreeIds) CASCADE_DELETE_IDS.delete(String(id));
		}
	}
}

function expansionKey(actor, item) {
	return `${actor.uuid}:${item.id}`;
}

function changedPath(changes, path) {
	return Object.hasOwn(changes ?? {}, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

function itemActor(item) {
	return item?.actor ?? item?.parent;
}

function textCell(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span;
}

function formatNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "0";
	if (Number.isInteger(number)) return String(number);
	return String(Number(number.toFixed(2)));
}

function normalizeSection(value) {
	return String(value ?? "").trim().toLowerCase() === INVENTORY_SECTION.WEALTH
		? INVENTORY_SECTION.WEALTH
		: INVENTORY_SECTION.EQUIPMENT;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 0;
	return Math.max(0, Math.trunc(number));
}

function nonNegativeNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 0;
	return Math.max(0, number);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
