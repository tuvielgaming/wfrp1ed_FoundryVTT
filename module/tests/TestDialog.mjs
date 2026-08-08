const { DialogV2 } = foundry.applications.api;

const GENERAL_MODIFIER_ID = "general";

export class TestDialog {
	/**
	 * Allow the user to configure an existing TestContext.
	 *
	 * The supplied context is updated in place and returned when the user
	 * confirms the dialog. Closing or cancelling the dialog returns null.
	 *
	 * @param {TestContext} context
	 * @returns {Promise<TestContext|null>}
	 */
	static async configure(context) {
		if (!context?.actor) {
			throw new Error("TestDialog requires a context with an Actor.");
		}

		if (!context?.test) {
			throw new Error("TestDialog requires a context with a Test.");
		}

		const response = await DialogV2.wait({
			classes: [
				"wfrp1ed",
				"wfrp1ed-parchment-window",
				"wfrp1ed-test-dialog",
			],

			window: {
				title: context.test.name,
			},

			content: this._buildContent(),

			buttons: [
				{
					action: "roll",
					label: this._localize(
						"WFRP1ed.TestDialog.Roll",
						"Roll",
						"Rzuć",
					),
					icon: "fa-solid fa-dice-d100",
					default: true,

					callback: (_event, button) => ({
						confirmed: true,
						modifier: this.readModifier(button.form),
					}),
				},
				{
					action: "cancel",
					label: this._localize(
						"WFRP1ed.TestDialog.Cancel",
						"Cancel",
						"Anuluj",
					),
					icon: "fa-solid fa-xmark",

					callback: () => null,
				},
			],

			rejectClose: false,
		});

		if (!response?.confirmed) {
			return null;
		}

		return this.applyModifier(
			context,
			response.modifier,
		);
	}

	/**
	 * Read the shared situational modifier field from any test form.
	 *
	 * StandardTestDialog reuses this parser so generic modifier semantics stay
	 * in one place even when the control is composed into a larger dialog.
	 *
	 * @param {HTMLFormElement|undefined|null} form
	 * @returns {number}
	 */
	static readModifier(form) {
		const modifierInput = form?.elements?.modifier;
		const modifier = Number(
			modifierInput?.value ?? 0,
		);

		if (!Number.isFinite(modifier)) {
			throw new Error(
				"Test modifier must be a finite number.",
			);
		}

		return modifier;
	}

	/**
	 * Apply the shared general test modifier to an existing TestContext.
	 *
	 * The modifier is always present, including at zero, and carries a stable
	 * identifier so the result chat card can expose exactly this adjudication
	 * value to the GM without confusing it with rule, Skill, or extension
	 * modifiers.
	 *
	 * @param {TestContext} context
	 * @param {number} modifier
	 * @returns {TestContext}
	 */
	static applyModifier(context, modifier) {
		if (!context?.actor || !context?.test) {
			throw new Error(
				"TestDialog modifier application requires a valid TestContext.",
			);
		}

		const value = Number(modifier ?? 0);

		if (!Number.isFinite(value)) {
			throw new Error(
				"Test modifier must be a finite number.",
			);
		}

		const existing = Array.isArray(context.modifiers)
			? context.modifiers.find(
				(entry) => entry?.id === GENERAL_MODIFIER_ID,
			)
			: null;

		if (existing) {
			existing.value = value;
			existing.enabled = true;
			return context;
		}

		context.addModifier({
			id: GENERAL_MODIFIER_ID,
			value,
			source: this._localize(
				"WFRP1ed.TestModifier.Dialog",
				"Dialog modifier",
				"Modyfikator testu",
			),
			type: "situational",
			enabled: true,
		});

		return context;
	}

	/**
	 * Shared localized label for a generic situational test modifier.
	 *
	 * @returns {string}
	 */
	static modifierLabel() {
		return this._localize(
			"WFRP1ed.TestDialog.Modifier",
			"Modifier",
			"Modyfikator",
		);
	}

	/**
	 * Build trusted dialog content.
	 *
	 * Foundry v14 requires an HTMLElement supplied as DialogV2 `content` to
	 * use a plain outermost DIV with no attributes. Styling and form metadata
	 * therefore belong on descendants rather than on this wrapper.
	 *
	 * @returns {HTMLDivElement}
	 * @protected
	 */
	static _buildContent() {
		const content = document.createElement("div");

		const formGroup = document.createElement("div");
		formGroup.classList.add("form-group");

		const label = document.createElement("label");
		label.htmlFor = "wfrp1ed-test-modifier";
		label.textContent = this.modifierLabel();

		const input = document.createElement("input");
		input.id = "wfrp1ed-test-modifier";
		input.name = "modifier";
		input.type = "number";
		input.value = "0";
		input.step = "1";
		input.autocomplete = "off";
		input.autofocus = true;

		formGroup.append(label, input);
		content.append(formGroup);

		return content;
	}

	/**
	 * Localize a label while providing language-aware fallbacks until the
	 * corresponding localization files are audited.
	 *
	 * @param {string} key
	 * @param {string} englishFallback
	 * @param {string} polishFallback
	 * @returns {string}
	 * @protected
	 */
	static _localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);

		if (localized !== key) {
			return localized;
		}

		return game.i18n.lang === "pl"
			? polishFallback
			: englishFallback;
	}
}
