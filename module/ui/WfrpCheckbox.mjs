/*
 * Canonical WFRP 1e checkbox markup for system-owned UI.
 *
 * All custom sheets, dialogs, popups and configuration windows must use this
 * helper (or equivalent Handlebars markup with the same `.wfrp1ed-checkbox`
 * contract) instead of exposing Foundry/browser-native checkbox appearance.
 *
 * Visual presentation is owned by css/forms/checkbox.css.
 */
export class WfrpCheckbox {
	/**
	 * Create the canonical checkbox wrapper and native input.
	 *
	 * The native input remains present for ordinary form submission and keyboard
	 * semantics. The wrapper class supplies the stable parchment-safe visual.
	 *
	 * @param {Object} options
	 * @param {string} options.name
	 * @param {boolean} [options.checked=false]
	 * @param {boolean} [options.disabled=false]
	 * @param {string} [options.title=""]
	 * @param {string} [options.ariaLabel=""]
	 * @returns {{root: HTMLLabelElement, input: HTMLInputElement}}
	 */
	static create({
		name,
		checked = false,
		disabled = false,
		title = "",
		ariaLabel = "",
	} = {}) {
		const normalizedName = String(name ?? "").trim();
		if (!normalizedName) {
			throw new Error("WfrpCheckbox requires a non-empty input name.");
		}

		const root = document.createElement("label");
		root.classList.add("wfrp1ed-checkbox");

		const input = document.createElement("input");
		input.type = "checkbox";
		input.name = normalizedName;
		input.checked = checked === true;
		input.disabled = disabled === true;

		if (title) {
			root.title = String(title);
			input.title = String(title);
		}

		if (ariaLabel) {
			input.setAttribute("aria-label", String(ariaLabel));
		}

		root.append(input);
		return { root, input };
	}
}
