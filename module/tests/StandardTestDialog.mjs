import { TestManager } from "./TestManager.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Select one audited named Standard Test and gather the minimum runtime
 * context required by its registered definition.
 *
 * This dialog does not resolve Skill applicability yet. That remains a
 * separate Standard Tests step because the core rules leave applicability of
 * potentially relevant Skills to the GM.
 */
export class StandardTestDialog {
	/**
	 * Open the Standard Test selector for one Actor.
	 *
	 * The returned payload is suitable for Actor.rollTest(testId, options) when
	 * all required context is already available. Target-dependent Tests may
	 * deliberately return without a target so the caller can defer target
	 * resolution to the shared pending-chat workflow.
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
					action: "continue",
					label: this._localize(
						"WFRP1ED.StandardTest.Continue",
						"Continue",
						"Dalej",
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

		return response?.confirmed
			? response
			: null;
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

		body.append(
			testGroup.root,
			targetGroup.root,
			noiseGroup.root,
			lockGroup.root,
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
	 * Read and validate launcher form values.
	 *
	 * A target-dependent Test uses a unique already-targeted Token when one is
	 * available. Missing or ambiguous canvas targeting is not an error here;
	 * the caller may defer it to PendingStandardTest instead.
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

		const options = {};

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
					"No single canvas target. Continue to resolve it in chat.",
					"Brak jednego celu na mapie. Kliknij Dalej, aby wybrać go w czacie.",
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

		return group;
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
