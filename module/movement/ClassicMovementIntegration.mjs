import { LayoutManager } from "../sheets/LayoutManager.mjs";
import { MOVEMENT_RATE, MovementRates } from "./MovementRates.mjs";

const MOVEMENT_PAGE = 2;
const MOVEMENT_SECTION = "movement";

const CELL_DEFINITIONS = Object.freeze([
	Object.freeze({ rate: MOVEMENT_RATE.CAUTIOUS, unit: "round", className: "classic-movement__value--cautious-round" }),
	Object.freeze({ rate: MOVEMENT_RATE.CAUTIOUS, unit: "minute", className: "classic-movement__value--cautious-minute" }),
	Object.freeze({ rate: MOVEMENT_RATE.CAUTIOUS, unit: "kmh", className: "classic-movement__value--cautious-kmh" }),
	Object.freeze({ rate: MOVEMENT_RATE.STANDARD, unit: "round", className: "classic-movement__value--standard-round" }),
	Object.freeze({ rate: MOVEMENT_RATE.STANDARD, unit: "minute", className: "classic-movement__value--standard-minute" }),
	Object.freeze({ rate: MOVEMENT_RATE.STANDARD, unit: "kmh", className: "classic-movement__value--standard-kmh" }),
	Object.freeze({ rate: MOVEMENT_RATE.RUNNING, unit: "round", className: "classic-movement__value--running-round" }),
	Object.freeze({ rate: MOVEMENT_RATE.RUNNING, unit: "minute", className: "classic-movement__value--running-minute" }),
	Object.freeze({ rate: MOVEMENT_RATE.RUNNING, unit: "kmh", className: "classic-movement__value--running-kmh" }),
]);

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (!isCharacterActor(actor)) return;

	const root = asElement(element);
	if (!classicSheetRoot(root)) return;

	requestAnimationFrame(() => {
		const liveRoot = asElement(application?.element) ?? root;
		const sheet = classicSheetRoot(liveRoot);
		if (!(sheet instanceof HTMLElement)) return;
		renderMovement(sheet, actor);
	});
});

/*
 * Quantity/location/container edits can rebuild only the inventory host instead
 * of producing a complete Actor-sheet render. Refresh every already-rendered
 * movement overlay after the underlying Actor or physical Items change so the
 * table always tracks effective Movement immediately.
 */
Hooks.on("createItem", (item) => scheduleOwnedActorRefresh(item));
Hooks.on("updateItem", (item) => scheduleOwnedActorRefresh(item));
Hooks.on("deleteItem", (item) => scheduleOwnedActorRefresh(item));
Hooks.on("updateActor", (actor) => {
	if (isCharacterActor(actor)) scheduleRenderedRefresh(actor);
});

function scheduleOwnedActorRefresh(item) {
	const actor = item?.actor ?? item?.parent;
	if (isCharacterActor(actor)) scheduleRenderedRefresh(actor);
}

function scheduleRenderedRefresh(actor) {
	requestAnimationFrame(() => refreshRenderedActorMovement(actor));
}

function refreshRenderedActorMovement(actor) {
	const actorUuid = String(actor?.uuid ?? "");
	if (!actorUuid) return;

	for (const overlay of document.querySelectorAll(".classic-movement[data-actor-uuid]")) {
		if (!(overlay instanceof HTMLElement)) continue;
		if (String(overlay.dataset.actorUuid ?? "") !== actorUuid) continue;
		const sheet = overlay.closest(".wfrp1ed-classic-sheet");
		if (sheet instanceof HTMLElement) renderMovement(sheet, actor);
	}
}

function renderMovement(sheet, actor) {
	const page = sheet.querySelector(
		`.classic-sheet-page[data-page="${MOVEMENT_PAGE}"]`,
	);
	if (!(page instanceof HTMLElement)) return;

	const overlay = ensureMovementOverlay(page);
	overlay.dataset.actorUuid = String(actor.uuid ?? "");
	const state = MovementRates.forActor(actor);

	for (const definition of CELL_DEFINITIONS) {
		let cell = overlay.querySelector(`.${definition.className}`);
		if (!(cell instanceof HTMLElement)) {
			cell = document.createElement("span");
			cell.className = `classic-movement__value ${definition.className}`;
			cell.setAttribute("aria-live", "polite");
			overlay.append(cell);
		}

		const value = state.rates[definition.rate]?.[definition.unit];
		const text = formatValue(value, definition.unit);
		if (cell.textContent !== text) cell.textContent = text;
		cell.title = movementCellTitle(state, definition.rate, definition.unit, value);
	}

	overlay.classList.toggle("is-overloaded", state.overloaded);
	overlay.title = movementOverlayTitle(state);
}

function ensureMovementOverlay(page) {
	let overlay = page.querySelector(":scope > .sheet-overlay--movement");
	if (overlay instanceof HTMLElement) return overlay;

	const geometry = LayoutManager.section(
		"classic",
		MOVEMENT_PAGE,
		MOVEMENT_SECTION,
	);

	overlay = document.createElement("section");
	overlay.className = "sheet-overlay sheet-overlay--movement classic-movement";
	overlay.dataset.section = MOVEMENT_SECTION;
	overlay.setAttribute("aria-label", localize("Movement rates", "Tempo ruchu"));
	Object.assign(overlay.style, {
		position: "absolute",
		left: `${geometry.x}px`,
		top: `${geometry.y}px`,
		width: `${geometry.width}px`,
		height: `${geometry.height}px`,
	});
	page.append(overlay);
	return overlay;
}

function movementOverlayTitle(state) {
	const base = localize(
		`Movement rates use effective M ${state.movement}.`,
		`Tempo ruchu wykorzystuje efektywną Sz ${state.movement}.`,
	);

	if (!state.overloaded) {
		return `${base} ${localize(
			`Encumbrance ${formatGeneral(state.load)}/${formatGeneral(state.capacity)}; no Movement penalty.`,
			`Obciążenie ${formatGeneral(state.load)}/${formatGeneral(state.capacity)}; brak kary do Szybkości.`,
		)}`;
	}

	return `${base} ${localize(
		`Base M ${state.baseMovement}; Encumbrance penalty -${state.movementPenalty}.`,
		`Bazowa Sz ${state.baseMovement}; kara za Obciążenie -${state.movementPenalty}.`,
	)}`;
}

function movementCellTitle(state, rate, unit, value) {
	const rateLabel = rateLabelFor(rate);
	const unitLabel = unitLabelFor(unit);
	const displayed = value == null
		? localize("outside the published Core km/h table", "poza opublikowaną tabelą km/h z Księgi Głównej")
		: `${formatValue(value, unit)} ${unitLabel}`;

	return localize(
		`${rateLabel}: ${displayed}. Effective M ${state.movement}.`,
		`${rateLabel}: ${displayed}. Efektywna Sz ${state.movement}.`,
	);
}

function rateLabelFor(rate) {
	switch (rate) {
		case MOVEMENT_RATE.CAUTIOUS: return localize("Cautious", "Ostrożnie");
		case MOVEMENT_RATE.RUNNING: return localize("Running", "Biegiem");
		default: return localize("Standard", "Normalnie");
	}
}

function unitLabelFor(unit) {
	switch (unit) {
		case "round": return "m/10 s";
		case "minute": return "m/min";
		default: return "km/h";
	}
}

function formatValue(value, unit) {
	if (value == null) return "—";
	if (unit !== "kmh") return String(Math.trunc(Number(value) || 0));
	return new Intl.NumberFormat(game.i18n.lang || "pl", {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(Number(value) || 0);
}

function formatGeneral(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "0";
	if (Number.isInteger(number)) return String(number);
	return String(Number(number.toFixed(2)));
}

function isCharacterActor(actor) {
	return actor instanceof foundry.documents.Actor && actor.type === "character";
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

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
