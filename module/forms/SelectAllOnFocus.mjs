const SELECTABLE_TYPES = new Set([
	"text",
	"number",
	"search",
	"email",
	"url",
	"tel",
	"password",
]);

/**
 * WFRP sheet forms are primarily numeric/data-entry surfaces rather than prose
 * editors. When a system input receives focus, select its complete current value
 * so the first typed character replaces it instead of being inserted at the
 * clicked caret position. A second click while the field already has focus keeps
 * normal browser caret/selection behaviour.
 *
 * Textareas are intentionally excluded: descriptions and notes remain normal
 * text editors. Native Foundry inputs outside a WFRP application are untouched.
 */
document.addEventListener("focusin", (event) => {
	const input = event.target;
	if (!isManagedInput(input)) return;

	/* Let the pointer/click sequence finish first. Selecting synchronously in the
	 * focus event is commonly undone by the following mouseup in Chromium. */
	setTimeout(() => {
		if (document.activeElement !== input) return;
		try {
			input.select();
		} catch (_error) {
			// Some browser/input combinations do not expose text selection.
		}
	}, 0);
}, true);

function isManagedInput(input) {
	if (!(input instanceof HTMLInputElement)) return false;
	if (input.disabled || input.readOnly) return false;
	if (input.dataset.wfrpPreserveInputSelection !== undefined) return false;
	if (!SELECTABLE_TYPES.has(String(input.type ?? "text").toLowerCase())) return false;

	/* All of our sheets/dialogs use a WFRP root class. This prevents the system
	 * from changing native Foundry search bars or other core application fields. */
	return Boolean(input.closest(
		".wfrp1ed, .career-item-sheet, .wfrp1ed-parchment-window",
	));
}
