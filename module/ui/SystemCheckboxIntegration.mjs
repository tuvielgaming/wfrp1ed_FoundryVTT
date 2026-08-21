/*
 * Runtime safety net for the global WFRP1ED checkbox UI convention.
 *
 * New system-owned UI should create checkboxes through WfrpCheckbox (or use
 * equivalent Handlebars markup with `.wfrp1ed-checkbox`). This integration is
 * deliberately defensive: if a raw native checkbox slips into one of our
 * ApplicationV2 windows, normalize it after render so Foundry/browser Accent
 * Color never leaks into the WFRP parchment UI.
 */

const CANONICAL_CHECKBOX_SELECTOR = [
	".wfrp1ed-checkbox",
	".wfrp-rule-effect-selection__row",
	".combat-item-sheet__check",
].join(", ");

Hooks.on("renderApplicationV2", (application, element) => {
	const root = asElement(element) ?? asElement(application?.element);
	if (!(root instanceof HTMLElement)) return;
	if (!isWfrpOwnedApplication(application, root)) return;

	normalizeCheckboxes(root);
});

function normalizeCheckboxes(root) {
	const checkboxes = root.matches?.('input[type="checkbox"]')
		? [root]
		: [...root.querySelectorAll('input[type="checkbox"]')];

	for (const input of checkboxes) {
		if (!(input instanceof HTMLInputElement)) continue;
		if (input.closest(CANONICAL_CHECKBOX_SELECTOR)) continue;

		const wrapper = document.createElement("label");
		wrapper.classList.add("wfrp1ed-checkbox");
		wrapper.dataset.wfrpCheckboxNormalized = "";

		/*
		 * Preserve the native input exactly where it was in the form. FormData,
		 * name/value semantics, checked state and existing event listeners remain
		 * attached to the same input node.
		 */
		input.before(wrapper);
		wrapper.append(input);
	}
}

function isWfrpOwnedApplication(application, root) {
	const configuredClasses = [
		...(application?.options?.classes ?? []),
		...(application?.options?.window?.classes ?? []),
	].map((entry) => String(entry ?? ""));

	if (configuredClasses.some(isWfrpClass)) return true;

	const ownClasses = [...(root.classList ?? [])];
	if (ownClasses.some(isWfrpClass)) return true;

	return Boolean(root.querySelector?.([
		".wfrp1ed",
		".wfrp1ed-classic-sheet",
		".wfrp1ed-modern-sheet",
		".combat-item-sheet",
	].join(", ")));
}

function isWfrpClass(value) {
	const normalized = String(value ?? "").toLowerCase();
	return normalized.includes("wfrp1ed") ||
		normalized.includes("wfrp1e") ||
		normalized === "combat-item-sheet";
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelectorAll === "function") {
		return value;
	}
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelectorAll === "function") {
		return value[0];
	}
	return null;
}
