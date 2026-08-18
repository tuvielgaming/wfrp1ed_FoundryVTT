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
 * Career Items contain nested arrays and objects. ApplicationV2's expanded
 * submit-on-change payload can replace untouched siblings when only one nested
 * control changed, so Career authoring persists exact field paths instead.
 * Skill/Trapping/Magic/Exit collections remain owned by their dedicated sheet
 * actions and drag/drop handlers.
 *
 * Advance Scheme is stored internally as purchase counts because Actor Career
 * progression uses those counts. The Career Item sheet, however, is a rulebook
 * authoring surface: it displays and accepts the printed advancement value.
 * Thus WS=10 is persisted as one purchase, WS=20 as two purchases, while S=2
 * remains two purchases because Strength advances in +1 steps.
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

		for (const control of element.querySelectorAll("input[name], select[name], textarea[name]")) {
			if (!isPersistedControl(control)) continue;
			control.addEventListener("change", (event) => {
				const current = event.currentTarget;
				if (!isPersistedControl(current)) return;
				const update = controlUpdate(application.document, current);
				if (!update) return;
				void queueItemUpdate(application.document, update)
					.catch(reportAuthoringError);
			});
		}

		/* Enter/programmatic submit is a safe flat-path snapshot rather than the
		 * default expanded nested object submission. */
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
 * Convert internal purchase counts to the exact values printed in Core Career
 * Advance Schemes. The template itself intentionally stays simple; this layer
 * owns the authoring/storage translation.
 */
function prepareAdvanceSchemeInputs(item, form) {
	for (const input of form.querySelectorAll(`input[name^="${ADVANCE_SCHEME_PREFIX}"]`)) {
		const id = advanceCharacteristicId(input);
		if (!id) continue;
		const unit = advanceUnit(id);
		const steps = nonNegativeInteger(item.system?.advanceScheme?.[id]);
		input.value = String(steps * unit);
		input.min = "0";
		input.step = String(unit);
		input.dataset.wfrpCareerAdvanceValue = "";
		input.title = unit === 10
			? localize(
				"Enter the value shown in the Career table (for example 10 for +10).",
				"Wpisz wartość z tabeli Profesji (np. 10 dla +10).",
			)
			: localize(
				"Enter the value shown in the Career table.",
				"Wpisz wartość z tabeli Profesji.",
			);
	}
}

async function persistFormSnapshot(item, form) {
	const update = {};
	for (const control of form.querySelectorAll("input[name], select[name], textarea[name]")) {
		if (!isPersistedControl(control)) continue;
		const partial = controlUpdate(item, control, { notify: false });
		if (!partial) continue;
		Object.assign(update, partial);
	}
	if (Object.keys(update).length) await queueItemUpdate(item, update);
}

function controlUpdate(item, control, { notify = true } = {}) {
	const name = String(control?.name ?? "").trim();
	if (!name) return null;

	if (name.startsWith(ADVANCE_SCHEME_PREFIX)) {
		const id = advanceCharacteristicId(control);
		if (!id) return null;
		const unit = advanceUnit(id);
		const numeric = Number(String(control.value ?? "").trim().replace(",", "."));
		const valid = Number.isInteger(numeric) && numeric >= 0 && numeric % unit === 0;
		if (!valid) {
			const currentSteps = nonNegativeInteger(item.system?.advanceScheme?.[id]);
			control.value = String(currentSteps * unit);
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
		return { [name]: numeric / unit };
	}

	return { [name]: formControlValue(control) };
}

function advanceCharacteristicId(control) {
	const name = String(control?.name ?? "");
	if (!name.startsWith(ADVANCE_SCHEME_PREFIX)) return "";
	return name.slice(ADVANCE_SCHEME_PREFIX.length).trim();
}

function advanceUnit(id) {
	return ONE_POINT_ADVANCES.has(String(id ?? "")) ? 1 : 10;
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
