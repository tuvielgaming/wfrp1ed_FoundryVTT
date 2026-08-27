import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
} from "../data-models/item/ArmourData.mjs";
import { INVENTORY_HAND } from "../data-models/item/InventoryItemFields.mjs";
import {
	EFFECTIVE_STRENGTH_MODE,
	WEAPON_KIND,
} from "../data-models/item/WeaponData.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Bridge canonical Weapon/Armour Items into the printed Classic combat tables.
 *
 * The printed tables remain the primary Weapon/Armour browser. Every owned Item
 * stays visible there; compact controls mark whether it is equipped and, where
 * relevant, which relative hand slot it uses. Page-two Ekwipunek is reserved
 * for ordinary gear, while a separate manager can provide an unrestricted view.
 *
 * Equipped melee weapons also expose the Classic sheet's normal rollable UX:
 * left-click starts an attack, while Shift + left-click opens the underlying
 * Item. Shift + left-click is also the edit/open gesture for other combat rows.
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

		const protection = CombatEquipment.armourAt(
			actor,
			location,
			{ includeShields: false },
		);
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
	const attackable = CombatAttackLauncher.canLaunch(item);
	const row = baseRow("melee-row", item, used, { attackable });
	const optional = item.system?.optionalModifiers ?? {};

	row.append(
		itemNameCell(
			"melee-cell melee-cell--name",
			item,
			editable,
			{ attackable },
		),
		cell("melee-cell melee-cell--initiative", modifierDisplay(optional.initiative)),
		cell("melee-cell melee-cell--weapon-skill", modifierDisplay(optional.toHit)),
		cell("melee-cell melee-cell--damage", modifierDisplay(optional.damage)),
		cell("melee-cell melee-cell--parry", modifierDisplay(optional.parry)),
	);

	return row;
}

function rangedRow(item, editable) {
	const used = CombatEquipmentState.isUsed(item);
	const row = baseRow("ranged-row", item, used);
	const range = item.system?.range ?? {};

	row.append(
		itemNameCell("ranged-cell ranged-cell--name", item, editable),
		cell("ranged-cell ranged-cell--short-range", nonNegativeInteger(range.short)),
		cell("ranged-cell ranged-cell--long-range", nonNegativeInteger(range.long)),
		cell("ranged-cell ranged-cell--maximum-range", nonNegativeInteger(range.max)),
		cell(
			"ranged-cell ranged-cell--effective-strength",
			effectiveStrengthDisplay(item),
		),
		cell("ranged-cell ranged-cell--reload", nonNegativeInteger(item.system?.reload)),
	);

	return row;
}

function effectiveStrengthDisplay(item) {
	return item.system?.effectiveStrengthMode ===
		EFFECTIVE_STRENGTH_MODE.CHARACTER
		? "C"
		: nonNegativeInteger(item.system?.effectiveStrength);
}

function armourRow(item, editable) {
	const used = CombatEquipmentState.isUsed(item);
	const row = baseRow("armour-row", item, used);
	const coverage = armourCoverageDisplay(item);

	row.append(
		itemNameCell("armour-cell armour-cell--name", item, editable),
		cell(
			"armour-cell armour-cell--location",
			coverage.label,
			coverage.title,
		),
		cell(
			"armour-cell armour-cell--encumbrance",
			nonNegativeNumber(item.system?.encumbrance),
		),
	);

	return row;
}

function armourCoverageDisplay(item) {
	const covered = ARMOUR_LOCATIONS.filter(
		(location) => item.system?.coverage?.[location] === true,
	);

	if (covered.length === 0) {
		return Object.freeze({ label: "—", title: "—" });
	}

	const full = covered.map((location) => hitLocationLabel(location)).join(", ");

	if (covered.length === ARMOUR_LOCATIONS.length) {
		return Object.freeze({
			label: localize("Whole body", "Całe ciało"),
			title: full,
		});
	}

	return Object.freeze({ label: full, title: full });
}

function replaceRows(container, items, rowFactory) {
	container.replaceChildren();
	for (const item of items) container.append(rowFactory(item));
}

function baseRow(className, item, used, { attackable = false } = {}) {
	const row = document.createElement("div");
	row.className = className;
	row.classList.toggle("is-equipped", used);
	row.classList.toggle("is-carried", !used);
	row.classList.toggle("rollable", attackable);
	row.classList.toggle("combat-sheet-attack-rollable", attackable);
	row.dataset.itemId = String(item.id ?? "");
	row.setAttribute("role", "row");

	if (attackable) {
		row.tabIndex = 0;
	}

	row.title = itemInteractionTitle(item, attackable);

	row.addEventListener("click", (event) => {
		if (event.shiftKey) {
			event.preventDefault();
			event.stopPropagation();
			void item.sheet?.render?.({ force: true });
			return;
		}

		if (!attackable) return;
		event.preventDefault();
		event.stopPropagation();
		void launchAttack(item);
	});

	if (attackable) {
		row.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			event.stopPropagation();

			if (event.shiftKey) {
				void item.sheet?.render?.({ force: true });
				return;
			}

			void launchAttack(item);
		});
	}

	return row;
}

function itemNameCell(
	classNames,
	item,
	editable,
	{ attackable = false } = {},
) {
	const used = CombatEquipmentState.isUsed(item);
	const span = document.createElement("span");
	span.className = classNames;
	span.setAttribute("role", "cell");
	span.title = itemInteractionTitle(item, attackable);

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
			? localize("Equipped", "Używany")
			: localize("Carried", "Przenoszony"),
	);
	stateButton.title = used
		? localize(
			"Equipped — click to carry it instead.",
			"Używany — kliknij, aby oznaczyć jako przenoszony.",
		)
		: localize(
			"Carried — click to equip it.",
			"Przenoszony — kliknij, aby użyć/założyć.",
		);
	stateButton.disabled = !editable;
	stopRowActionPropagation(stateButton);
	stateButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void toggleUsed(item, stateButton);
	});
	controls.append(stateButton);

	const handButton = createHandButton(item, editable);
	if (handButton) controls.append(handButton);

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

function createHandButton(item, editable) {
	const allowed = CombatEquipmentState.allowedHands(item);
	if (
		allowed.length === 1 &&
		allowed[0] === INVENTORY_HAND.NONE
	) {
		return null;
	}

	const hand = CombatEquipmentState.preferredHand(item);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-sheet-hand-toggle";
	button.dataset.hand = hand;
	button.textContent = handMarker(hand);
	button.title = handTitle(hand);
	button.setAttribute("aria-label", handTitle(hand));
	button.disabled = !editable;
	stopRowActionPropagation(button);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void cycleHand(item, button, 1);
	});
	button.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void cycleHand(item, button, -1);
	});

	return button;
}

function handMarker(hand) {
	const polish = game.i18n.lang === "pl";
	switch (hand) {
		case INVENTORY_HAND.MAIN: return polish ? "G" : "M";
		case INVENTORY_HAND.OFF: return polish ? "D" : "O";
		case INVENTORY_HAND.BOTH: return "2";
		default: return "–";
	}
}

function handTitle(hand) {
	const label = (() => {
		switch (hand) {
			case INVENTORY_HAND.MAIN: return localize("Main hand", "Główna dłoń");
			case INVENTORY_HAND.OFF: return localize("Off hand", "Druga dłoń");
			case INVENTORY_HAND.BOTH: return localize("Both hands", "Obie dłonie");
			default: return localize("No hand", "Brak dłoni");
		}
	})();
	return localize(
		`${label}. Left-click: next; right-click: previous.`,
		`${label}. Lewy przycisk: następna; prawy przycisk: poprzednia.`,
	);
}

function itemInteractionTitle(item, attackable) {
	const name = String(item?.name ?? "");
	return attackable
		? localize(
			`Left-click to attack with ${name}. Shift-click to open.`,
			`Lewy przycisk: zaatakuj bronią ${name}. Shift+klik: otwórz.`,
		)
		: localize(
			`Shift-click to open ${name}.`,
			`Shift+klik, aby otworzyć ${name}.`,
		);
}

function stopRowActionPropagation(element) {
	for (const eventName of ["pointerdown", "dblclick"]) {
		element.addEventListener(eventName, (event) => event.stopPropagation());
	}
}

async function launchAttack(item) {
	try {
		const actor = item.actor ?? item.parent;
		await CombatAttackLauncher.launch(actor, item);
	} catch (error) {
		console.error("WFRP1ED | Unable to launch combat attack.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to launch the combat attack.",
				"Nie udało się rozpocząć ataku.",
			),
		);
	}
}

async function toggleUsed(item, button) {
	button.disabled = true;

	try {
		await CombatEquipmentState.toggleUsed(item);
	} catch (error) {
		console.error("WFRP1ED | Unable to change combat equipment state.", error);
		ui.notifications.warn(
			error.message ?? localize(
				"Unable to change equipment state.",
				"Nie udało się zmienić stanu wyposażenia.",
			),
		);
		button.disabled = false;
	}
}

async function cycleHand(item, button, direction) {
	button.disabled = true;

	try {
		await CombatEquipmentState.cycleHand(item, direction);
	} catch (error) {
		console.error("WFRP1ED | Unable to change hand slot.", error);
		ui.notifications.warn(
			error.message ?? localize(
				"Unable to change the hand slot.",
				"Nie udało się zmienić dłoni.",
			),
		);
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
		.map((source) => source.suppressed === true
			? localize(
				`${source.itemName} +0 (no bonus over Mail Coif)`,
				`${source.itemName} +0 (brak premii na czepcu kolczym)`,
			)
			: `${source.itemName} +${source.points}`)
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
