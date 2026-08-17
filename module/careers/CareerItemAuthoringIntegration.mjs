import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const COLLECTION_PREFIXES = Object.freeze([
	"system.skills",
	"system.trappings",
	"system.magicPoints",
	"system.exits",
]);

const updateQueues = new WeakMap();

installSafeCareerFormPersistence();
installCareerEntryPresentation();

/**
 * Career Items contain nested arrays and objects. ApplicationV2's expanded
 * submit-on-change payload can replace untouched siblings when only one nested
 * control changed, so Career authoring persists exact field paths instead.
 * Skill/Trapping/Magic/Exit collections remain owned by their dedicated sheet
 * actions and drag/drop handlers.
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

		for (const control of element.querySelectorAll("input[name], select[name], textarea[name]")) {
			if (!isPersistedControl(control)) continue;
			control.addEventListener("change", (event) => {
				const current = event.currentTarget;
				if (!isPersistedControl(current)) return;
				void queueItemUpdate(application.document, {
					[String(current.name)]: formControlValue(current),
				}).catch(reportAuthoringError);
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

async function persistFormSnapshot(item, form) {
	const update = {};
	for (const control of form.querySelectorAll("input[name], select[name], textarea[name]")) {
		if (!isPersistedControl(control)) continue;
		update[String(control.name)] = formControlValue(control);
	}
	if (Object.keys(update).length) await queueItemUpdate(item, update);
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
