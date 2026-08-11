import {
	ARMOUR_CLASS,
	ARMOUR_LOCATIONS,
} from "../data-models/item/ArmourData.mjs";
import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";
import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";

/**
 * Bridge the new canonical Weapon/Armour Item contracts into the existing
 * Classic-sheet printed tables.
 *
 * The old DisplayBuilder weapon/armour presentation predates the native v14
 * Item models and therefore cannot currently see `system.kind`, `state.mode`,
 * `optionalModifiers`, or structured armour coverage. Keep this bridge purely
 * presentational: combat rules continue to read the Items through
 * CombatEquipment, and no Actor data is mutated here.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;

	if (
		actor?.documentName !== "Actor" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) {
		return;
	}

	renderWeapons(element, actor);
	renderArmour(element, actor);
	renderDerivedArmourPoints(element, actor);
});

function renderWeapons(root, actor) {
	const weapons = [...(actor.items ?? [])].filter(
		(item) => item?.type === "weapon",
	);
	const meleeBody = root.querySelector(".melee-table-body");
	const rangedBody = root.querySelector(".ranged-table-body");

	if (meleeBody) {
		replaceRows(
			meleeBody,
			weapons.filter((item) => item.system?.kind === WEAPON_KIND.MELEE),
			(item) => meleeRow(item),
		);
	}

	if (rangedBody) {
		replaceRows(
			rangedBody,
			weapons.filter((item) => item.system?.kind === WEAPON_KIND.RANGED),
			(item) => rangedRow(item),
		);
	}
}

function renderArmour(root, actor) {
	const body = root.querySelector(".armour-table-body");
	if (!body) return;

	const active = new Set(
		CombatEquipment.activeArmour(actor).map((item) => item.uuid),
	);
	const armour = [...(actor.items ?? [])].filter(
		(item) => item?.type === "armour",
	);

	replaceRows(
		body,
		armour,
		(item) => armourRow(item, active.has(item.uuid)),
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
		input.value = String(protection.total);
		input.readOnly = true;
		input.removeAttribute("name");
		input.dataset.wfrpDerivedArmour = "";
		input.setAttribute("aria-readonly", "true");
		input.title = armourPointTooltip(location, protection);
	}
}

function meleeRow(item) {
	const row = baseRow("melee-row", item);
	const held = item.system?.state?.mode === INVENTORY_MODE.HELD;
	const optional = item.system?.optionalModifiers ?? {};

	if (held) row.classList.add("is-equipped");

	row.append(
		cell("melee-cell melee-cell--name", item.name, item.name),
		cell("melee-cell melee-cell--initiative", integer(optional.initiative)),
		cell("melee-cell melee-cell--weapon-skill", integer(optional.toHit)),
		cell("melee-cell melee-cell--damage", integer(optional.damage)),
		cell("melee-cell melee-cell--parry", integer(optional.parry)),
	);

	return row;
}

function rangedRow(item) {
	const row = baseRow("ranged-row", item);
	const held = item.system?.state?.mode === INVENTORY_MODE.HELD;
	const range = item.system?.range ?? {};

	if (held) row.classList.add("is-equipped");

	row.append(
		cell("ranged-cell ranged-cell--name", item.name, item.name),
		cell("ranged-cell ranged-cell--short-range", nonNegativeInteger(range.short)),
		cell("ranged-cell ranged-cell--long-range", nonNegativeInteger(range.long)),
		cell("ranged-cell ranged-cell--maximum-range", nonNegativeInteger(range.max)),
		cell("ranged-cell ranged-cell--effective-strength", "—"),
		cell("ranged-cell ranged-cell--reload", nonNegativeInteger(item.system?.reload)),
	);

	return row;
}

function armourRow(item, active) {
	const row = baseRow("armour-row", item);
	if (active) row.classList.add("is-equipped");

	const coverage = ARMOUR_LOCATIONS
		.filter((location) => item.system?.coverage?.[location] === true)
		.map((location) => hitLocationLabel(location))
		.join(", ");

	row.append(
		cell("armour-cell armour-cell--name", item.name, item.name),
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
