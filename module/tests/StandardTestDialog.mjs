import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { MovementStandardTest } from "./MovementStandardTest.mjs";
import { PendingStandardTest } from "./PendingStandardTest.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "./standard-test-procedures.mjs";
import { StandardTestSkillResolver } from "./StandardTestSkillResolver.mjs";
import { TestDialog } from "./TestDialog.mjs";
import { TestManager } from "./TestManager.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Select one audited named Standard Test or Standard-Test procedure and gather
 * its complete interactive configuration in one composed dialog.
 *
 * Percentile Tests continue through Actor.rollTest/TestDialog/TestResult.
 * Non-d100 procedures such as Jumping/Leaping are dispatched to their own
 * audited executor instead of being forced through the generic Test contract.
 */
export class StandardTestDialog {
	/**
	 * Open the Standard Test selector for one Actor.
	 *
	 * Percentile Test responses are suitable for Actor.rollTest(testId, options).
	 * Supplying `options.modifier` marks the generic modifier step as already
	 * configured, so RollTestAction does not open a second TestDialog.
	 *
	 * Movement procedure selections execute inside this launcher and return null
	 * afterward so ClassicActorSheet does not attempt a second d100 execution.
	 *
	 * If a target-dependent percentile Test has no unique canvas target, a
	 * pending chat card is published and null is returned until the missing
	 * opponent context is resolved.
	 *
	 * Closing or cancelling returns null.
	 *
	 * @param {Actor} actor
	 * @returns {Promise<Object|null>}
	 */
	static async configure(actor) {
		if (!actor) {
			throw new Error("StandardTestDialog requires an Actor.");
		}

		const entries = this._entries();

		if (entries.length === 0) {
			throw new Error("No WFRP 1e Standard Tests are registered.");
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

			content: this._buildContent(actor, entries),

			render: (_event, dialog) =>
				this._activateDialog(dialog, actor, entries),

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
						this._readForm(actor, button.form, entries),
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

		if (response.kind === "procedure") {
			await MovementStandardTest.execute(
				actor,
				response.procedureId,
				response.options,
			);

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
	 * Return all entries exposed by the Standard Test launcher.
	 *
	 * TestManager contributes audited d100 Standard Tests. The procedure registry
	 * contributes audited non-d100 procedures such as Jumping/Leaping. Keeping
	 * the kinds explicit prevents movement mechanics from leaking into Test.
	 *
	 * Each entry also declares stable Active Effect rule targets consumed by that
	 * execution so the dialog can show only relevant effects.
	 *
	 * @returns {Array<Object>}
	 * @protected
	 */
	static _entries() {
		const tests = TestManager.all()
			.filter((test) => test.tags.includes("standard"))
			.map((test) => ({
				id: test.id,
				kind: "test",
				name: test.name,
				tags: test.tags,
				test,
				effectTargets: [
					RuleEffectRollSelection.targetIdForTest(test),
				].filter(Boolean),
			}));

		const procedures = Object.values(
			STANDARD_TEST_PROCEDURES,
		).map((procedure) => ({
			id: procedure.id,
			kind: "procedure",
			name: standardTestProcedureName(procedure),
			tags: procedure.tags,
			procedure,
			effectTargets: [...(procedure.effectTargets ?? [])],
		}));

		return [...tests, ...procedures].sort((first, second) =>
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
	 * Initial field/effect visibility is still resolved here so the serialized
	 * markup starts in a correct state before the dialog reaches the DOM.
	 *
	 * @param {Actor} actor
	 * @param {Array<Object>} entries
	 * @returns {HTMLDivElement}
	 * @protected
	 */
	static _buildContent(actor, entries) {
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

		for (const entry of entries) {
			const option = document.createElement("option");
			option.value = entry.id;
			option.textContent = entry.name;
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

		const jumpHeightGroup = this._numberGroup(
			"jumpHeight",
			this._localize(
				"WFRP1ED.StandardTest.JumpHeight",
				"Jump height",
				"Wysokość zeskoku",
			),
		);
		jumpHeightGroup.root.dataset.standardField = "jumpHeight";
		jumpHeightGroup.input.step = "any";
		jumpHeightGroup.input.min = "0.01";

		const leapGapGroup = this._numberGroup(
			"leapGap",
			this._localize(
				"WFRP1ED.StandardTest.LeapGap",
				"Gap to clear",
				"Dystans do pokonania",
			),
		);
		leapGapGroup.root.dataset.standardField = "leapGap";
		leapGapGroup.input.step = "any";
		leapGapGroup.input.min = "0.01";

		const runUpGroup = this._formGroup(
			this._localize(
				"WFRP1ED.StandardTest.RunUp",
				"Run-up of at least 2 yards",
				"Rozbieg co najmniej 2 m",
			),
		);
		runUpGroup.root.dataset.standardField = "runUp";
		const runUpInput = document.createElement("input");
		runUpInput.type = "checkbox";
		runUpInput.name = "runUp";
		runUpInput.checked = true;
		runUpGroup.control.append(runUpInput);

		const modifierGroup = this._numberGroup(
			"modifier",
			TestDialog.modifierLabel(),
		);
		modifierGroup.input.value = "0";
		modifierGroup.input.placeholder = "0";
		modifierGroup.root.dataset.standardD100Only = "";

		const skillSection = document.createElement("div");
		skillSection.dataset.standardSkillEffects = "";
		skillSection.dataset.standardD100Only = "";

		const effectsSection = RuleEffectRollSelection.buildSection(
			actor,
			entries[0]?.effectTargets ?? [],
		);

		body.append(
			testGroup.root,
			targetGroup.root,
			noiseGroup.root,
			lockGroup.root,
			jumpHeightGroup.root,
			leapGapGroup.root,
			runUpGroup.root,
			modifierGroup.root,
			skillSection,
			effectsSection,
		);

		if (game.user?.isGM) {
			const visibilityGroup = this._formGroup(
				TestDialog.resultVisibilityLabel(),
			);
			visibilityGroup.root.dataset.standardD100Only = "";
			const visibilitySelect = document.createElement("select");
			visibilitySelect.name = "resultVisibility";

			for (const entry of TestDialog.resultVisibilityOptions()) {
				const option = document.createElement("option");
				option.value = entry.value;
				option.textContent = entry.label;
				visibilitySelect.append(option);
			}

			visibilityGroup.control.append(visibilitySelect);
			body.append(visibilityGroup.root);
		}

		content.append(body);

		this._refreshContextFields(body, entries[0], actor);

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
	 * @param {Actor} actor
	 * @param {Array<Object>} entries
	 * @returns {void}
	 * @protected
	 */
	static _activateDialog(dialog, actor, entries) {
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
				entries.find((entry) => entry.id === select.value),
				actor,
			);

		select.addEventListener("change", refresh);
		refresh();
	}

	/**
	 * Read and validate the complete composed Standard Test form.
	 *
	 * Percentile Tests keep the existing target/noise/lock/modifier contracts.
	 * Movement procedures read only the inputs required by their audited rules.
	 * Both kinds persist a per-roll rule-effect selection snapshot without
	 * changing any underlying ActiveEffect enabled/disabled state.
	 *
	 * @param {Actor} actor
	 * @param {HTMLFormElement} form
	 * @param {Array<Object>} entries
	 * @returns {Object}
	 * @protected
	 */
	static _readForm(actor, form, entries) {
		const id = String(
			form?.elements?.testId?.value ?? "",
		).trim();

		const entry = entries.find((candidate) => candidate.id === id);

		if (!entry) {
			throw new Error("Select a valid WFRP 1e Standard Test.");
		}

		const ruleEffects = RuleEffectRollSelection.snapshotFromForm(
			actor,
			entry.effectTargets,
			form,
		);

		if (entry.kind === "procedure") {
			const options = { ruleEffects };

			if (entry.tags.includes("requires-jump-height")) {
				options.jumpHeight = this._requiredPositiveNumber(
					form?.elements?.jumpHeight,
					this._localize(
						"WFRP1ED.StandardTest.JumpHeight",
						"Jump height",
						"Wysokość zeskoku",
					),
				);
			}

			if (entry.tags.includes("requires-leap-gap")) {
				options.leapGap = this._requiredPositiveNumber(
					form?.elements?.leapGap,
					this._localize(
						"WFRP1ED.StandardTest.LeapGap",
						"Gap to clear",
						"Dystans do pokonania",
					),
				);
			}

			if (entry.tags.includes("requires-run-up")) {
				options.runUp = Boolean(
					form?.elements?.runUp?.checked,
				);
			}

			return {
				confirmed: true,
				kind: "procedure",
				procedureId: entry.id,
				options,
			};
		}

		const test = entry.test;
		const options = {
			modifier: TestDialog.readModifier(form),
			modifiers: this._readSkillModifiers(actor, test.id, form),
			resultVisibility: TestDialog.readResultVisibility(form),
			ruleEffects,
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
			kind: "test",
			testId: test.id,
			options,
		};
	}

	/**
	 * Show only context controls required by the selected launcher entry and
	 * refresh the relevant Active Effect choices for that same entry.
	 *
	 * Generic modifier/result-detail controls apply only to d100 Tests. Movement
	 * procedures have their own dice semantics and therefore do not expose a
	 * misleading percentile modifier field.
	 *
	 * @param {HTMLElement} body
	 * @param {Object|undefined} entry
	 * @param {Actor} actor
	 * @returns {void}
	 * @protected
	 */
	static _refreshContextFields(body, entry, actor) {
		const requirements = new Set();
		const tags = entry?.tags ?? [];

		if (tags.includes("requires-target")) {
			requirements.add("target");
		}

		if (tags.includes("requires-noise-level")) {
			requirements.add("noise");
		}

		if (tags.includes("requires-lock-rating")) {
			requirements.add("lockDifficulty");
		}

		if (tags.includes("requires-jump-height")) {
			requirements.add("jumpHeight");
		}

		if (tags.includes("requires-leap-gap")) {
			requirements.add("leapGap");
		}

		if (tags.includes("requires-run-up")) {
			requirements.add("runUp");
		}

		for (const element of body.querySelectorAll("[data-standard-field]")) {
			element.hidden = !requirements.has(
				element.dataset.standardField,
			);
		}

		for (const element of body.querySelectorAll("[data-standard-d100-only]")) {
			element.hidden = entry?.kind !== "test";
		}

		const skillSection = body.querySelector(
			"[data-standard-skill-effects]",
		);

		if (skillSection) {
			this._renderSkillSection(skillSection, actor, entry);
		}

		const effectSection = body.querySelector(
			"[data-wfrp-rule-effects]",
		);

		if (effectSection) {
			RuleEffectRollSelection.renderSection(
				effectSection,
				actor,
				entry?.effectTargets ?? [],
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
	 * Render owned Skill effects which can be represented safely as ordinary
	 * additive Test modifiers.
	 *
	 * A rules-linked owned Skill is enabled by default because its audited
	 * Standard Test modifier is part of the character's capability. The checkbox
	 * remains available for the exceptional fictional situation in which the GM
	 * decides that the otherwise relevant Skill does not apply to this roll.
	 * Procedure, choice, derived, and target-side effects are deliberately not
	 * coerced into numeric modifiers here; they remain owned by their specialized
	 * rule executors.
	 *
	 * @param {HTMLElement} section
	 * @param {Actor} actor
	 * @param {Object|undefined} entry
	 * @returns {void}
	 * @protected
	 */
	static _renderSkillSection(section, actor, entry) {
		section.replaceChildren();

		if (entry?.kind !== "test") {
			section.hidden = true;
			return;
		}

		const candidates = StandardTestSkillResolver.candidates(
			actor,
			entry.id,
		);
		const rows = [];

		for (const candidate of candidates) {
			candidate.effects.forEach((effect, effectIndex) => {
				const modifier = this._skillModifierForEffect(
					candidate,
					effect,
				);

				if (!modifier || modifier.value === 0) {
					return;
				}

				rows.push({
					candidate,
					effectIndex,
					modifier,
				});
			});
		}

		if (rows.length === 0) {
			section.hidden = true;
			return;
		}

		section.hidden = false;

		const group = this._formGroup(
			this._localize(
				"WFRP1ED.StandardTest.SkillModifiers",
				"Applicable Skills",
				"Odpowiednie umiejętności",
			),
		);
		const list = document.createElement("div");
		list.classList.add("standard-test-skill-effects");

		for (const row of rows) {
			const label = document.createElement("label");
			label.classList.add(
				"standard-test-skill-effect",
				"wfrp1ed-checkbox",
			);
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.name = "standardSkillModifier";
			checkbox.dataset.standardSkillModifier = "";
			checkbox.dataset.skillId = row.candidate.rulesId;
			checkbox.dataset.effectIndex = String(row.effectIndex);
			checkbox.checked = true;

			const text = document.createElement("span");
			text.textContent = `${row.candidate.name} ${this._signed(row.modifier.value)}`;

			label.append(checkbox, text);
			list.append(label);
		}

		group.control.append(list);
		section.append(group.root);
	}

	/**
	 * Read the Skill choices rendered for one Standard Test and convert them to
	 * the existing TestContext modifier contract.
	 *
	 * @param {Actor} actor
	 * @param {string} testId
	 * @param {HTMLFormElement} form
	 * @returns {Array<Object>}
	 * @protected
	 */
	static _readSkillModifiers(actor, testId, form) {
		const candidates = StandardTestSkillResolver.candidates(
			actor,
			testId,
		);
		const bySkillId = new Map(
			candidates.map((candidate) => [candidate.rulesId, candidate]),
		);
		const modifiers = [];

		for (const input of form?.querySelectorAll?.(
			"input[data-standard-skill-modifier]:checked",
		) ?? []) {
			const skillId = String(input.dataset.skillId ?? "").trim();
			const effectIndex = Number(input.dataset.effectIndex);
			const candidate = bySkillId.get(skillId);
			const effect = Number.isInteger(effectIndex)
				? candidate?.effects?.[effectIndex]
				: null;
			const modifier = this._skillModifierForEffect(candidate, effect);

			if (modifier) {
				modifiers.push(modifier);
			}
		}

		return modifiers;
	}

	/**
	 * Convert one audited Skill effect to the generic Test modifier shape when
	 * that conversion is mechanically exact.
	 *
	 * @param {Object|undefined} candidate
	 * @param {Object|undefined} effect
	 * @returns {Object|null}
	 * @protected
	 */
	static _skillModifierForEffect(candidate, effect) {
		if (!candidate || !effect || effect.condition) {
			return null;
		}

		let value;

		if (effect.type === "modifier") {
			value = Number(effect.value);
		} else if (effect.type === "repeated-acquisition-modifier") {
			value =
				Math.max(0, Number(candidate.acquisitions) - 1) *
				Number(effect.valuePerExtraAcquisition);
		} else {
			return null;
		}

		if (!Number.isFinite(value)) {
			throw new Error(
				`Invalid Standard Test Skill modifier for '${candidate.rulesId}'.`,
			);
		}

		return {
			id: `skill:${candidate.rulesId}:${effect.type}`,
			value,
			source: candidate.name,
			type: "skill",
			enabled: true,
		};
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

	static _requiredPositiveNumber(input, label) {
		const value = this._requiredNumber(input, label);

		if (value <= 0) {
			throw new Error(`${label}: value must be greater than zero.`);
		}

		return value;
	}

	static _signed(value) {
		const number = Number(value);
		return number >= 0 ? `+${number}` : String(number);
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
