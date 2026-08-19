import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const TABS = Object.freeze(["skills", "trappings", "exits"]);
const ONE_POINT_ADVANCES = new Set(["m", "s", "t", "w", "a"]);
const PRIMARY_PURCHASE_MARKER_CAP = 8;
const activeTabs = new WeakMap();

/* Give the lower Career authoring workspace substantially more room than the
 * original two-column summary while still letting Foundry clamp the window to
 * the user's viewport when necessary. */
CareerItemSheet.DEFAULT_OPTIONS.position ??= {};
CareerItemSheet.DEFAULT_OPTIONS.position.height = 980;
CareerItemSheet.DEFAULT_OPTIONS.form ??= {};
CareerItemSheet.DEFAULT_OPTIONS.form.submitOnChange = false;
CareerItemSheet.DEFAULT_OPTIONS.form.closeOnSubmit = false;

Hooks.on("renderApplicationV2", (application, element) => {
	if (!(element instanceof HTMLElement)) return;

	if (application instanceof CareerItemSheet) {
		const selected = normalizedTab(activeTabs.get(application)) || "skills";
		activateTab(element, selected);

		for (const button of element.querySelectorAll("[data-career-tab]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				const tab = normalizedTab(button.dataset.careerTab);
				if (!tab) return;
				activeTabs.set(application, tab);
				activateTab(element, tab);
			});

			button.addEventListener("keydown", (event) => {
				if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
				event.preventDefault();
				const current = normalizedTab(button.dataset.careerTab) || "skills";
				const index = TABS.indexOf(current);
				const delta = event.key === "ArrowRight" ? 1 : -1;
				const next = TABS[(index + delta + TABS.length) % TABS.length];
				activeTabs.set(application, next);
				activateTab(element, next);
				element.querySelector(`[data-career-tab="${next}"]`)?.focus?.();
			});
		}
	}

	renderCharacterCareerAdvances(application, element);
});

/**
 * The printed Character sheet row has two distinct meanings:
 * - the active Career's maximum advance allowance (+10, +2, ...), and
 * - the character's already purchased progress.
 *
 * Keep the existing advancement button/action intact and replace only its
 * presentation. The first eight purchases are shown in a two-row marker block
 * at the top of the cell (four markers per row). Any purchases beyond eight
 * use a separate overflow layer anchored to the bottom edge of the cell.
 */
function renderCharacterCareerAdvances(application, element) {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!element.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	for (const cell of element.querySelectorAll(
		".characteristic-cell--advances[data-characteristic]",
	)) {
		const key = String(cell.dataset.characteristic ?? "").trim();
		if (!key) continue;
		const characteristic = actor.system?.characteristics?.[key];
		if (!characteristic) continue;

		const id = key === "sp" ? "m" : key;
		const purchased = nonNegativeInteger(characteristic.purchased);
		const career = nonNegativeInteger(characteristic.career);
		const unit = ONE_POINT_ADVANCES.has(id) ? 1 : 10;
		const careerValue = career * unit;

		const primaryPurchased = Math.min(
			purchased,
			PRIMARY_PURCHASE_MARKER_CAP,
		);
		const overflowPurchased = Math.max(
			0,
			purchased - PRIMARY_PURCHASE_MARKER_CAP,
		);

		const primaryMarkers = buildMarkerLayer(
			primaryPurchased,
			"characteristic-advance-markers--primary",
		);
		const overflowMarkers = buildMarkerLayer(
			overflowPurchased,
			"characteristic-advance-markers--overflow",
		);

		const allowance = document.createElement("span");
		allowance.className = "characteristic-career-advance-value";
		allowance.textContent = careerValue > 0 ? `+${careerValue}` : "—";

		cell.replaceChildren(primaryMarkers, allowance, overflowMarkers);
		cell.title = localize(
			`Career allowance: ${allowance.textContent}; purchased advances: ${purchased}; career ceiling: ${career}`,
			`Rozwój Profesji: ${allowance.textContent}; wykupione rozwinięcia: ${purchased}; limit Profesji: ${career}`,
		);
	}
}

function buildMarkerLayer(count, modifierClass) {
	const markers = document.createElement("span");
	markers.className = `characteristic-advance-markers ${modifierClass}`;
	markers.setAttribute("aria-hidden", "true");
	markers.hidden = count <= 0;

	for (let index = 0; index < count; index += 1) {
		const marker = document.createElement("span");
		marker.className = "characteristic-advance-marker";
		markers.append(marker);
	}

	return markers;
}

function activateTab(root, selected) {
	const tab = normalizedTab(selected) || "skills";

	for (const button of root.querySelectorAll("[data-career-tab]")) {
		const active = String(button.dataset.careerTab ?? "") === tab;
		button.classList.toggle("is-active", active);
		button.setAttribute("aria-selected", active ? "true" : "false");
		button.tabIndex = active ? 0 : -1;
	}

	for (const panel of root.querySelectorAll("[data-career-panel]")) {
		const active = String(panel.dataset.careerPanel ?? "") === tab;
		panel.hidden = !active;
		panel.classList.toggle("is-active", active);
	}
}

function normalizedTab(value) {
	const tab = String(value ?? "").trim();
	return TABS.includes(tab) ? tab : "";
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
