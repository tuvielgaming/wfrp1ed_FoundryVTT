import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
} from "../data-models/item/ArmourData.mjs";
import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Bridge the canonical Weapon/Armour Item contracts into the Classic-sheet
 * printed combat tables.
 *
 * This is presentation and direct Item interaction only. Combat calculations
 * continue to read Item state through CombatEquipment.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;

	if (
		actor?.documentName !== "Actor" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) {
		return;
	}

	const editable = application.isEditable === true;

	renderWeapons(element, actor, editable);
	renderArmour(element, actor, editable);
	renderDerivedArmourPoints(element, actor);
});

function renderWeapons(root, actor, editable) {
	const weapons = [...(actor.items ?? [])].filter(
		(item) => item?.type === "weapon",
	);
	const meleeBody = root.querySelector(".melee-table-body");
	const rangedBody = root.querySelector(".ranged-table-body");

	if (meleeBody) {
		replaceRows(
			meleeBody,
			weapons.filter((item) => item.system?.kind === WEAPON_KIND.MELEE),
			(item) => meleeRow(item, editable),
		);
	}

	if (rangedBody) {
		replaceRows(
			rangedBody,
			weapons.filter((item) => item.system?.kind === WEAPON_KIND.RANGED),
			(item) => rangedRow(item, editable),
		);
	}
}

function renderArmour(root, actor, editable) {
	const body = root.querySelector(".armour-table-body");
	if (!body) return;

	const armour = [...(actor.items ?? [])].filter(
		(item) => item?.type === "armour",
	);

	replaceRows(
		body,
		armour,
		(item) => armourRow(item, editable),
	);
}

function renderDerivedArmourPoints(root, actor) {
	const fieldSelectors = Object.freeze({
		head: ".armour-points-field--head input",
		rightArm: ".armour-points-field--right-arm input",
		leftArm: ".armour-points-field--left-arm input",
		body: ".armour-points-field--body input",
		rightLeg: ".armour-points-field--right-leg input",
		leftLeg: ".armour-points-field--left-leg input",
	});

	for (const [location, selector] of Object.entries(fieldSelectors)) {
		const input = root.querySelector(selector);
		if (!(input instanceof HTMLInputElement)) continue;

		const protection = CombatEquipment.armourAt(actor, location);
		makeDerivedArmourInput(
			input,
			protection.total,
			armourPointTooltip(location, protection),
		);
	}

	const shieldInput = root.querySelector(
		".armour-points-field--shield input",
	);

	if (shieldInput instanceof HTMLInputElement) {
		const shield = CombatEquipment.shieldArmour(actor);
		makeDerivedArmourInput(
			shieldInput,
			shield.total,
			shieldTooltip(shield),
		);
	}
}

function makeDerivedArmourInput(input, value, title) {
	input.value = String(value);
	input.readOnly = true;
	input.removeAttribute("name");
	input.dataset.wfrpDerivedArmour = "";
	input.setAttribute("aria-readonly", "true");
	input.title = title;
}

function meleeRow(item, editable) {
	const used = CombatEquipmentState.isUsed(item);
	const row = baseRow("melee-row", item);
	const optional = item.system?.optionalModifiers ?? {};

	if (used) row.classList.add("is-equipped");
	else row.classList.add("is-carried");

	row.append(
		itemNameCell("melee-cell melee-cell--name", item, used, editable),
		cell("melee-cell melee-cell--initiative", modifierDisplay(optional.initiative)),
		cell("melee-cell melee-cell--weapon-skill", modifierDisplay(optional.toHit)),
		cell("melee-cell melee-cell--damage", modifierDisplay(optional.damage)),
		cell("melee-cell melee-cell--parry", modifierDisplay(optional.parry)),
	);

	return row;
}

function rangedRow(item, editable) {
	const used = CombatEquipmentState.isUsed(item);
	const row = baseRow("ranged-row", item);
	const range = item.system?.range ?? {};

	if (used) row.classList.add("is-equipped");
	else row.classList.add("is-carried");

	row.append(
		itemNameCell("ranged-cell ranged-cell--name", item, used, editable),
		cell("ranged-cell ranged-cell--short-range", nonNegativeInteger(range.short)),
		cell("ranged-cell ranged-cell--long-range", nonNegativeInteger(range.long)),
		cell("ranged-cell ranged-cell--maximum-range", nonNegativeInteger(range.max)),
		cell(
			"ranged-cell ranged-cell--effective-strength",
			nonNegativeInteger(item.system?.effectiveStrength),
		),
		cell("ranged-cell ranged-cell--reload", nonNegativeInteger(item.system?.reload)),
	);

	return row;
}

function armourRow(item, editable) {
	const used = CombatEquipmentState.isUsed(item);
	const row = baseRow("armour-row", item);

	if (used) row.classList.add("is-equipped");
	else row.classList.add("is-carried");

	const coverage = ARMOUR_LOCATIONS
		.filter((location) => item.system?.coverage?.[location] === true)
		.map((location) => hitLocationLabel(location))
		.join(", ");

	row.append(
		itemNameCell("armour-cell armour-cell--name", item, used, editable),
		cell("armour-cell armour-cell--location", coverage || "—", coverage || "—"),
		cell(
			"armour-cell armour-cell--encumbrance",
			nonNegativeNumber(item.system?.encumbrance),
		),
	);

	return row;
}

function replaceRows(container, items, rowFactory) {
	container.replaceChildren();

	for (const item of items) {
		container.append(rowFactory(item));
	}
}

function baseRow(className, item) {
	const row = document.createElement("div");
	row.className = className;
	row.dataset.itemId = String(item.id ?? "");
	row.setAttribute("role", "row");
	row.title = localize(
		`Double-click to open ${item.name}.`,
		`Kliknij dwukrotnie, aby otworzyć ${item.name}.`,
	);
	row.addEventListener("dblclick", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void item.sheet?.render?.({ force: true });
	});
	return row;
}

function itemNameCell(classNames, item, used, editable) {
	const span = document.createElement("span");
	span.className = classNames;
	span.setAttribute("role", "cell");
	span.title = String(item.name ?? "");

	const label = document.createElement("span");
	label.classList.add("combat-sheet-item-name");
	label.textContent = String(item.name ?? "");
	span.append(label);

	const controls = document.createElement("span");
	controls.classList.add("combat-sheet-item-controls");

	const stateButton = document.createElement("button");
	stateButton.type = "button";
	stateButton.classList.add("combat-sheet-use-toggle");
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
		deleteButton.classList.add("combat-sheet-delete-item");
		deleteButton.setAttribute(
			"aria-label",
			localize("Delete Item", "Usuń przedmiot"),
		);
		deleteButton.title = localize(
			"Delete this Item from the character.",
			"Usuń ten przedmiot z postaci.",
		);

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

	span.append(controls);
	return span;
}

function stopRowActionPropagation(element) {
	for (const eventName of ["pointerdown", "dblclick"]) {
		element.addEventListener(eventName, (event) => {
			event.stopPropagation();
		});
	}
}

async function toggleUsed(item, button) {
	button.disabled = true;

	try {
		await CombatEquipmentState.toggleUsed(item);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to change combat equipment state.",
			error,
		);
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
		throw new Error("Combat-table Item is not owned by an Actor.");
	}

	await actor.deleteEmbeddedDocuments("Item", [item.id]);
}

function cell(classNames, value, title = "") {
	const span = document.createElement("span");
	span.className = classNames;
	span.setAttribute("role", "cell");
	span.textContent = String(value ?? "");
	if (title) span.title = String(title);
	return span;
}

function armourPointTooltip(location, protection) {
	const label = hitLocationLabel(location);
	const sources = protection.sources ?? [];

	if (sources.length === 0) {
		return localize(
			`${label}: no active armour.`,
			`${label}: brak aktywnego pancerza.`,
		);
	}

	const details = sources
		.map((source) => `${source.itemName} +${source.points}`)
		.join(", ");

	return `${label}: ${protection.total} (${details})`;
}

function shieldTooltip(shield) {
	const sources = shield.sources ?? [];
	const label = localize("Shield", "Tarcza");

	if (sources.length === 0) {
		return localize(
			"Shield: no active shield.",
			"Tarcza: brak aktywnej tarczy.",
		);
	}

	const details = sources
		.map((source) => `${source.itemName} +${source.points}`)
		.join(", ");

	return `${label}: ${shield.total} (${details})`;
}

function hitLocationLabel(location) {
	const polish = game.i18n.lang === "pl";
	const labels = polish
		? {
			head: "Głowa",
			body: "Korpus",
			rightArm: "Prawe ramię",
			leftArm: "Lewe ramię",
			rightLeg: "Prawa noga",
			leftLeg: "Lewa noga",
		}
		: {
			head: "Head",
			body: "Body",
			rightArm: "Right arm",
			leftArm: "Left arm",
			rightLeg: "Right leg",
			leftLeg: "Left leg",
		};

	return labels[location] ?? String(location ?? "");
}

function modifierDisplay(value) {
	const number = integer(value);

	if (number > 0) return `+${number}`;
	if (number < 0) return String(number);
	return "-";
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	return Math.max(0, integer(value));
}

function nonNegativeNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}