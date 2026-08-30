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
		panel.classList.toggle("race-skills-panel", tab === "skills");
	}

	const skillTablePanel = root.querySelector('[data-race-drop-zone="skillTable"]')?.closest?.(".race-sheet-panel");
	const careerTablePanel = root.querySelector('[data-race-drop-zone="careerTable"]')?.closest?.(".race-sheet-panel");
	const skillHeading = skillTablePanel?.querySelector?.("h2");
	const careerHeading = careerTablePanel?.querySelector?.("h2");
	if (skillHeading) skillHeading.textContent = localize("Random Initial Skills", "Losowe Umiejętności Początkowe");
	if (careerHeading) careerHeading.textContent = localize("Random Initial Professions", "Losowe Profesje Początkowe");

	enhanceSkillsWorkspace(root);
}

function enhanceSkillsWorkspace(root) {
	const agePanel = root.querySelector('[data-action="addAgeBand"]')?.closest?.(".race-sheet-panel");
	agePanel?.classList?.add("race-skills-panel--age");

	const mandatory = root.querySelector(".race-mandatory-section");
	if (mandatory instanceof HTMLElement) {
		mandatory.classList.add("race-skills-panel--mandatory");
		ensureMandatoryStructure(mandatory);

		const heading = mandatory.querySelector("h2");
		if (heading instanceof HTMLElement && !(heading.parentElement?.classList?.contains("race-mandatory-heading"))) {
			const wrapper = document.createElement("div");
			wrapper.className = "race-mandatory-heading";
			heading.before(wrapper);
			wrapper.append(heading);

			const help = document.createElement("button");
			help.type = "button";
			help.className = "race-help-badge";
			help.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i>';
			const helpText = localize(
				"Mandatory racial Skills are resolved before the remaining random initial Skills. Drop a Skill anywhere in this section to add a standalone entry. Use the package icon on a Skill row to group free Skills. 'Applies from initial Skill count' means the minimum total number of starting Skills required before that racial rule becomes active.",
				"Obowiązkowe Umiejętności rasowe są rozpatrywane przed losowaniem pozostałych Umiejętności początkowych. Upuść Umiejętność w dowolnym miejscu tej sekcji, aby dodać pojedynczy wpis. Użyj ikony pakietu przy wpisie, aby połączyć wolne Umiejętności w grupę. „Obowiązuje od liczby początkowych Umiejętności” oznacza minimalną łączną liczbę Umiejętności początkowych, od której dana reguła rasowa zaczyna obowiązywać.",
			);
			help.title = helpText;
			help.dataset.tooltip = helpText;
			help.setAttribute("aria-label", helpText);
			wrapper.append(help);
		}

		const hint = mandatory.querySelector(".race-sheet-hint");
		if (hint instanceof HTMLElement) {
			hint.textContent = localize(
				"Drop a Skill here to add a standalone mandatory Skill. Use the package icon on a row to create or edit a choice group.",
				"Upuść tutaj Umiejętność, aby dodać pojedynczą obowiązkową Umiejętność. Użyj ikony pakietu przy wpisie, aby utworzyć lub edytować grupę wyboru.",
			);
		}

		const empty = mandatory.querySelector(".race-mandatory-drop-surface .career-empty");
		if (empty instanceof HTMLElement) {
			empty.className = "race-mandatory-empty";
			empty.innerHTML = `
				<i class="fa-solid fa-boxes-stacked" aria-hidden="true"></i>
				<strong>${escapeHtml(localize("No mandatory racial Skills defined", "Brak zdefiniowanych obowiązkowych Umiejętności rasowych"))}</strong>
				<span>${escapeHtml(localize(
					"Drop a Skill into this area to add the first entry. Packages are created later from the package icon on existing rows.",
					"Upuść Umiejętność w tym obszarze, aby dodać pierwszy wpis. Pakiety tworzy się później ikoną pakietu przy istniejących wpisach.",
				))}</span>
			`;
		}
	}

	const skillTablePanel = root.querySelector('[data-race-drop-zone="skillTable"]')?.closest?.(".race-sheet-panel");
	skillTablePanel?.classList?.add("race-skills-panel--random");
}

/* RaceMandatorySkillPackageIntegration historically targets the whole
 * mandatory section because that section is the drop target. Its compact
 * renderer therefore replaces the section contents with the row list. Repair
 * the presentation here, after the ItemSheet render has completed, while
 * keeping the whole section as the drop target so the easy drop UX remains. */
function ensureMandatoryStructure(mandatory) {
	if (mandatory.querySelector(".race-mandatory-drop-surface")) return;

	const renderedEntries = [...mandatory.childNodes];
	mandatory.replaceChildren();

	const heading = document.createElement("h2");
	heading.textContent = localize("Mandatory Racial Skills", "Obowiązkowe Umiejętności rasowe");

	const hint = document.createElement("p");
	hint.className = "race-sheet-hint";

	const surface = document.createElement("div");
	surface.className = "race-drop-zone race-mandatory-drop-surface career-compact-list race-mandatory-compact-list";
	for (const node of renderedEntries) surface.append(node);

	mandatory.append(heading, hint, surface);
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

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
