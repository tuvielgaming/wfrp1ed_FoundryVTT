import "./RacePackageDialogStyle.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const TABS = Object.freeze(["features", "skills", "careers", "description"]);
const activeTabs = new WeakMap();

Hooks.on("renderApplicationV2", (application, element) => {
	if (!(application instanceof RaceItemSheet)) return;
	if (!(element instanceof HTMLElement)) return;

	const root = element.querySelector(".race-sheet-content");
	if (!(root instanceof HTMLElement)) return;

	prepareWorkspace(root);
	const selected = normalizedTab(activeTabs.get(application)) || "features";
	activateTab(root, selected);

	for (const button of root.querySelectorAll("[data-race-tab]")) {
		if (button.dataset.raceTabBound === "true") continue;
		button.dataset.raceTabBound = "true";

		button.addEventListener("click", (event) => {
			event.preventDefault();
			const tab = normalizedTab(button.dataset.raceTab);
			if (!tab) return;
			activeTabs.set(application, tab);
			activateTab(root, tab);
		});

		button.addEventListener("keydown", (event) => {
			if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
			event.preventDefault();
			const current = normalizedTab(button.dataset.raceTab) || "features";
			const index = TABS.indexOf(current);
			const delta = event.key === "ArrowRight" ? 1 : -1;
			const next = TABS[(index + delta + TABS.length) % TABS.length];
			activeTabs.set(application, next);
			activateTab(root, next);
			root.querySelector(`[data-race-tab="${next}"]`)?.focus?.();
		});
	}
});

function prepareWorkspace(root) {
	let nav = root.querySelector(".race-tab-nav");
	if (!(nav instanceof HTMLElement)) {
		nav = document.createElement("nav");
		nav.className = "race-tab-nav";
		nav.setAttribute("role", "tablist");
		nav.setAttribute("aria-label", localize("Race details", "Szczegóły Rasy"));
		nav.innerHTML = [
			["features", localize("Racial Features", "Cechy Rasowe")],
			["skills", localize("Skills", "Umiejętności")],
			["careers", localize("Professions", "Profesje")],
			["description", localize("Description", "Opis")],
		].map(([id, label]) => `<button type="button" role="tab" data-race-tab="${id}">${label}</button>`).join("");
		root.querySelector(".race-sheet-header")?.after(nav);
	}

	const panels = [...root.querySelectorAll(":scope > .race-sheet-panel")];
	for (const panel of panels) {
		if (!(panel instanceof HTMLElement)) continue;
		const tab = classifyPanel(panel);
		if (tab === "obsolete") {
			panel.remove();
			continue;
		}
		panel.dataset.racePanel = tab;
	}

	const skillTablePanel = root.querySelector('[data-race-drop-zone="skillTable"]')?.closest?.(".race-sheet-panel");
	const careerTablePanel = root.querySelector('[data-race-drop-zone="careerTable"]')?.closest?.(".race-sheet-panel");
	const skillHeading = skillTablePanel?.querySelector?.("h2");
	const careerHeading = careerTablePanel?.querySelector?.("h2");
	if (skillHeading) skillHeading.textContent = localize("Random Initial Skills", "Losowe Umiejętności Początkowe");
	if (careerHeading) careerHeading.textContent = localize("Random Initial Professions", "Losowe Profesje Początkowe");
}

function classifyPanel(panel) {
	const heading = String(panel.querySelector("h2")?.textContent ?? "").trim().toLocaleLowerCase();
	if (
		panel.querySelector('[data-action="addCareerOverride"]') ||
		panel.querySelector(".race-career-override") ||
		heading === "career class overrides" ||
		heading === "wyjątki klas profesji"
	) return "obsolete";
	if (panel.querySelector('[data-action="addAgeBand"]')) return "skills";
	if (panel.classList.contains("race-mandatory-section")) return "skills";
	if (panel.querySelector('[data-race-drop-zone="skillTable"]')) return "skills";
	if (panel.querySelector('[data-race-drop-zone="careerTable"]')) return "careers";
	if (panel.querySelector('textarea[name="system.description"]')) return "description";
	return "features";
}

function activateTab(root, selected) {
	const tab = normalizedTab(selected) || "features";
	for (const button of root.querySelectorAll("[data-race-tab]")) {
		const active = String(button.dataset.raceTab ?? "") === tab;
		button.classList.toggle("is-active", active);
		button.setAttribute("aria-selected", active ? "true" : "false");
		button.tabIndex = active ? 0 : -1;
	}
	for (const panel of root.querySelectorAll("[data-race-panel]")) {
		const active = String(panel.dataset.racePanel ?? "") === tab;
		panel.hidden = !active;
		panel.classList.toggle("is-active", active);
	}
}

function normalizedTab(value) {
	const tab = String(value ?? "").trim();
	return TABS.includes(tab) ? tab : "";
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
