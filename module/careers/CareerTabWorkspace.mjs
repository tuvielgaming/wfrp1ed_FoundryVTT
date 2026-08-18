import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const TABS = Object.freeze(["skills", "trappings", "exits"]);
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
	if (!(application instanceof CareerItemSheet)) return;
	if (!(element instanceof HTMLElement)) return;

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
});

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
