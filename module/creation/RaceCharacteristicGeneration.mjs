import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

const CHARACTERISTICS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);

installRaceCharacteristicGeneration();

/**
 * Character Creation Mode integration for the WFRP 1e racial starting profile.
 *
 * The Character may still type any starting Characteristic manually. When a
 * Race Item is embedded, this integration adds a small dice action to every
 * initial Characteristic cell and an all-profile dice action in the row label.
 * Rolling writes only `system.characteristics.<id>.initial`; the Race formula
 * remains a generation instruction, never a permanent modifier.
 */
function installRaceCharacteristicGeneration() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		if (!(root instanceof HTMLElement)) return;
		const sheet = root.classList?.contains("wfrp1ed-classic-sheet")
			? root
			: root.querySelector?.(".wfrp1ed-classic-sheet");
		if (!(sheet instanceof HTMLElement)) return;

		installRollControls(actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const root = asElement(actor.sheet?.element);
			const sheet = root?.querySelector?.(".wfrp1ed-classic-sheet") ??
				(root?.classList?.contains("wfrp1ed-classic-sheet") ? root : null);
			if (sheet instanceof HTMLElement) installRollControls(actor, sheet);
		});
	}
}

function installRollControls(actor, sheet) {
	const race = embeddedRace(actor);
	const profile = race?.system?.profile ?? null;
	const initialRow = sheet.querySelector('[data-characteristic-row="initial"]');
	if (!(initialRow instanceof HTMLElement)) return;

	for (const old of initialRow.querySelectorAll(".wfrp1ed-race-characteristic-roll")) old.remove();
	initialRow.querySelector(".wfrp1ed-race-profile-roll-all")?.remove?.();

	if (!race || !profile) return;

	const rowLabel = initialRow.querySelector(".characteristics-row-label");
	if (rowLabel instanceof HTMLElement) {
		const rollAll = document.createElement("button");
		rollAll.type = "button";
		rollAll.className = "wfrp1ed-race-profile-roll-all";
		rollAll.innerHTML = '<i class="fa-solid fa-dice"></i>';
		rollAll.title = localize(
			`Roll all starting Characteristics from ${race.name}`,
			`Rzuć wszystkie Cechy początkowe według rasy ${race.name}`,
		);
		rollAll.setAttribute("aria-label", rollAll.title);
		rollAll.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void rollAllCharacteristics(actor, race).catch(reportError);
		});
		rowLabel.append(rollAll);
	}

	for (const id of CHARACTERISTICS) {
		const cell = initialRow.querySelector(`.characteristic-cell--initial[data-characteristic="${id}"]`);
		if (!(cell instanceof HTMLElement)) continue;

		const formula = String(profile?.[id] ?? "").trim();
		if (!formula) continue;

		cell.classList.add("wfrp1ed-race-generation-cell");
		const button = document.createElement("button");
		button.type = "button";
		button.className = "wfrp1ed-race-characteristic-roll";
		button.dataset.characteristic = id;
		button.innerHTML = '<i class="fa-solid fa-dice-d6"></i>';
		button.title = localize(
			`Roll ${formula} from Race: ${race.name}`,
			`Rzuć ${formula} według rasy: ${race.name}`,
		);
		button.setAttribute("aria-label", button.title);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void rollCharacteristic(actor, race, id).catch(reportError);
		});
		cell.append(button);
	}
}

async function rollCharacteristic(actor, race, id) {
	const formula = raceFormula(race, id);
	if (!formula) return;
	const value = await evaluateFormula(formula, id);
	await actor.update({ [`system.characteristics.${id}.initial`]: value });
}

async function rollAllCharacteristics(actor, race) {
	const updates = {};
	for (const id of CHARACTERISTICS) {
		const formula = raceFormula(race, id);
		if (!formula) continue;
		updates[`system.characteristics.${id}.initial`] = await evaluateFormula(formula, id);
	}
	if (!Object.keys(updates).length) {
		ui.notifications.warn(localize(
			"The assigned Race has no starting Characteristic formulas.",
			"Przypisana Rasa nie ma formuł początkowych Cech.",
		));
		return;
	}
	await actor.update(updates);
}

async function evaluateFormula(formula, id) {
	try {
		const roll = await (new Roll(formula)).evaluate();
		const total = Number(roll.total);
		if (!Number.isFinite(total)) throw new Error(`Non-numeric result for ${formula}`);
		return Math.trunc(total);
	} catch (error) {
		throw new Error(localize(
			`Invalid Race formula for ${id.toUpperCase()}: ${formula}`,
			`Błędna formuła Rasy dla ${id.toUpperCase()}: ${formula}`,
		), { cause: error });
	}
}

function raceFormula(race, id) {
	return String(race?.system?.profile?.[id] ?? "").trim();
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ??
		actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function reportError(error) {
	console.error("WFRP1ED | Race characteristic generation failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
