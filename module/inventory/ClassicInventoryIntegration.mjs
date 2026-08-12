import { CombatEquipmentState } from "../combat/CombatEquipmentState.mjs";
import { InventoryManagerWindow } from "./InventoryManagerWindow.mjs";

const { DialogV2 } = foundry.applications.api;

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	const host = element?.querySelector?.("[data-wfrp1ed-inventory]");

	if (
		actor?.documentName !== "Actor" ||
		!(host instanceof HTMLElement)
	) {
		return;
	}

	renderInventory(host, actor, application.isEditable === true);
});

for (const hookName of ["createItem", "updateItem", "deleteItem"]) {
	Hooks.on(hookName, (item) => {
		const actor = item?.actor ?? item?.parent;
		if (actor?.documentName === "Actor") {
			void InventoryManagerWindow.refresh(actor);
		}
	});
}

function renderInventory(host, actor, editable) {
	host.replaceChildren();

	const toolbar = document.createElement("div");
	toolbar.className = "classic-inventory__toolbar";

	if (editable) {
		toolbar.append(createEquipmentButton(actor));
	}
	toolbar.append(createManagerButton(actor));

	const header = document.createElement("div");
	header.className = "classic-inventory__header";
	header.append(
		textCell(localize("Item", "Przedmiot")),
		textCell(localize("Qty", "Ilość")),
		textCell(localize("Enc.", "Obc.")),
		textCell(localize("State", "Stan")),
	);

	const list = document.createElement("div");
	list.className = "classic-inventory__list";

	const items = [...(actor.items ?? [])].filter(
		(item) => item?.type === "equipment",
	);

	for (const item of items) {
		list.append(inventoryRow(item, editable));
	}

	if (items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "classic-inventory__empty";
		empty.textContent = localize(
			"No ordinary equipment. Weapons and armour remain in their combat tables.",
			"Brak zwykłego ekwipunku. Broń i zbroja pozostają w swoich tabelach bojowych.",
		);
		list.append(empty);
	}

	host.append(toolbar, header, list);
}

function createEquipmentButton(actor) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-inventory__create";
	button.title = localize("Add Equipment.", "Dodaj ekwipunek.");
	button.setAttribute("aria-label", button.title);

	const icon = document.createElement("i");
	icon.className = "fas fa-bag-shopping";
	icon.setAttribute("aria-hidden", "true");
	button.append(icon);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void createEquipment(actor);
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
	const used = CombatEquipmentState.isUsed(item);
	const row = document.createElement("div");
	row.className = "classic-inventory__row";
	row.classList.toggle("is-used", used);
	row.classList.toggle("is-carried", !used);
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

	const typeIcon = document.createElement("i");
	typeIcon.className = "fas fa-bag-shopping";
	typeIcon.title = localize("Equipment", "Ekwipunek");
	const label = document.createElement("span");
	label.className = "classic-inventory__name-label";
	label.textContent = String(item.name ?? "");
	label.title = String(item.name ?? "");
	name.append(typeIcon, label);

	const quantity = textCell(nonNegativeInteger(item.system?.quantity));
	quantity.classList.add("classic-inventory__number");

	const encumbrance = textCell(nonNegativeNumber(item.system?.encumbrance));
	encumbrance.classList.add("classic-inventory__number");

	const controls = document.createElement("span");
	controls.className = "classic-inventory__controls";

	const stateButton = document.createElement("button");
	stateButton.type = "button";
	stateButton.className = "classic-inventory__use-toggle";
	stateButton.classList.toggle("is-used", used);
	stateButton.setAttribute("aria-pressed", String(used));
	stateButton.setAttribute(
		"aria-label",
		used
			? localize("Used", "Używany")
			: localize("Carried", "Przenoszony"),
	);
	stateButton.title = used
		? localize(
			"Used — click to mark as carried.",
			"Używany — kliknij, aby oznaczyć jako przenoszony.",
		)
		: localize(
			"Carried — click to mark as used/held.",
			"Przenoszony — kliknij, aby oznaczyć jako używany/trzymany.",
		);
	stateButton.disabled = !editable;
	stopRowActionPropagation(stateButton);
	stateButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void toggleUsed(item, stateButton);
	});
	controls.append(stateButton);

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

		stopRowActionPropagation(deleteButton);
		deleteButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void deleteItem(item);
		});
		controls.append(deleteButton);
	}

	row.append(name, quantity, encumbrance, controls);
	return row;
}

async function createEquipment(actor) {
	try {
		const created = await actor.createEmbeddedDocuments("Item", [{
			name: localize("New Equipment", "Nowy przedmiot"),
			type: "equipment",
		}]);
		const item = created?.[0];
		if (item) await item.sheet?.render?.({ force: true });
	} catch (error) {
		console.error("WFRP1ED | Unable to create inventory Item.", error);
		ui.notifications.error(error.message);
	}
}

async function toggleUsed(item, button) {
	button.disabled = true;

	try {
		await CombatEquipmentState.toggleUsed(item);
	} catch (error) {
		console.error("WFRP1ED | Unable to change inventory state.", error);
		ui.notifications.warn(error.message);
		button.disabled = false;
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

function stopRowActionPropagation(element) {
	for (const eventName of ["pointerdown", "dblclick"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

function textCell(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function nonNegativeNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 0;
	return Math.max(0, number);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
