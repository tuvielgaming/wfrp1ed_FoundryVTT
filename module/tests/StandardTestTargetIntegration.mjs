import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import { FormulaResolver } from "./FormulaResolver.mjs";
import { PendingStandardTest } from "./PendingStandardTest.mjs";
import { StandardTestDialog } from "./StandardTestDialog.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const TARGET_SELECTION_MANUAL = "__manual__";

/*
 * Shared Standard Test target workflow.
 *
 * Target-dependent Standard Tests use the same ActorTargetResolver service as
 * attacks: current canvas target, visible scene-token choices and GM world-Actor
 * choice. An explicit no-Actor/manual mode supplies the characteristic value
 * required by the registered Test formula.
 *
 * The target Actor remains authoritative when present. Manual targetValues are
 * fallback inputs and are used only when no selected Actor value is available.
 * Formula-result snapshots keep the actual target.* variable editable in chat;
 * adjudication changes the stored result snapshot only and never mutates Actor
 * characteristics or rerolls the d100.
 */
installTargetDialog();
registerTargetResultAdjudication();

function installTargetDialog() {
	if (StandardTestDialog.__wfrpTargetPickerInstalled === true) return;
	Object.defineProperty(StandardTestDialog, "__wfrpTargetPickerInstalled", {
		value: true,
		configurable: false,
	});

	const originalBuildContent = StandardTestDialog._buildContent;
	const originalActivateDialog = StandardTestDialog._activateDialog;
	const originalReadForm = StandardTestDialog._readForm;

	StandardTestDialog._buildContent = function (actor, entries) {
		const content = originalBuildContent.call(this, actor, entries);
		const body = content?.querySelector?.(".standard-test-dialog-body");
		const targetRoot = body?.querySelector?.('[data-standard-field="target"]');
		const control = targetRoot?.querySelector?.(".form-fields");
		if (!(control instanceof HTMLElement)) return content;

		control.replaceChildren(buildTargetPicker(entries[0]));
		return content;
	};

	StandardTestDialog._activateDialog = function (dialog, actor, entries) {
		originalActivateDialog.call(this, dialog, actor, entries);
		activateTargetPicker(dialog, entries);
	};

	StandardTestDialog._readForm = function (actor, form, entries) {
		const response = originalReadForm.call(this, actor, form, entries);
		if (response?.kind !== "test") return response;

		const entry = entries.find((candidate) => candidate.id === response.testId);
		if (!entry?.tags?.includes("requires-target")) return response;

		const selection = String(
			form?.elements?.standardTargetSelection?.value ?? TARGET_SELECTION_MANUAL,
		).trim();
		const targetUuid = String(
			form?.elements?.standardTargetUuid?.value ?? "",
		).trim();
		const target = selection !== TARGET_SELECTION_MANUAL
			? ActorTargetResolver.actorFromUuidSync(targetUuid || selection)
			: null;
		const targetValues = readManualTargetValues(form);

		/* Explicit picker state overrides the old implicit single-canvas-target
		 * fallback used by StandardTestDialog itself. */
		delete response.options.target;
		delete response.options.targetActor;

		if (target) {
			response.options.target = target;
		}

		/* Keep any entered values as fallback metadata even with a selected Actor.
		 * FormulaResolver gives the Actor value priority. */
		if (Object.keys(targetValues).length > 0) {
			response.options.targetValues = targetValues;
		} else {
			delete response.options.targetValues;
		}

		return response;
	};
}

function buildTargetPicker(initialEntry) {
	const wrapper = document.createElement("div");
	wrapper.classList.add("standard-test-target-picker");

	const initialTarget = ActorTargetResolver.singleTargetActor();
	const selection = document.createElement("select");
	selection.name = "standardTargetSelection";
	selection.dataset.standardTargetSelection = "";

	appendOption(
		selection,
		TARGET_SELECTION_MANUAL,
		localize("No Actor — enter target value", "Bez Aktora — wpisz wartość celu"),
	);

	for (const entry of ActorTargetResolver.sceneTokenTargets()) {
		appendOption(selection, entry.actorUuid, entry.name, entry.name);
	}

	if (initialTarget) {
		ensureTargetOption(selection, initialTarget);
		selection.value = initialTarget.uuid;
	} else {
		selection.value = TARGET_SELECTION_MANUAL;
	}

	const targetUuid = document.createElement("input");
	targetUuid.type = "hidden";
	targetUuid.name = "standardTargetUuid";
	targetUuid.value = String(initialTarget?.uuid ?? "");

	const status = document.createElement("div");
	status.classList.add("standard-test-context-value");
	status.dataset.standardTargetPickerStatus = "";

	const actions = document.createElement("div");
	actions.classList.add("standard-test-target-actions");
	actions.append(
		targetButton(
			"current-target",
			localize("Use current target", "Użyj aktualnego celu"),
			"fa-solid fa-bullseye",
		),
		targetButton(
			"manual-target",
			localize("No Actor", "Bez Aktora"),
			"fa-solid fa-keyboard",
		),
	);

	if (game.user?.isGM) {
		actions.append(
			targetButton(
				"choose-actor",
				localize("Choose Actor", "Wybierz Aktora"),
				"fa-solid fa-user",
			),
		);
	}

	const values = document.createElement("div");
	values.classList.add("standard-test-target-values");
	values.dataset.standardTargetValues = "";
	populateManualInputs(values, initialEntry);

	const warning = document.createElement("div");
	warning.classList.add("standard-test-context-value");
	warning.dataset.standardTargetWarning = "";
	warning.setAttribute("role", "alert");
	warning.hidden = true;

	wrapper.append(selection, targetUuid, status, actions, values, warning);
	return wrapper;
}

function activateTargetPicker(dialog, entries) {
	const root = dialog?.element;
	const selection = root?.querySelector?.('[name="standardTargetSelection"]');
	const uuid = root?.querySelector?.('[name="standardTargetUuid"]');
	const status = root?.querySelector?.("[data-standard-target-picker-status]");
	const actions = root?.querySelector?.(".standard-test-target-actions");
	const values = root?.querySelector?.("[data-standard-target-values]");
	const warning = root?.querySelector?.("[data-standard-target-warning]");
	const testSelect = root?.querySelector?.('[name="testId"]');
	const rollButton = root?.querySelector?.('button[data-action="roll"]');
	const form = rollButton?.form ?? root?.querySelector?.("form");

	if (
		!(selection instanceof HTMLSelectElement) ||
		!(uuid instanceof HTMLInputElement) ||
		!(status instanceof HTMLElement) ||
		!(actions instanceof HTMLElement) ||
		!(values instanceof HTMLElement) ||
		!(testSelect instanceof HTMLSelectElement)
	) return;

	const currentEntry = () =>
		entries.find((entry) => entry.id === testSelect.value);

	const setTarget = (target) => {
		if (!target) return;
		ensureTargetOption(selection, target);
		selection.value = String(target.uuid ?? "");
		uuid.value = String(target.uuid ?? "");
	};

	const clearWarning = () => {
		if (!warning) return;
		warning.hidden = true;
		warning.textContent = "";
	};

	const refresh = () => {
		const entry = currentEntry();
		populateManualInputs(values, entry, readManualTargetValues(form));

		if (!entry?.tags?.includes("requires-target")) {
			clearWarning();
			return;
		}

		const manual = selection.value === TARGET_SELECTION_MANUAL;
		values.hidden = !manual;

		if (manual) {
			uuid.value = "";
			status.textContent = localize(
				"No target Actor — use the characteristic value below.",
				"Brak Aktora celu — użyj poniższej wartości cechy.",
			);
			return;
		}

		const target = ActorTargetResolver.actorFromUuidSync(selection.value);
		if (target) {
			uuid.value = String(target.uuid ?? "");
			status.textContent = String(
				selection.selectedOptions?.[0]?.dataset?.targetName ??
				target.name ??
				localize("Selected target", "Wybrany cel"),
			);
			return;
		}

		selection.value = TARGET_SELECTION_MANUAL;
		uuid.value = "";
		values.hidden = false;
		status.textContent = localize(
			"No target Actor — use the characteristic value below.",
			"Brak Aktora celu — użyj poniższej wartości cechy.",
		);
	};

	selection.addEventListener("change", () => {
		clearWarning();
		refresh();
	});

	testSelect.addEventListener("change", () => {
		clearWarning();
		refresh();
	});

	for (const button of actions.querySelectorAll("[data-standard-target-action]")) {
		button.addEventListener("click", async (event) => {
			event.preventDefault();
			const action = button.dataset.standardTargetAction;

			if (action === "manual-target") {
				selection.value = TARGET_SELECTION_MANUAL;
				clearWarning();
				refresh();
				return;
			}

			let target = null;
			if (action === "current-target") {
				target = ActorTargetResolver.singleTargetActor();
				if (!target) {
					ui.notifications.warn(localize(
						"Target exactly one token on the canvas, then press this button again.",
						"Wskaż dokładnie jeden token na mapie, a następnie ponownie naciśnij ten przycisk.",
					));
					return;
				}
			} else if (action === "choose-actor" && game.user?.isGM) {
				target = await ActorTargetResolver.chooseActor();
			}

			if (!target) return;
			setTarget(target);
			clearWarning();
			refresh();
		});
	}

	const validate = (event) => {
		const entry = currentEntry();
		if (
			!entry?.tags?.includes("requires-target") ||
			selection.value !== TARGET_SELECTION_MANUAL
		) return true;

		const missing = [...values.querySelectorAll("input[data-target-characteristic]")]
			.find((input) => {
				const raw = String(input.value ?? "").trim();
				return !raw || !Number.isFinite(Number(raw));
			});
		if (!missing) {
			clearWarning();
			return true;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		const label = missing.dataset.targetCharacteristicLabel ||
			localize("target characteristic", "cecha celu");
		const message = localize(
			`Enter a valid ${label} value or select a target Actor before rolling.`,
			`Wprowadź prawidłową wartość „${label}” albo wybierz Aktora celu przed rzutem.`,
		);
		if (warning) {
			warning.textContent = message;
			warning.hidden = false;
		}
		missing.focus();
		return false;
	};

	rollButton?.addEventListener("click", validate, true);
	form?.addEventListener("submit", validate, true);
	refresh();
}

function populateManualInputs(container, entry, existing = {}) {
	if (!(container instanceof HTMLElement)) return;
	const requirements = entry?.kind === "test" && entry.tags?.includes("requires-target")
		? PendingStandardTest.targetRequirements(entry.test)
		: [];
	const current = { ...existing, ...readManualTargetValues(container.closest("form")) };
	container.replaceChildren();

	for (const id of requirements) {
		const row = document.createElement("div");
		row.classList.add("standard-test-target-value-row");
		const label = document.createElement("label");
		const labelText = targetCharacteristicLabel(id);
		label.textContent = labelText;
		const input = document.createElement("input");
		input.type = "number";
		input.step = "1";
		input.autocomplete = "off";
		input.name = `targetValue_${id}`;
		input.dataset.targetCharacteristic = id;
		input.dataset.targetCharacteristicLabel = labelText;
		input.placeholder = "—";
		if (Number.isFinite(Number(current?.[id]))) {
			input.value = String(current[id]);
		}
		row.append(label, input);
		container.append(row);
	}
}

function readManualTargetValues(root) {
	const values = {};
	for (const input of root?.querySelectorAll?.("input[data-target-characteristic]") ?? []) {
		const id = String(input.dataset.targetCharacteristic ?? "").trim();
		const raw = String(input.value ?? "").trim();
		if (!id || !raw || !Number.isFinite(Number(raw))) continue;
		values[id] = Number(raw);
	}
	return values;
}

function registerTargetResultAdjudication() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!state?.formulaRaw || !Array.isArray(state.variables)) return;

		const targetVariables = state.variables.filter((entry) =>
			String(entry?.key ?? "").startsWith("target."),
		);
		if (targetVariables.length === 0) return;

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		if (!card) return;

		const canAdjudicate = TestResultChat._canAdjudicate(state);

		for (const variable of targetVariables) {
			const key = String(variable.key);
			const row = card.querySelector(
				`[data-wfrp-test-variable-key="${cssEscape(key)}"]`,
			);
			const value = row?.querySelector?.("strong");
			if (!(row instanceof HTMLElement) || !(value instanceof HTMLElement)) continue;

			const input = document.createElement("input");
			input.type = "number";
			input.step = "1";
			input.autocomplete = "off";
			input.value = String(variable.value);
			input.dataset.wfrpTargetVariableInput = "";
			input.dataset.variableKey = key;
			input.classList.add("wfrp1e-test-card__modifier-input");
			input.readOnly = !canAdjudicate;
			if (!canAdjudicate) input.tabIndex = -1;
			input.title = canAdjudicate
				? localize(
					"Edit the target characteristic for this resolved test; the original d100 roll is preserved.",
					"Zmień cechę celu dla tego rozstrzygniętego testu; pierwotny rzut K100 zostanie zachowany.",
				)
				: localize(
					"Only the GM or an OWNER of the rolling Actor can adjudicate this target value.",
					"Tylko MG albo Właściciel rzucającego Aktora może zmienić tę wartość celu.",
				);
			value.replaceWith(input);

			if (!canAdjudicate) continue;
			input.addEventListener("keydown", (event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				input.blur();
			});
			input.addEventListener("change", () => {
				void updateTargetVariable(message, input);
			});
		}
	});
}

async function updateTargetVariable(message, input) {
	try {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!state || !TestResultChat._canAdjudicate(state)) {
			throw new Error(localize(
				"Only the GM or an OWNER of the rolling Actor can change the target value.",
				"Tylko MG albo Właściciel rzucającego Aktora może zmienić wartość celu.",
			));
		}

		const raw = String(input?.value ?? "").trim();
		const value = Number(raw);
		if (!raw || !Number.isFinite(value)) {
			throw new Error(localize(
				"Enter a finite target characteristic value.",
				"Wprowadź prawidłową liczbową wartość cechy celu.",
			));
		}

		const key = String(input.dataset.variableKey ?? "").trim();
		const updated = TestResultChat._copyState(state);
		const variable = updated.variables.find((entry) => entry.key === key);
		if (!variable || !key.startsWith("target.")) {
			throw new Error("Select a valid target formula input.");
		}
		variable.value = value;
		updated.baseTarget = resolveSnapshotFormula(updated.formulaRaw, updated.variables);
		updated.updatedBy = String(game.user?.id ?? "");
		updated.updatedAt = Date.now();

		const content = await TestResultChat._render(updated);
		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});
	} catch (error) {
		console.error("WFRP1ED | Unable to adjudicate Standard Test target value.", error);
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		const current = state?.variables?.find(
			(entry) => entry.key === input?.dataset?.variableKey,
		);
		if (input && current) input.value = String(current.value);
		ui.notifications.error(error?.message ?? "Unable to change the target value.");
	}
}

function resolveSnapshotFormula(formula, variables) {
	let expression = String(formula ?? "").trim();
	if (!expression) throw new Error("Resolved Test snapshot has no raw formula.");

	const ordered = [...variables]
		.map((entry) => ({ key: String(entry?.key ?? ""), value: Number(entry?.value) }))
		.filter((entry) => entry.key && Number.isFinite(entry.value))
		.sort((first, second) => second.key.length - first.key.length);

	for (const entry of ordered) {
		expression = replaceVariable(expression, entry.key, entry.value);
	}
	return FormulaResolver.evaluate(expression);
}

function replaceVariable(formula, key, value) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`(^|[^A-Za-z0-9_.])${escaped}(?=$|[^A-Za-z0-9_.])`,
		"g",
	);
	return String(formula).replace(pattern, (_match, prefix) => `${prefix}${value}`);
}

function targetButton(action, label, iconClass) {
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.standardTargetAction = action;
	const icon = document.createElement("i");
	icon.className = iconClass;
	icon.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent = label;
	button.append(icon, text);
	return button;
}

function appendOption(select, value, label, targetName = "") {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = label;
	if (targetName) option.dataset.targetName = targetName;
	select.append(option);
}

function ensureTargetOption(select, target) {
	const uuid = String(target?.uuid ?? "");
	if (!uuid) return;
	if ([...select.options].some((option) => option.value === uuid)) return;
	appendOption(select, uuid, String(target.name ?? uuid), String(target.name ?? ""));
}

function targetCharacteristicLabel(id) {
	const labels = {
		m: ["Movement", "Szybkość"],
		ws: ["Weapon Skill", "Walka Wręcz"],
		bs: ["Ballistic Skill", "Umiejętności Strzeleckie"],
		s: ["Strength", "Siła"],
		t: ["Toughness", "Wytrzymałość"],
		w: ["Wounds", "Żywotność"],
		i: ["Initiative", "Inicjatywa"],
		a: ["Attacks", "Atak"],
		dex: ["Dexterity", "Zręczność"],
		ld: ["Leadership", "Cechy Przywódcze"],
		int: ["Intelligence", "Inteligencja"],
		cl: ["Cool", "Opanowanie"],
		wp: ["Will Power", "Siła Woli"],
		fel: ["Fellowship", "Ogłada"],
	};
	const pair = labels[String(id ?? "").toLowerCase()] ?? [String(id), String(id)];
	return localize(`Target ${pair[0]}`, `${pair[1]} celu`);
}

function cssEscape(value) {
	return globalThis.CSS?.escape
		? CSS.escape(String(value))
		: String(value).replace(/(["\\])/g, "\\$1");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
