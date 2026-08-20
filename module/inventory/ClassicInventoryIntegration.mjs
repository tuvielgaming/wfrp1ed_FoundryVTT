import { InventoryManagerWindow } from "./InventoryManagerWindow.mjs";

const { DialogV2 } = foundry.applications.api;

const INVENTORY_SECTION = Object.freeze({
	EQUIPMENT: "equipment",
	WEALTH: "wealth",
});

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
	 * The scan supplies the three black header cells, but the right two labels
	 * are not readable in the localized artwork. Overlay only those labels and
	 * keep the same grid as the item rows so the text remains aligned with the
	 * printed vertical rules.
	 */
	const paperHeader = document.createElement("div");
	paperHeader.className = "classic-inventory__paper-header";
	paperHeader.setAttribute("aria-hidden", "true");

	const nameHeader = document.createElement("span");
	nameHeader.className = "classic-inventory__paper-header-name";

	const locationHeader = document.createElement("span");
	locationHeader.className = "classic-inventory__paper-header-label";
	locationHeader.textContent = localize("LOC", "MIEJ.");

	const encumbranceHeader = document.createElement("span");
	encumbranceHeader.className = "classic-inventory__paper-header-label";
	encumbranceHeader.textContent = localize("ENC", "OBC.");

	paperHeader.append(nameHeader, locationHeader, encumbranceHeader);

	/* Preserve the ruled-paper row start used by the original overlay. */
	const paperHeaderSpacer = document.createElement("div");
	paperHeaderSpacer.className = "classic-inventory__paper-header-spacer";
	paperHeaderSpacer.setAttribute("aria-hidden", "true");

	const list = document.createElement("div");
	list.className = "classic-inventory__list";

	for (const item of sectionItems(actor, section)) {
		list.append(inventoryRow(item, editable));
	}

	host.append(toolbar, paperHeader, paperHeaderSpacer, list);
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
		`Double-click to open ${item.name}.`,
		`Kliknij dwukrotnie, aby otworzyć ${item.name}.`,
	);

	row.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void item.sheet?.render?.({ force: true });
	});

	const name = document.createElement("span");
	name.className = "classic-inventory__name";
	name.textContent = String(item.name ?? "");
	name.title = String(item.name ?? "");

	const location = document.createElement("span");
	location.className = "classic-inventory__location";
	location.textContent = String(item.system?.storageLocation ?? "");
	location.title = location.textContent;

	const encumbrance = textCell(nonNegativeNumber(item.system?.encumbrance));
	encumbrance.classList.add("classic-inventory__number");

	row.append(name, location, encumbrance);

	if (editable) {
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

		row.append(deleteButton);
	}

	return row;
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

function normalizeSection(value) {
	return String(value ?? "").trim().toLowerCase() === INVENTORY_SECTION.WEALTH
		? INVENTORY_SECTION.WEALTH
		: INVENTORY_SECTION.EQUIPMENT;
}

function textCell(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span;
}

function nonNegativeNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 0;
	return Math.max(0, number);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
