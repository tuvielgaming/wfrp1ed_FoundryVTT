import { InventoryManagerWindow } from "./InventoryManagerWindow.mjs";

const { DialogV2 } = foundry.applications.api;

const INVENTORY_SECTION = Object.freeze({
	EQUIPMENT: "equipment",
	WEALTH: "wealth",
});

const QUANTITY_CLICK_DELAY_MS = 220;

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

for (const hookName of ["createItem", "updateItem", "deleteItem"]) {
	Hooks.on(hookName, (item) => {
		const actor = item?.actor ?? item?.parent;
		if (actor?.documentName === "Actor") {
			void InventoryManagerWindow.refresh(actor);
		}
	});
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

	for (const item of sectionItems(actor, section)) {
		list.append(inventoryRow(item, editable));
	}

	host.append(toolbar, paperHeader, list);
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

function inventoryRow(item, editable) {
	const row = document.createElement("div");
	row.className = "classic-inventory__row";
	row.dataset.itemId = String(item.id ?? "");
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

	const name = document.createElement("span");
	name.className = "classic-inventory__name";
	name.textContent = String(item.name ?? "");
	name.title = String(item.name ?? "");
	nameCell.append(name);

	if (editable) {
		nameCell.append(createDeleteButton(item));
	}

	nameCell.append(createQuantityControl(item, editable));

	const location = createLocationControl(item, editable);

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

	row.append(nameCell, location, encumbrance);
	return row;
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

function createLocationControl(item, editable) {
	const input = document.createElement("input");
	input.type = "text";
	input.className = "classic-inventory__location";
	input.value = String(item.system?.storageLocation ?? "");
	input.readOnly = true;
	input.disabled = !editable;
	input.autocomplete = "off";
	input.title = editable
		? localize(
			"Double-click to edit location.",
			"Kliknij dwukrotnie, aby edytować miejsce.",
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
		editStartValue = String(item.system?.storageLocation ?? "");
		input.readOnly = false;
		input.value = editStartValue;
		input.focus();
		input.select();
	});

	input.addEventListener("keydown", (event) => {
		event.stopPropagation();
		if (!editing) return;

		if (event.key === "Enter") {
			event.preventDefault();
			void commitLocationEdit(item, input).then(() => {
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
		void commitLocationEdit(item, input);
	});

	return input;
}

async function adjustQuantity(item, input, delta) {
	const current = nonNegativeInteger(item.system?.quantity);
	const next = Math.max(0, current + Math.trunc(delta));
	if (next === current) {
		input.value = String(current);
		return;
	}

	await item.update({ "system.quantity": next });
	input.value = String(next);
}

async function commitQuantityEdit(item, input) {
	const next = nonNegativeInteger(input.value);
	const current = nonNegativeInteger(item.system?.quantity);
	input.value = String(next);
	if (next === current) return;
	await item.update({ "system.quantity": next });
}

async function commitLocationEdit(item, input) {
	const next = String(input.value ?? "").trim();
	const current = String(item.system?.storageLocation ?? "");
	input.value = next;
	input.title = localize(
		"Double-click to edit location.",
		"Kliknij dwukrotnie, aby edytować miejsce.",
	);
	if (next === current) return;
	await item.update({ "system.storageLocation": next });
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

	const actor = item.actor ?? item.parent;
	if (actor?.documentName !== "Actor") {
		throw new Error("Inventory Item is not owned by an Actor.");
	}

	await actor.deleteEmbeddedDocuments("Item", [item.id]);
}

function sectionItems(actor, section) {
	const wealth = section === INVENTORY_SECTION.WEALTH;
	return [...(actor.items ?? [])].filter((item) =>
		item?.type === "equipment" &&
		Boolean(item.system?.isWealth) === wealth,
	);
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
