import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

installRaceSecondaryGeneration();

/**
 * Race-driven generation for secondary character-creation values which already
 * have authoritative formulas on the embedded Race Item.
 *
 * Age remains a player decision between the RAW Young and Mature bands. Fate is
 * a single racial roll. Both actions preserve manual entry and only exist while
 * Character Creation Mode is active.
 */
function installRaceSecondaryGeneration() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		const sheet = classicSheetRoot(root);
		if (!(sheet instanceof HTMLElement)) return;

		installAgeControl(actor, sheet);
		installFateControl(actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const sheet = classicSheetRoot(asElement(actor.sheet?.element));
			if (!(sheet instanceof HTMLElement)) return;
			installAgeControl(actor, sheet);
			installFateControl(actor, sheet);
		});
	}
}

function installAgeControl(actor, sheet) {
	const field = sheet.querySelector(".header-field--age");
	if (!(field instanceof HTMLElement)) return;

	field.querySelector(".wfrp1ed-race-age-roll")?.remove?.();
	const race = embeddedRace(actor);
	const age = race?.system?.age;
	if (!race || !age) return;

	const youngFormula = String(age.youngFormula ?? "").trim();
	const matureFormula = String(age.matureFormula ?? "").trim();
	if (!youngFormula && !matureFormula) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1ed-race-age-roll";
	button.innerHTML = '<i class="fa-solid fa-dice"></i>';
	button.title = localize(
		`Roll starting age from Race: ${race.name}`,
		`Rzuć wiek początkowy według rasy: ${race.name}`,
	);
	button.setAttribute("aria-label", button.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void rollStartingAge(actor, race).catch(reportError);
	});
	field.append(button);
}

function installFateControl(actor, sheet) {
	const field = sheet.querySelector(".wfrp1ed-classic-fate");
	if (!(field instanceof HTMLElement)) return;

	field.querySelector(".wfrp1ed-race-fate-roll")?.remove?.();
	const race = embeddedRace(actor);
	const formula = String(race?.system?.fate?.formula ?? "").trim();
	if (!race || !formula) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1ed-race-fate-roll";
	button.innerHTML = '<i class="fa-solid fa-dice"></i>';
	button.title = localize(
		`Roll starting Fate Points from Race: ${race.name}`,
		`Rzuć początkowe Punkty Przeznaczenia według rasy: ${race.name}`,
	);
	button.setAttribute("aria-label", button.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void rollStartingFate(actor, race).catch(reportError);
	});
	field.append(button);
}

async function rollStartingAge(actor, race) {
	const age = race?.system?.age;
	if (!age) return;

	const band = await chooseAgeBand(race);
	if (!band) return;

	const formula = String(band === "young" ? age.youngFormula : age.matureFormula).trim();
	if (!formula) {
		ui.notifications.warn(localize(
			`Race ${race.name} has no ${band} age formula.`,
			`Rasa ${race.name} nie ma formuły wieku dla wariantu ${band === "young" ? "Młody" : "Dojrzały"}.`,
		));
		return;
	}

	const minimum = finiteWholeNumber(age.minimum, 0);
	const rerollBelowMinimum = age.rerollBelowMinimum === true;
	const rolls = [];
	let total = 0;

	do {
		const resolved = await evaluateGenerationFormula(formula, localize("Age", "Wiek"));
		rolls.push(resolved);
		total += resolved.value;
		await animateGenerationRoll(resolved.roll);
	} while (rerollBelowMinimum && total < minimum);

	await actor.update({ "system.details.age": String(total) });
	await createAgeChatCard(actor, race, band, formula, rolls, total, minimum, rerollBelowMinimum);
}

async function rollStartingFate(actor, race) {
	const fate = race?.system?.fate;
	const formula = String(fate?.formula ?? "").trim();
	if (!formula) return;

	const resolved = await evaluateGenerationFormula(formula, localize("Fate", "Przeznaczenie"));
	await animateGenerationRoll(resolved.roll);

	const minimum = finiteWholeNumber(fate?.minimum, 0);
	const finalValue = Math.max(minimum, resolved.value);
	await actor.update({
		"system.status.fate.value": finalValue,
		"system.status.fate.max": finalValue,
	});
	await createFateChatCard(actor, race, formula, resolved, minimum, finalValue);
}

async function chooseAgeBand(race) {
	const DialogV2 = foundry.applications?.api?.DialogV2;
	if (!DialogV2?.wait) {
		throw new Error(localize(
			"Foundry DialogV2 is unavailable; age band cannot be selected.",
			"DialogV2 Foundry jest niedostępny; nie można wybrać wariantu wieku.",
		));
	}

	return DialogV2.wait({
		window: {
			title: localize("Choose Starting Age", "Wybierz wiek początkowy"),
		},
		content: `<p>${escapeHtml(localize(
			`Choose whether ${race.name} is created as a Young or Mature character.`,
			`Wybierz, czy ${race.name} jest tworzony jako postać Młoda czy Dojrzała.`,
		))}</p>`,
		buttons: [
			{
				action: "young",
				label: localize("Young", "Młody"),
				icon: "fa-solid fa-seedling",
				callback: () => "young",
			},
			{
				action: "mature",
				label: localize("Mature", "Dojrzały"),
				icon: "fa-solid fa-user",
				default: true,
				callback: () => "mature",
			},
		],
		rejectClose: false,
		modal: true,
	});
}

async function evaluateGenerationFormula(formula, label) {
	try {
		const roll = await new Roll(formula).evaluate({ allowInteractive: false });
		const total = Number(roll.total);
		if (!Number.isFinite(total)) throw new Error(`Non-numeric result for ${formula}`);
		return { roll, value: Math.trunc(total) };
	} catch (error) {
		throw new Error(localize(
			`Invalid Race formula for ${label}: ${formula}`,
			`Błędna formuła Rasy dla ${label}: ${formula}`,
		), { cause: error });
	}
}

async function animateGenerationRoll(roll) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;
	if (!Array.isArray(roll?.dice) || roll.dice.length === 0) return;

	try {
		const visualRoll = await visualRollForUnsupportedSmallDice(roll);
		await dice3d.showForRoll(visualRoll ?? roll, game.user, true, [], false);
	} catch (error) {
		/* Physical dice are presentation only and must never block generation. */
		console.error("WFRP1ED | Unable to display Race generation dice animation.", error);
	}
}

async function visualRollForUnsupportedSmallDice(roll) {
	const dice = Array.isArray(roll?.dice) ? roll.dice : [];
	if (!dice.length) return null;
	if (!dice.every((term) => [2, 3].includes(Number(term?.faces)))) return null;

	const originalResults = dice.flatMap((term) =>
		(term?.results ?? [])
			.filter((result) => result?.active !== false)
			.map((result) => ({ faces: Number(term.faces), value: Number(result.result) })),
	);
	if (!originalResults.length) return null;

	const visualRoll = await new Roll(`${originalResults.length}d6`).evaluate({ allowInteractive: false });
	const visualResults = visualRoll.dice?.[0]?.results ?? [];
	if (visualResults.length < originalResults.length) return null;

	for (let index = 0; index < originalResults.length; index += 1) {
		const original = originalResults[index];
		const visual = visualResults[index];
		if (!visual) continue;
		visual.result = original.faces === 3
			? (original.value * 2) - 1
			: (original.value === 1 ? 1 : 4);
	}
	return visualRoll;
}

async function createAgeChatCard(actor, race, band, formula, rolls, finalValue, minimum, rerollBelowMinimum) {
	const bandLabel = band === "young" ? localize("Young", "Młody") : localize("Mature", "Dojrzały");
	const rollValues = rolls.map((entry) => String(entry.value)).join(" + ");
	const minimumNote = rerollBelowMinimum && rolls.length > 1
		? `<div><strong>${escapeHtml(localize("Minimum-age rule", "Reguła minimalnego wieku"))}:</strong> ${escapeHtml(String(minimum))}</div>`
		: "";
	const content = `<section class="wfrp1ed-race-secondary-chat">
		<header>${escapeHtml(localize("Starting Age Generation", "Losowanie Wieku Początkowego"))}</header>
		<div><strong>${escapeHtml(localize("Race", "Rasa"))}:</strong> ${escapeHtml(race.name)}</div>
		<div><strong>${escapeHtml(localize("Age band", "Wariant wieku"))}:</strong> ${escapeHtml(bandLabel)}</div>
		<div><strong>${escapeHtml(localize("Formula", "Formuła"))}:</strong> ${escapeHtml(formula)}</div>
		<div><strong>${escapeHtml(localize("Roll", "Rzut"))}:</strong> ${escapeHtml(rollValues)}</div>
		${minimumNote}
		<div><strong>${escapeHtml(localize("Final Age", "Wiek końcowy"))}:</strong> ${escapeHtml(String(finalValue))}</div>
	</section>`;
	await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
}

async function createFateChatCard(actor, race, formula, resolved, minimum, finalValue) {
	const raw = rawDiceTotal(resolved.roll);
	const minimumApplied = finalValue !== resolved.value;
	const content = `<section class="wfrp1ed-race-secondary-chat">
		<header>${escapeHtml(localize("Starting Fate Points", "Początkowe Punkty Przeznaczenia"))}</header>
		<div><strong>${escapeHtml(localize("Race", "Rasa"))}:</strong> ${escapeHtml(race.name)}</div>
		<div><strong>${escapeHtml(localize("Formula", "Formuła"))}:</strong> ${escapeHtml(formula)}</div>
		<div><strong>${escapeHtml(localize("Roll", "Rzut"))}:</strong> ${escapeHtml(raw)}</div>
		${minimumApplied ? `<div><strong>${escapeHtml(localize("Minimum", "Minimum"))}:</strong> ${escapeHtml(String(minimum))}</div>` : ""}
		<div><strong>${escapeHtml(localize("Final Value", "Wartość końcowa"))}:</strong> ${escapeHtml(String(finalValue))}</div>
	</section>`;
	await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
}

function rawDiceTotal(roll) {
	const dice = Array.isArray(roll?.dice) ? roll.dice : [];
	const values = dice.flatMap((term) => (term?.results ?? [])
		.filter((result) => result?.active !== false)
		.map((result) => Number(result.result))
		.filter(Number.isFinite));
	return values.length ? String(values.reduce((sum, value) => sum + value, 0)) : "—";
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ??
		actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function finiteWholeNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function classicSheetRoot(root) {
	if (root?.classList?.contains("wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function reportError(error) {
	console.error("WFRP1ED | Race secondary generation failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function escapeHtml(value) {
	const element = document.createElement("div");
	element.textContent = String(value ?? "");
	return element.innerHTML;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
