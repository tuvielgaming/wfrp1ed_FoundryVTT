import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import { FormulaResolver } from "./FormulaResolver.mjs";
import { PendingStandardTest } from "./PendingStandardTest.mjs";
import { StandardTestDialog } from "./StandardTestDialog.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const TARGET_SELECTION_PENDING = "__pending__";
const STANDARD_DIALOG_CLASS = "wfrp1ed-standard-test-dialog";

/*
 * Target-dependent Standard Tests deliberately follow the already-verified
 * combat-attack targeting interaction:
 *
 * - a single Foundry Target Token is adopted automatically before the dialog
 *   opens and while it remains open;
 * - visible scene-token Actors are available in the target dropdown;
 * - the first dropdown option means unresolved/deferred target data and is also
 *   the sole way to clear an initial-dialog target;
 * - a raw target characteristic is available only while no Actor is selected;
 * - the initial dialog may continue with neither Actor nor raw value, producing
 *   a PendingStandardTest which can be resolved later in chat;
 * - once the d100 is rolled, the selected Actor target is immutable, matching
 *   resolved attack rolls. Only a test which was rolled without an Actor target
 *   keeps its raw target characteristic adjudicable afterwards.
 *
 * Mechanics remain owned by FormulaResolver/TestResolver. This module only
 * supplies or adjudicates the target.* inputs consumed by those formulas.
 */
installTargetDialog();
installLiveCanvasTargetSync();
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
			form?.elements?.standardTargetSelection?.value ?? TARGET_SELECTION_PENDING,
		).trim();
		const targetUuid = String(
			form?.elements?.standardTargetUuid?.value ?? "",
		).trim();
		const target = selection !== TARGET_SELECTION_PENDING
			? ActorTargetResolver.actorFromUuidSync(targetUuid || selection)
			: null;

		/* Explicit picker state replaces StandardTestDialog's old implicit
		 * game.user.targets lookup. */
		delete response.options.target;
		delete response.options.targetActor;
		delete response.options.targetValues;

		if (target) {
			response.options.target = target;
			return response;
		}

		const targetValues = readManualTargetValues(form);
		if (Object.keys(targetValues).length > 0) {
			response.options.targetValues = targetValues;
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
		TARGET_SELECTION_PENDING,
		localize("Choose scene token…", "Wybierz token ze sceny…"),
	);
	for (const entry of ActorTargetResolver.sceneTokenTargets()) {
		appendOption(selection, entry.actorUuid, entry.name, entry.name);
	}
	if (initialTarget) {
		ensureTargetOption(selection, initialTarget);
		selection.value = String(initialTarget.uuid ?? "");
	} else {
		selection.value = TARGET_SELECTION_PENDING;
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

	wrapper.append(selection, targetUuid, status, actions, values);
	return wrapper;
}

function activateTargetPicker(dialog, entries) {
	const root = dialog?.element;
	const selection = root?.querySelector?.('[name="standardTargetSelection"]');
	const uuid = root?.querySelector?.('[name="standardTargetUuid"]');
	const status = root?.querySelector?.("[data-standard-target-picker-status]");
	const actions = root?.querySelector?.(".standard-test-target-actions");
	const values = root?.querySelector?.("[data-standard-target-values]");
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

	const refresh = () => {
		const entry = currentEntry();
		populateManualInputs(values, entry, readManualTargetValues(form));
		if (!entry?.tags?.includes("requires-target")) return;

		if (selection.value === TARGET_SELECTION_PENDING) {
			uuid.value = "";
			values.hidden = false;
			status.textContent = localize(
				"No target selected — enter the characteristic below, or leave it blank and resolve the target in chat after Roll.",
				"Nie wybrano celu — wpisz cechę poniżej albo pozostaw ją pustą i rozstrzygnij cel w czacie po kliknięciu Rzuć.",
			);
			return;
		}

		const target = ActorTargetResolver.actorFromUuidSync(selection.value);
		if (!target) {
			selection.value = TARGET_SELECTION_PENDING;
			uuid.value = "";
			values.hidden = false;
			status.textContent = localize("No target selected", "Nie wybrano celu");
			return;
		}

		uuid.value = String(target.uuid ?? "");
		values.hidden = true;
		status.textContent = String(
			selection.selectedOptions?.[0]?.dataset?.targetName ??
			target.name ??
			localize("Selected target", "Wybrany cel"),
		);
	};

	selection.addEventListener("change", refresh);
	testSelect.addEventListener("change", refresh);

	for (const button of actions.querySelectorAll("[data-standard-target-action]")) {
		button.addEventListener("click", async (event) => {
			event.preventDefault();
			if (button.dataset.standardTargetAction !== "choose-actor" || !game.user?.isGM) return;
			const target = await ActorTargetResolver.chooseActor();
			if (!target) return;
			setTarget(target);
			refresh();
		});
	}

	/* Missing target data is intentionally NOT a validation error here. The
	 * launcher is allowed to create a PendingStandardTest for later adjudication. */
	refresh();
}

function installLiveCanvasTargetSync() {
	const DialogV2 = foundry.applications?.api?.DialogV2;
	if (!DialogV2 || DialogV2.__wfrpStandardCanvasTargetingInstalled === true) return;
	const originalWait = DialogV2.wait;

	DialogV2.wait = function wfrpStandardCanvasTargetingWait(config = {}, ...args) {
		if (!Array.isArray(config?.classes) || !config.classes.includes(STANDARD_DIALOG_CLASS)) {
			return originalWait.call(this, config, ...args);
		}

		const originalRender = config.render;
		const originalClose = config.close;
		let cleanupTargetHook = null;
		const cleanup = () => {
			if (typeof cleanupTargetHook === "function") cleanupTargetHook();
			cleanupTargetHook = null;
		};

		const promise = originalWait.call(this, {
			...config,
			modal: false,
			render: (...renderArgs) => {
				const result = typeof originalRender === "function"
					? originalRender(...renderArgs)
					: undefined;
				cleanup();
				cleanupTargetHook = activateCanvasTargetSync(renderArgs[1]?.element);
				return result;
			},
			close: (...closeArgs) => {
				cleanup();
				return typeof originalClose === "function"
					? originalClose(...closeArgs)
					: undefined;
			},
		}, ...args);
		return Promise.resolve(promise).finally(cleanup);
	};

	Object.defineProperty(DialogV2, "__wfrpStandardCanvasTargetingInstalled", {
		value: true,
		configurable: false,
		enumerable: false,
	});
}

function activateCanvasTargetSync(root) {
	if (!root?.classList?.contains?.(STANDARD_DIALOG_CLASS)) return null;
	const selection = root.querySelector('[name="standardTargetSelection"]');
	const targetUuid = root.querySelector('[name="standardTargetUuid"]');
	if (!(selection instanceof HTMLSelectElement) || !(targetUuid instanceof HTMLInputElement)) {
		return null;
	}

	selection.title = localize(
		"Choose a visible token on the current scene. You can also change the target directly on the canvas.",
		"Wybierz widoczny token na bieżącej scenie. Możesz też normalnie zmieniać cel bezpośrednio na mapie.",
	);

	const syncFromFoundryTarget = () => {
		const target = ActorTargetResolver.singleTargetActor();
		if (!target) {
			selection.value = TARGET_SELECTION_PENDING;
			targetUuid.value = "";
			selection.dispatchEvent(new Event("change", { bubbles: true }));
			return;
		}
		const uuid = String(target.uuid ?? "");
		if (!uuid) return;
		ensureTargetOption(selection, target);
		selection.value = uuid;
		targetUuid.value = uuid;
		selection.dispatchEvent(new Event("change", { bubbles: true }));
	};

	syncFromFoundryTarget();
	releaseInitialDialogFocus(root);

	const onChange = (event) => {
		const control = event.target;
		if (control instanceof HTMLSelectElement) releaseFocusAfterInteraction(control);
	};
	const onClick = (event) => {
		const button = event.target?.closest?.("button");
		if (button instanceof HTMLButtonElement && root.contains(button)) {
			releaseFocusAfterInteraction(button);
		}
	};
	root.addEventListener("change", onChange);
	root.addEventListener("click", onClick);

	const hookId = Hooks.on("targetToken", (user) => {
		if (String(user?.id ?? "") !== String(game.user?.id ?? "")) return;
		if (!root.isConnected) return;
		syncFromFoundryTarget();
	});

	return () => {
		Hooks.off("targetToken", hookId);
		root.removeEventListener("change", onChange);
		root.removeEventListener("click", onClick);
	};
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
		if (Number.isFinite(Number(current?.[id]))) input.value = String(current[id]);
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

		const actorSelected = Boolean(String(state.targetActorUuid ?? "").trim());
		if (actorSelected) return;

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
			value.replaceWith(input);
			if (!canAdjudicate) continue;
			input.addEventListener("keydown", (event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				input.blur();
			});
			input.addEventListener("change", () => void updateTargetVariable(message, input));
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
		if (String(state.targetActorUuid ?? "").trim()) {
			throw new Error(localize(
				"A resolved test with an Actor target uses that Actor's characteristic.",
				"Rozstrzygnięty test z Aktorem celu używa cechy tego Aktora.",
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
	for (const entry of ordered) expression = replaceVariable(expression, entry.key, entry.value);
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
	option.value = String(value);
	option.textContent = String(label);
	if (targetName) option.dataset.targetName = targetName;
	select.append(option);
}

function ensureTargetOption(select, target) {
	const uuid = String(target?.uuid ?? "");
	if (!uuid) return;
	let option = [...select.options].find((entry) => entry.value === uuid);
	const sceneEntry = ActorTargetResolver.sceneTokenTargets().find(
		(entry) => String(entry.actorUuid ?? "") === uuid,
	);
	const displayName = String(sceneEntry?.name || target?.name || uuid);
	if (!option) {
		option = document.createElement("option");
		option.value = uuid;
		select.append(option);
	}
	option.textContent = displayName;
	option.dataset.targetName = displayName;
}

function targetCharacteristicLabel(id) {
	const labels = {
		m: ["Movement", "Szybkość"], ws: ["Weapon Skill", "Walka Wręcz"],
		bs: ["Ballistic Skill", "Umiejętności Strzeleckie"], s: ["Strength", "Siła"],
		t: ["Toughness", "Wytrzymałość"], w: ["Wounds", "Żywotność"],
		i: ["Initiative", "Inicjatywa"], a: ["Attacks", "Atak"],
		dex: ["Dexterity", "Zręczność"], ld: ["Leadership", "Cechy Przywódcze"],
		int: ["Intelligence", "Inteligencja"], cl: ["Cool", "Opanowanie"],
		wp: ["Will Power", "Siła Woli"], fel: ["Fellowship", "Ogłada"],
	};
	const pair = labels[String(id ?? "").toLowerCase()] ?? [String(id), String(id)];
	return localize(`Target ${pair[0]}`, `${pair[1]} celu`);
}

function releaseInitialDialogFocus(root) {
	requestAnimationFrame(() => {
		if (!root?.isConnected) return;
		const active = document.activeElement;
		if (!active || !root.contains(active)) return;
		if (
			active instanceof HTMLButtonElement ||
			active instanceof HTMLSelectElement ||
			(active instanceof HTMLInputElement &&
				(active.type === "checkbox" || active.type === "radio"))
		) active.blur();
	});
}

function releaseFocusAfterInteraction(control) {
	queueMicrotask(() => {
		if (document.activeElement === control) control.blur();
	});
}

function cssEscape(value) {
	return globalThis.CSS?.escape
		? CSS.escape(String(value))
		: String(value).replace(/(["\\])/g, "\\$1");
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
		? polish
		: english;
}
