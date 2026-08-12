import { CombatEquipmentState } from "../combat/CombatEquipmentState.mjs";

const { DialogV2 } = foundry.applications.api;

const PHYSICAL_ITEM_TYPES = new Set([
	"equipment",
	"weapon",
	"armour",
]);

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

function renderInventory(host, actor, editable) {
	host.replaceChildren();

	const toolbar = document.createElement("div");
	toolbar.className = "classic-inventory__toolbar";

	if (editable) {
		toolbar.append(
			createButton(actor, "equipment", "fa-bag-shopping"),
			createButton(actor, "weapon", "fa-sword"),
			createButton(actor, "armour", "fa-shield-halved"),
		);
	}

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
		(item) => PHYSICAL_ITEM_TYPES.has(item?.type),
	);

	for (const item of items) {
		list.append(inventoryRow(item, editable));
	}

	if (items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "classic-inventory__empty";
		empty.textContent = localize(
			"No physical equipment.",
			"Brak ekwipunku.",
		);
		list.append(empty);
	}

	host.append(toolbar, header, list);
}

function createButton(actor, type, iconClass) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-inventory__create";

	const label = itemTypeLabel(type);
	button.title = localize(
		`Add ${label.english}.`,
		`Dodaj: ${label.polish}.`,
	);
	button.setAttribute("aria-label", button.title);

	const icon = document.createElement("i");
	icon.className = `fas ${iconClass}`;
	icon.setAttribute("aria-hidden", "true");
	button.append(icon);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void createItem(actor, type);
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
	typeIcon.className = `fas ${itemTypeIcon(item.type)}`;
	typeIcon.title = localizedTypeLabel(item.type);
	typeIcon.setAttribute("aria-label", typeIcon.title);

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
			"Carried — click to mark as used.",
			"Przenoszony — kliknij, aby oznaczyć jako używany.",
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

async function createItem(actor, type) {
	const label = itemTypeLabel(type);
	const name = localize(
		`New ${label.english}`,
		`Nowy: ${label.polish}`,
	);

	try {
		const created = await actor.createEmbeddedDocuments("Item", [{
			name,
			type,
		}]);
		const item = created?.[0];
		if (item) {
			await item.sheet?.render?.({ force: true });
		}
	} catch (error) {
		console.error("WFRP1ED | Unable to create inventory Item.", error);
		ui.notifications.error(
			error.message ?? localize(
				"Unable to create the Item.",
				"Nie udało się utworzyć przedmiotu.",
			),
		);
	}
}

async function toggleUsed(item, button) {
	button.disabled = true;

	try {
		await CombatEquipmentState.toggleUsed(item);
	} catch (error) {
		console.error("WFRP1ED | Unable to change inventory state.", error);
		ui.notifications.error(
			error.message ?? localize(
				"Unable to change equipment state.",
				"Nie udało się zmienić stanu wyposażenia.",
			),
		);
		button.disabled = false;
	}
}

async function deleteItem(item) {
	const confirmed = await DialogV2.confirm({
		window: {
			title: localize("Delete Item", "Usuń przedmiot"),
		},
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
		element.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}
}

function textCell(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span;
}

function itemTypeIcon(type) {
	switch (type) {
		case "weapon": return "fa-sword";
		case "armour": return "fa-shield-halved";
		default: return "fa-bag-shopping";
	}
}

function itemTypeLabel(type) {
	switch (type) {
		case "weapon":
			return Object.freeze({ english: "Weapon", polish: "Broń" });
		case "armour":
			return Object.freeze({ english: "Armour", polish: "Zbroja" });
		default:
			return Object.freeze({ english: "Equipment", polish: "Ekwipunek" });
	}
}

function localizedTypeLabel(type) {
	const label = itemTypeLabel(type);
	return localize(label.english, label.polish);
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.max(0, Math.trunc(number))
		: 0;
}

function nonNegativeNumber(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 0;
	return Math.max(0, number);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
