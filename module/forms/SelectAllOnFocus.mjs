const SELECTABLE_TYPES = new Set([
	"text",
	"number",
	"search",
	"email",
	"url",
	"tel",
	"password",
]);

const replaceOnNextInsert = new WeakSet();

/**
 * WFRP sheet forms are primarily data-entry surfaces rather than prose editors.
 * When a system input receives focus, its current value becomes replace-on-type:
 * the first typed/pasted value replaces the whole previous value instead of
 * being inserted at the clicked caret position.
 *
 * Text-like controls are additionally selected visually. Number inputs are not
 * consistently selectable across browsers, so beforeinput provides the actual
 * replacement guarantee for them as well.
 *
 * A second click while the field is already focused cancels replace-on-type and
 * restores ordinary caret editing. Textareas are intentionally excluded.
 */
document.addEventListener("focusin", (event) => {
	const input = event.target;
	if (!isManagedInput(input)) return;

	replaceOnNextInsert.add(input);

	/* Let the pointer/click sequence finish first. Selecting synchronously in the
	 * focus event is commonly undone by the following mouseup in Chromium. */
	setTimeout(() => {
		if (document.activeElement !== input) return;
		try {
			input.select();
		} catch (_error) {
			// beforeinput below still guarantees replacement for number inputs.
		}
	}, 0);
}, true);

/* A deliberate second click means the user wants normal caret editing rather
 * than replacing the whole value. The first click occurs before focusin and
 * therefore does not cancel the newly-created replace marker. */
document.addEventListener("pointerdown", (event) => {
	const input = event.target;
	if (!isManagedInput(input)) return;
	if (document.activeElement === input) replaceOnNextInsert.delete(input);
}, true);

document.addEventListener("keydown", (event) => {
	const input = event.target;
	if (!isManagedInput(input)) return;
	if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
		replaceOnNextInsert.delete(input);
	}
}, true);

document.addEventListener("beforeinput", (event) => {
	const input = event.target;
	if (!isManagedInput(input)) return;
	if (!replaceOnNextInsert.has(input)) return;

	const inputType = String(event.inputType ?? "");
	if (!inputType.startsWith("insert")) return;

	replaceOnNextInsert.delete(input);
	input.value = "";
}, true);

document.addEventListener("focusout", (event) => {
	if (event.target instanceof HTMLInputElement) {
		replaceOnNextInsert.delete(event.target);
	}
}, true);

function isManagedInput(input) {
	if (!(input instanceof HTMLInputElement)) return false;
	if (input.disabled || input.readOnly) return false;
	if (input.dataset.wfrpPreserveInputSelection !== undefined) return false;
	if (!SELECTABLE_TYPES.has(String(input.type ?? "text").toLowerCase())) return false;

	/* Editable combat result inputs live in ChatMessage cards rather than under
	 * the normal sheet/dialog roots below. Keep the same system-wide replace-on-
	 * focus contract for physical/adjudicated roll entry without affecting native
	 * Foundry chat/search inputs. */
	if (input.matches(
		"[data-wfrp-detailed-critical-roll-input], " +
		"[data-wfrp-damage-dice-total]",
	)) {
		return true;
	}

	/* All of our sheets/dialogs use a WFRP root class. This prevents the system
	 * from changing native Foundry search bars or other core application fields. */
	return Boolean(input.closest(
		".wfrp1ed, .career-item-sheet, .wfrp1ed-parchment-window",
	));
}
