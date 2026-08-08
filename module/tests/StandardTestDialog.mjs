import { PendingStandardTest } from "./PendingStandardTest.mjs";
import { TestDialog } from "./TestDialog.mjs";
import { TestManager } from "./TestManager.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Select one audited named Standard Test and gather its complete interactive
 * configuration in one composed dialog.
 *
 * Definition-specific context and the generic situational modifier share one
 * UI, while TestDialog still owns modifier parsing/semantics and RollTestAction
 * remains the sole roll/chat execution pipeline.
 */
export class StandardTestDialog {
	/**
	 * Open the Standard Test selector for one Actor.
	 *
	 * The returned payload is suitable for Actor.rollTest(testId, options).
	 * Supplying `options.modifier` marks the generic modifier step as already
	 * configured, so RollTestAction does not open a second TestDialog.
	 *
	 * If a target-dependent Test has no unique canvas target, a pending chat
	 * card is published and null is returned so the roll does not start before
	 * the missing opponent context is resolved.
	 * Closing or cancelling returns null.
	 *
	 * @param {Actor} actor
	 * @returns {Promise<Object|null>}
	 */
	static async configure(actor) {
		if (!actor) {
			throw new Error("StandardTestDialog requires an Actor.");
		}

		const tests = this._namedTests();

		if (tests.length === 0) {
			throw new Error("No named WFRP 1e Standard Tests are registered.");
		}

		const response = await DialogV2.wait({
			classes: [
				"wfrp1ed",
				"wfrp1ed-parchment-window",
				"wfrp1ed-standard-test-dialog",
			],

			window: {
				title: this._localize(
					"WFRP1ED.StandardTest.DialogTitle",
					"Standard Test",
					"Test standardowy",
				),
			},

			content: this._buildContent(tests),

			render: (_event, dialog) =>
				this._activateDialog(dialog, tests),

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

					callback: (_event, button) =>
						this._readForm(actor, button.form, tests),
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

		if (
			PendingStandardTest.needsResolution(
				response.testId,
				response.options,
			)
		) {
			await PendingStandardTest.create(
				actor,
				response.testId,
				response.options,
			);

			return null;
		}

		return response;
	}

	/**
	 * Return registered named Standard Tests only.
	 * Characteristic tests are registered in the same TestManager but do not
	 * carry the `standard` tag used by the named Standard Tests registry.
	 *
	 * @returns {Test[]}
	 * @protected
	 */
	static _namedTests() {
		return TestManager.all()
			.filter((test) => test.tags.includes("standard"))
			.sort((first, second) =>
				first.name.localeCompare(
					second.name,
					game.i18n.lang,
					{ sensitivity: "base" },
				),
			);
	}

	/**
	 * Build trusted DialogV2 content.
	 *
	 * Foundry v14 stringifies HTMLElement dialog content before rendering it.
	 * Therefore interactive listeners are attached later in `_activateDialog`.
	 * Initial field visibility is still resolved here so the serialized markup
	 * starts in a correct state before the dialog reaches the DOM.
	 *
	 * @param {Test[]} tests
	 * @returns {HTMLDivElement}
	 * @protected
	 */
	static _buildContent(tests) {
		const content = document.createElement("div");
		const body = document.createElement("div");
		body.classList.add("standard-test-dialog-body");

		const testGroup = this._formGroup(
			this._localize(
				"WFRP1ED.StandardTest.Test",
				"Test",
				"Test",
			),
		);

		const select = document.createElement("select");
		select.name = "testId";
		select.autofocus = true;

		for (const test of tests) {
			const option = document.createElement("option");
			option.value = test.id;
			option.textContent = test.name;
			select.append(option);
		}

		testGroup.control.append(select);

		const targetGroup = this._formGroup(
			this._localize(
				"WFRP1ED.StandardTest.Target",
				"Target",
				"Cel",
			),
		);
		targetGroup.root.dataset.standardField = "target";
		const targetStatus = document.createElement("div");
		targetStatus.classList.add("standard-test-context-value");
		targetStatus.dataset.standardTargetStatus = "";
		targetGroup.control.append(targetStatus);

		const noiseGroup = this._numberGroup(
			"noise",
			this._localize(
				"WFRP1ED.StandardTest.NoiseChance",
				"Base Listen chance",
				"Bazowa szansa Słuchania",
			),
		);
		noiseGroup.root.dataset.standardField = "noise";

		const lockGroup = this._numberGroup(
			"lockDifficulty",
			this._localize(
				"WFRP1ED.StandardTest.LockDifficulty",
				"Lock rating",
				"Stopień trudności zamka",
			),
		);
		lockGroup.root.dataset.standardField = "lockDifficulty";

		const modifierGroup = this._numberGroup(
			"modifier",
			TestDialog.modifierLabel(),
		);
		modifierGroup.input.value = "0";
		modifierGroup.input.placeholder = "0";

		body.append(
			testGroup.root,
			targetGroup.root,
			noiseGroup.root,
			lockGroup.root,
			modifierGroup.root,
		);
		content.append(body);

		this._refreshContextFields(body, tests[0]);

		return content;
	}

	/**
	 * Attach interaction to the rendered DialogV2 DOM.
	 *
	 * DialogV2 stringifies HTMLElement content, so listeners added to the
	 * detached element returned by `_buildContent` do not survive rendering.
	 * Foundry v14 provides the `render` callback specifically for this stage.
	 *
	 * @param {DialogV2} dialog
	 * @param {Test[]} tests
	 * @returns {void}
	 * @protected
	 */
	static _activateDialog(dialog, tests) {
		const root = dialog?.element;
		const body = root?.querySelector?.(
			".standard-test-dialog-body",
		);
		const select = root?.querySelector?.(
			'select[name="testId"]',
		);

		if (!body || !select) {
			return;
		}

		const refresh = () =>
			this._refreshContextFields(
				body,
				tests.find((test) => test.id === select.value),
			);

		select.addEventListener("change", refresh);
		refresh();
	}

	/**
	 * Read and validate the complete composed Standard Test form.
	 *
	 * A target-dependent Test uses a unique already-targeted Token when one is
	 * available. Missing or ambiguous canvas targeting is not an error here;
	 * configure() may defer it to PendingStandardTest instead.
	 *
	 * The generic modifier is always present, including zero. Its presence in
	 * the returned options tells RollTestAction that the generic configuration
	 * step was already completed in this composed dialog.
	 *
	 * @param {Actor} actor
	 * @param {HTMLFormElement} form
	 * @param {Test[]} tests
	 * @returns {Object}
	 * @protected
	 */
	static _readForm(actor, form, tests) {
		const testId = String(
			form?.elements?.testId?.value ?? "",
		).trim();

		const test = tests.find((entry) => entry.id === testId);

		if (!test) {
			throw new Error("Select a valid WFRP 1e Standard Test.");
		}

		const options = {
			modifier: TestDialog.readModifier(form),
		};

		if (test.tags.includes("requires-target")) {
			const target = this._singleTargetActor(actor);

			if (target) {
				options.target = target;
			}
		}

		if (test.tags.includes("requires-noise-level")) {
			options.noise = this._requiredNumber(
				form?.elements?.noise,
				this._localize(
					"WFRP1ED.StandardTest.NoiseChance",
					"Base Listen chance",
					"Bazowa szansa Słuchania",
				),
			);
		}

		if (test.tags.includes("requires-lock-rating")) {
			options.lockDifficulty = this._requiredNumber(
				form?.elements?.lockDifficulty,
				this._localize(
					"WFRP1ED.StandardTest.LockDifficulty",
					"Lock rating",
					"Stopień trudności zamka",
				),
			);
		}

		return {
			confirmed: true,
			testId,
			options,
		};
	}

	/**
	 * Show only context controls required by the selected definition.
	 *
	 * The generic modifier row is intentionally not tagged with
	 * `data-standard-field`, so it remains visible for every Standard Test.
	 *
	 * @param {HTMLElement} body
	 * @param {Test|undefined} test
	 * @returns {void}
	 * @protected
	 */
	static _refreshContextFields(body, test) {
		const requirements = new Set();

		if (test?.tags.includes("requires-target")) {
			requirements.add("target");
		}

		if (test?.tags.includes("requires-noise-level")) {
			requirements.add("noise");
		}

		if (test?.tags.includes("requires-lock-rating")) {
			requirements.add("lockDifficulty");
		}

		for (const element of body.querySelectorAll("[data-standard-field]")) {
			element.hidden = !requirements.has(
				element.dataset.standardField,
			);
		}

		const targetStatus = body.querySelector(
			"[data-standard-target-status]",
		);

		if (targetStatus && requirements.has("target")) {
			const targets = [...(game.user?.targets ?? [])];

			targetStatus.textContent = targets.length === 1
				? targets[0].actor?.name ?? targets[0].name ?? "—"
				: this._localize(
					"WFRP1ED.StandardTest.TargetDeferred",
					"No single canvas target. Roll to resolve it in chat.",
					"Brak jednego celu na mapie. Kliknij Rzuć, aby wybrać go w czacie.",
				);
		}
	}

	/**
	 * Resolve exactly one user-targeted Actor.
	 *
	 * @returns {Actor|null}
	 * @protected
	 */
	static _singleTargetActor() {
		const targets = [...(game.user?.targets ?? [])];

		if (targets.length !== 1) {
			return null;
		}

		return targets[0].actor ?? null;
	}

	static _formGroup(labelText) {
		const root = document.createElement("div");
		root.classList.add("form-group", "standard-test-form-group");

		const label = document.createElement("label");
		label.textContent = labelText;

		const control = document.createElement("div");
		control.classList.add("form-fields");

		root.append(label, control);

		return { root, control };
	}

	static _numberGroup(name, labelText) {
		const group = this._formGroup(labelText);
		const input = document.createElement("input");
		input.type = "number";
		input.name = name;
		input.step = "1";
		input.autocomplete = "off";
		input.placeholder = "—";
		group.control.append(input);

		return {
			...group,
			input,
		};
	}

	static _requiredNumber(input, label) {
		const raw = String(input?.value ?? "").trim();

		if (!raw) {
			throw new Error(`${label}: value is required.`);
		}

		const value = Number(raw);

		if (!Number.isFinite(value)) {
			throw new Error(`${label}: value must be a finite number.`);
		}

		return value;
	}

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
