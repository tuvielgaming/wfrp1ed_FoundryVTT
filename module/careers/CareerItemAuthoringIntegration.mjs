import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const COLLECTION_PREFIXES = Object.freeze([
	"system.skills",
	"system.trappings",
	"system.magicPoints",
	"system.exits",
]);

const ONE_POINT_ADVANCES = new Set(["m", "s", "t", "w", "a"]);
const ADVANCE_SCHEME_PREFIX = "system.advanceScheme.";
const updateQueues = new WeakMap();

installSafeCareerFormPersistence();
installCareerEntryPresentation();

/**
 * Career Items contain nested arrays and objects. ApplicationV2's generic
 * submit-on-change payload can replace untouched siblings when a single nested
 * control changes. Career authoring therefore owns change persistence itself.
 *
 * The capture-phase change handler persists only the changed field and prevents
 * the generic form submit-on-change handler from receiving that event. Advance
 * Scheme changes are even stricter: the current complete scheme is cloned at
 * queue execution time, one characteristic is replaced, and the whole scheme is
 * written back. This prevents rapid edits or model cleaning from erasing sibling
 * characteristics.
 *
 * Advance Scheme is stored internally as purchase counts because Actor Career
 * progression uses those counts. The Career Item sheet is a rulebook authoring
 * surface and displays/accepts the printed advancement value: WS=10 is one
 * purchase, WS=20 is two purchases, while S=2 remains two +1 purchases.
 */
function installSafeCareerFormPersistence() {
	if (CareerItemSheet.__wfrpSafeAuthoringInstalled === true) return;

	CareerItemSheet.DEFAULT_OPTIONS.form ??= {};
	CareerItemSheet.DEFAULT_OPTIONS.form.submitOnChange = false;
	CareerItemSheet.DEFAULT_OPTIONS.form.closeOnSubmit = false;

	Hooks.on("renderApplicationV2", (application, element) => {
		if (!(application instanceof CareerItemSheet)) return;
		if (!(element instanceof HTMLElement)) return;
		if (application.isEditable !== true) return;

		prepareAdvanceSchemeInputs(application.document, element);

		/* Own Career field changes before ApplicationV2 can expand and submit the
		 * whole nested form. This is intentionally delegated from the form because
		 * ApplicationV2 may replace individual controls during rerenders. */
		element.addEventListener("change", (event) => {
			const control = event.target;
			if (!isPersistedControl(control)) return;

			event.stopImmediatePropagation();

			if (isAdvanceControl(control)) {
				const parsed = parseAdvanceControl(application.document, control, {
					notify: true,
				});
				if (!parsed) return;
				control.dataset.wfrpCareerAdvanceRaw = String(parsed.value);
				void queueAdvanceSchemeUpdate(
					application.document,
					parsed.id,
					parsed.steps,
				).catch(reportAuthoringError);
				return;
			}

			void queueItemUpdate(application.document, {
				[String(control.name)]: formControlValue(control),
			}).catch(reportAuthoringError);
		}, true);

		/* Enter/programmatic submit is also a safe snapshot rather than the default
		 * expanded nested object submission. */
		element.addEventListener("submit", (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			void persistFormSnapshot(application.document, element)
				.catch(reportAuthoringError);
		}, true);
	});

	Object.defineProperty(
		CareerItemSheet,
		"__wfrpSafeAuthoringInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/** Make chance/mode metadata read as labels belonging to one self-contained entry. */
function installCareerEntryPresentation() {
	if (CareerItemSheet.prototype.__wfrpEntryPresentationInstalled === true) return;

	const original = CareerItemSheet.prototype._prepareContext;
	CareerItemSheet.prototype._prepareContext = async function careerAuthoringContext(options) {
		const context = await original.call(this, options);
		for (const collectionName of ["skills", "trappings"]) {
			for (const entry of context?.careerUi?.[collectionName] ?? []) {
				const chance = clampPercentage(entry?.chance);
				entry.chanceLabel = chance < 100
					? localize(`Chance: ${chance}%`, `Szansa: ${chance}%`)
					: "";
				entry.modeLabel = descriptiveModeLabel(entry);
			}
		}
		return context;
	};

	Object.defineProperty(
		CareerItemSheet.prototype,
		"__wfrpEntryPresentationInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/**
 * Present Career advances exactly like the printed table while preserving an
 * ordinary numeric editing experience on focus.
 *
 * Unfocused:  —  | +10 | +2
 * Focused:     0  |  10 |  2
 */
function prepareAdvanceSchemeInputs(item, form) {
	for (const input of form.querySelectorAll(`input[name^="${ADVANCE_SCHEME_PREFIX}"]`)) {
		const id = advanceCharacteristicId(input);
		if (!id) continue;

		const unit = advanceUnit(id);
		const steps = nonNegativeInteger(item.system?.advanceScheme?.[id]);
		const value = steps * unit;

		/* type=number cannot display '+' or an em dash. Keep input semantics and
		 * numeric mobile keyboard via inputMode while using text presentation. */
		input.type = "text";
		input.inputMode = "numeric";
		input.autocomplete = "off";
		input.dataset.wfrpCareerAdvanceValue = "";
		input.dataset.wfrpCareerAdvanceRaw = String(value);
		input.value = formatAdvanceValue(value);
		input.title = unit === 10
			? localize(
				"Enter the value shown in the Career table (0, 10, 20, 30, ...).",
				"Wpisz wartość z tabeli Profesji (0, 10, 20, 30, ...).",
			)
			: localize(
				"Enter the value shown in the Career table.",
				"Wpisz wartość z tabeli Profesji.",
			);

		input.addEventListener("focus", () => {
			input.value = String(nonNegativeInteger(input.dataset.wfrpCareerAdvanceRaw));
			input.dataset.wfrpCareerAdvanceEditing = "";
			setTimeout(() => {
				if (document.activeElement !== input) return;
				try { input.select(); } catch (_error) {}
			}, 0);
		});

		input.addEventListener("blur", () => {
			const parsed = parseAdvanceControl(item, input, { notify: false });
			const valueAfterEdit = parsed
				? parsed.value
				: nonNegativeInteger(input.dataset.wfrpCareerAdvanceRaw);
			input.dataset.wfrpCareerAdvanceRaw = String(valueAfterEdit);
			delete input.dataset.wfrpCareerAdvanceEditing;
			input.value = formatAdvanceValue(valueAfterEdit);
		});
	}
}

async function persistFormSnapshot(item, form) {
	const update = {};
	const scheme = cloneAdvanceScheme(item);
	let schemeTouched = false;

	for (const control of form.querySelectorAll("input[name], select[name], textarea[name]")) {
		if (!isPersistedControl(control)) continue;

		if (isAdvanceControl(control)) {
			const parsed = parseAdvanceControl(item, control, { notify: false });
			if (!parsed) continue;
			scheme[parsed.id] = parsed.steps;
			schemeTouched = true;
			continue;
		}

		update[String(control.name)] = formControlValue(control);
	}

	if (schemeTouched) update["system.advanceScheme"] = scheme;
	if (Object.keys(update).length) await queueItemUpdate(item, update);
}

function parseAdvanceControl(item, control, { notify = true } = {}) {
	const id = advanceCharacteristicId(control);
	if (!id) return null;

	const unit = advanceUnit(id);
	const text = String(control.value ?? "").trim();
	const normalized = ["", "-", "—"].includes(text)
		? "0"
		: text.replace(/^\+/, "").replace(",", ".");
	const numeric = Number(normalized);
	const valid = Number.isInteger(numeric) && numeric >= 0 && numeric % unit === 0;

	if (!valid) {
		const currentValue = nonNegativeInteger(item.system?.advanceScheme?.[id]) * unit;
		control.dataset.wfrpCareerAdvanceRaw = String(currentValue);
		control.value = document.activeElement === control
			? String(currentValue)
			: formatAdvanceValue(currentValue);
		if (notify) {
			ui.notifications.warn(unit === 10
				? localize(
					"This characteristic advances in +10 steps. Enter 0, 10, 20, 30, ...",
					"Ta cecha rozwija się skokami +10. Wpisz 0, 10, 20, 30, ...",
				)
				: localize(
					"Enter a non-negative whole advancement value.",
					"Wpisz nieujemną całkowitą wartość rozwinięcia.",
				));
		}
		return null;
	}

	return {
		id,
		unit,
		value: numeric,
		steps: numeric / unit,
	};
}

function isAdvanceControl(control) {
	return String(control?.name ?? "").startsWith(ADVANCE_SCHEME_PREFIX);
}

function advanceCharacteristicId(control) {
	const name = String(control?.name ?? "");
	if (!name.startsWith(ADVANCE_SCHEME_PREFIX)) return "";
	return name.slice(ADVANCE_SCHEME_PREFIX.length).trim();
}

function advanceUnit(id) {
	return ONE_POINT_ADVANCES.has(String(id ?? "")) ? 1 : 10;
}

function formatAdvanceValue(value) {
	const numeric = nonNegativeInteger(value);
	return numeric > 0 ? `+${numeric}` : "—";
}

function cloneAdvanceScheme(item) {
	const source = item.system?.advanceScheme?.toObject?.() ??
		item.system?.advanceScheme ?? {};
	return foundry.utils.deepClone(source);
}

function queueAdvanceSchemeUpdate(item, id, steps) {
	const previous = updateQueues.get(item) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(() => {
			const scheme = cloneAdvanceScheme(item);
			scheme[id] = nonNegativeInteger(steps);
			return item.update({ "system.advanceScheme": scheme });
		});
	updateQueues.set(item, next);
	return next.finally(() => {
		if (updateQueues.get(item) === next) updateQueues.delete(item);
	});
}

function descriptiveModeLabel(entry) {
	const choiceCount = Array.isArray(entry?.choices) ? entry.choices.length : 0;
	if (choiceCount <= 1) return "";
	switch (String(entry?.mode ?? "")) {
		case CAREER_ENTRY_MODE.PLAYER_CHOICE:
			return localize("Player choice", "Wybór gracza");
		case CAREER_ENTRY_MODE.RANDOM_CHOICE:
			return localize("Random choice", "Losowanie");
		default:
			return localize("All options", "Wszystkie opcje");
	}
}

function isPersistedControl(control) {
	if (!control || typeof control !== "object") return false;
	if (control.disabled === true) return false;
	const name = String(control.name ?? "").trim();
	if (!name) return false;
	return !COLLECTION_PREFIXES.some(
		(prefix) => name === prefix || name.startsWith(`${prefix}.`),
	);
}

function formControlValue(control) {
	const type = String(control.type ?? "").toLowerCase();
	if (type === "checkbox") return control.checked === true;
	if (type === "number") {
		const number = Number(String(control.value ?? "").trim().replace(",", "."));
		return Number.isFinite(number) ? number : 0;
	}
	return String(control.value ?? "");
}

function queueItemUpdate(item, update) {
	const previous = updateQueues.get(item) ?? Promise.resolve();
	const next = previous
		.catch(() => {})
		.then(() => item.update(update));
	updateQueues.set(item, next);
	return next.finally(() => {
		if (updateQueues.get(item) === next) updateQueues.delete(item);
	});
}

function clampPercentage(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 100;
	return Math.max(0, Math.min(100, Math.trunc(numeric)));
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function reportAuthoringError(error) {
	console.error("WFRP1ED | Unable to persist Career authoring change.", error);
	ui.notifications.error(localize(
		"Unable to save the Career change.",
		"Nie udało się zapisać zmiany Profesji.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
