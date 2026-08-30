import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

installRaceHeightGeneration();

/**
 * Race-driven Height generation for Character Creation Mode.
 * Gender remains player-authored text. Recognizable Male/Female values select
 * the matching Race formula automatically; otherwise the roll action asks
 * which formula to use without overwriting the Gender field.
 */
function installRaceHeightGeneration() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		const sheet = classicSheetRoot(root);
		if (!(sheet instanceof HTMLElement)) return;
		installControl(actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const sheet = classicSheetRoot(asElement(actor.sheet?.element));
			if (sheet instanceof HTMLElement) installControl(actor, sheet);
		});
	}
}

function installControl(actor, sheet) {
	const field = sheet.querySelector(".header-field--height");
	if (!(field instanceof HTMLElement)) return;
	field.querySelector(".wfrp1ed-race-height-roll")?.remove?.();

	const race = embeddedRace(actor);
	const height = race?.system?.height;
	if (!race || !height) return;
	const maleFormula = String(height.maleFormula ?? "").trim();
	const femaleFormula = String(height.femaleFormula ?? "").trim();
	if (!maleFormula && !femaleFormula) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1ed-race-height-roll";
	button.innerHTML = '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i>';
	button.title = localize(
		`Roll starting Height from Race: ${race.name}. Male/Female formula is selected from Gender when recognizable; otherwise you will be asked.`,
		`Wylosuj początkowy Wzrost według rasy: ${race.name}. Formuła mężczyzny/kobiety jest wybierana na podstawie pola Płeć, jeśli wartość jest rozpoznawalna; w przeciwnym razie system zapyta o wariant.`,
	);
	button.setAttribute("aria-label", button.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void rollStartingHeight(actor, race).catch((error) => reportError(error, race));
	});
	field.append(button);
}

async function rollStartingHeight(actor, race) {
	const height = race?.system?.height;
	if (!height) return;

	let gender = canonicalGender(actor.system?.details?.gender);
	if (!gender) gender = await chooseHeightFormula(race);
	if (!gender) return;

	const formula = String(gender === "male" ? height.maleFormula : height.femaleFormula).trim();
	if (!formula) {
		throw new RaceDefinitionError(race, localize(
			`Height generation has no ${gender === "male" ? "Male" : "Female"} formula. Define it on the Race sheet or choose the other variant.`,
			`Losowanie wzrostu nie ma formuły dla wariantu ${gender === "male" ? "Mężczyzna" : "Kobieta"}. Zdefiniuj ją na karcie Rasy albo wybierz drugi wariant.`,
		));
	}

	const resolved = await evaluateFormula(formula, race);
	await animateRoll(resolved.roll);

	const unit = String(height.unit ?? "").trim();
	const storedValue = unit ? `${resolved.value} ${unit}` : String(resolved.value);
	await actor.update({ "system.details.height": storedValue });
	await createChatCard(actor, race, gender, formula, resolved, unit, storedValue);
}

async function chooseHeightFormula(race) {
	const DialogV2 = foundry.applications?.api?.DialogV2;
	if (!DialogV2?.wait) {
		throw new Error(localize(
			"Foundry DialogV2 is unavailable; Height formula cannot be selected.",
			"DialogV2 Foundry jest niedostępny; nie można wybrać formuły wzrostu.",
		));
	}

	return DialogV2.wait({
		window: { title: localize("Choose Height Formula", "Wybierz formułę wzrostu") },
		content: `<p>${escapeHtml(localize(
			`Gender is empty or not recognized for ${race.name}. Choose which Race Height formula to use. This does not change the Gender field.`,
			`Pole Płeć jest puste lub ma nierozpoznaną wartość dla rasy ${race.name}. Wybierz, której formuły wzrostu Rasy użyć. Nie zmieni to pola Płeć.`,
		))}</p>`,
		buttons: [
			{ action: "male", label: localize("Male", "Mężczyzna"), icon: "fa-solid fa-mars", callback: () => "male" },
			{ action: "female", label: localize("Female", "Kobieta"), icon: "fa-solid fa-venus", callback: () => "female" },
		],
		rejectClose: false,
		modal: true,
	});
}

async function evaluateFormula(formula, race) {
	try {
		const roll = await new Roll(formula).evaluate({ allowInteractive: false });
		const total = Number(roll.total);
		if (!Number.isFinite(total)) throw new Error(`Non-numeric result for ${formula}`);
		return { roll, value: Math.trunc(total) };
	} catch (error) {
		throw new RaceDefinitionError(race, localize(
			`Height generation contains an invalid formula: ${formula}.`,
			`Losowanie wzrostu zawiera błędną formułę: ${formula}.`,
		), { cause: error });
	}
}

async function animateRoll(roll) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;
	if (!Array.isArray(roll?.dice) || roll.dice.length === 0) return;
	try {
		const visual = await visualRollForUnsupportedSmallDice(roll);
		await dice3d.showForRoll(visual ?? roll, game.user, true, [], false);
	} catch (error) {
		console.error("WFRP1ED | Unable to display Height dice animation.", error);
	}
}

async function visualRollForUnsupportedSmallDice(roll) {
	const dice = Array.isArray(roll?.dice) ? roll.dice : [];
	if (!dice.length || !dice.every((term) => [2, 3].includes(Number(term?.faces)))) return null;
	const original = dice.flatMap((term) => (term?.results ?? [])
		.filter((result) => result?.active !== false)
		.map((result) => ({ faces: Number(term.faces), value: Number(result.result) })));
	if (!original.length) return null;
	const visual = await new Roll(`${original.length}d6`).evaluate({ allowInteractive: false });
	const results = visual.dice?.[0]?.results ?? [];
	if (results.length < original.length) return null;
	for (let index = 0; index < original.length; index += 1) {
		const source = original[index];
		results[index].result = source.faces === 3 ? (source.value * 2) - 1 : (source.value === 1 ? 1 : 4);
	}
	return visual;
}

async function createChatCard(actor, race, gender, formula, resolved, unit, storedValue) {
	const raw = rawDiceTotal(resolved.roll);
	const content = `<section class="wfrp1ed-race-secondary-chat">
		<header>${escapeHtml(localize("Starting Height Generation", "Losowanie Wzrostu Początkowego"))}</header>
		<div><strong>${escapeHtml(localize("Race", "Rasa"))}:</strong> ${escapeHtml(race.name)}</div>
		<div><strong>${escapeHtml(localize("Variant", "Wariant"))}:</strong> ${escapeHtml(genderLabel(gender))}</div>
		<div><strong>${escapeHtml(localize("Formula", "Formuła"))}:</strong> ${escapeHtml(formula)}</div>
		<div><strong>${escapeHtml(localize("Roll", "Rzut"))}:</strong> ${escapeHtml(raw)}</div>
		${unit ? `<div><strong>${escapeHtml(localize("Unit", "Jednostka"))}:</strong> ${escapeHtml(unit)}</div>` : ""}
		<div><strong>${escapeHtml(localize("Final Height", "Wzrost końcowy"))}:</strong> ${escapeHtml(storedValue)}</div>
	</section>`;
	await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content });
}

function rawDiceTotal(roll) {
	const values = (Array.isArray(roll?.dice) ? roll.dice : []).flatMap((term) =>
		(term?.results ?? []).filter((result) => result?.active !== false)
			.map((result) => Number(result.result)).filter(Number.isFinite));
	return values.length ? String(values.reduce((sum, value) => sum + value, 0)) : "—";
}

function canonicalGender(value) {
	const normalized = normalize(value);
	if (["male", "m", "man", "mężczyzna", "mezczyzna"].includes(normalized)) return "male";
	if (["female", "f", "woman", "kobieta"].includes(normalized)) return "female";
	return "";
}

function genderLabel(value) {
	return value === "male" ? localize("Male", "Mężczyzna") : localize("Female", "Kobieta");
}

class RaceDefinitionError extends Error {
	constructor(race, detail, options = {}) {
		const raceName = String(race?.name ?? localize("Unnamed Race", "Rasa bez nazwy"));
		super(localize(
			`Invalid Race template — ${raceName}. ${detail}`,
			`Błędnie zdefiniowany szablon Rasy — ${raceName}. ${detail}`,
		), options);
		this.name = "RaceDefinitionError";
	}
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ?? actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function classicSheetRoot(root) {
	if (root?.classList?.contains("wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function escapeHtml(value) { return foundry.utils.escapeHTML(String(value ?? "")); }
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }

function reportError(error, race) {
	console.error("WFRP1ED | Race Height generation failed.", error);
	ui.notifications.error(error?.message ?? localize(
		`Unable to generate Height from Race ${race?.name ?? "—"}.`,
		`Nie udało się wylosować Wzrostu dla Rasy ${race?.name ?? "—"}.`,
	), error instanceof RaceDefinitionError ? { permanent: true } : {});
}
