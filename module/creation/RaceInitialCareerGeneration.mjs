import { CAREER_TIER } from "../data-models/item/CareerData.mjs";
import { CareerProgression } from "../careers/CareerProgression.mjs";
import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

class RaceDefinitionError extends Error {
	constructor(race, detail) {
		const raceName = String(race?.name ?? localize("Unnamed Race", "Rasa bez nazwy"));
		super(localize(
			`Invalid Race template — ${raceName}. ${detail}`,
			`Błędnie zdefiniowany szablon Rasy — ${raceName}. ${detail}`,
		));
		this.name = "RaceDefinitionError";
		this.raceName = raceName;
		this.detail = detail;
	}
}

installRaceInitialCareerGeneration();

/**
 * Character Creation: roll the initial Basic Career from the embedded Race's
 * d100 table for the currently selected Career Class, then delegate the actual
 * Career assignment/acquisition lifecycle to CareerProgression.
 */
function installRaceInitialCareerGeneration() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		const sheet = classicSheetRoot(root);
		if (!(sheet instanceof HTMLElement)) return;
		installControl(application, actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const application = actor.sheet;
			const sheet = classicSheetRoot(asElement(application?.element));
			if (sheet instanceof HTMLElement) installControl(application, actor, sheet);
		});
	}
}

function installControl(application, actor, sheet) {
	const field = sheet.querySelector(".header-field--current-career");
	if (!(field instanceof HTMLElement)) return;
	field.querySelector(".wfrp1ed-race-initial-career-roll")?.remove?.();

	const race = embeddedRace(actor);
	if (!race) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1ed-race-initial-career-roll";
	button.innerHTML = '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i>';
	button.title = localize(
		`Roll initial Career from Race: ${race.name}`,
		`Wylosuj Profesję początkową według rasy: ${race.name}`,
	);
	button.setAttribute("aria-label", button.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void generateInitialCareer(application, actor, race).catch((error) => reportError(error, race));
	});
	field.append(button);
}

async function generateInitialCareer(sheet, actor, race) {
	if (!sheet?.document || String(sheet.document.uuid ?? "") !== String(actor.uuid ?? "")) {
		throw new Error(localize(
			"The Character sheet is not available for initial Career assignment.",
			"Karta postaci nie jest dostępna do przypisania Profesji początkowej.",
		));
	}

	const careerClass = canonicalClassId(actor.system?.details?.careerClass);
	if (!careerClass) {
		throw new Error(localize(
			"Select a Career Class before rolling the initial Career.",
			"Wybierz Klasę Zawodową przed losowaniem Profesji początkowej.",
		));
	}

	const table = Array.isArray(race.system?.basicCareerTables?.[careerClass])
		? race.system.basicCareerTables[careerClass]
		: [];
	await validateCareerTable(race, careerClass, table);

	const roll = await new Roll("1d100").evaluate({ allowInteractive: false });
	await showDice(roll);
	const result = wholeNumber(roll.total, 0);
	const row = table.find((candidate) =>
		result >= wholeNumber(candidate?.min, 1) && result <= wholeNumber(candidate?.max, 100),
	);
	if (!row?.career) {
		throw new RaceDefinitionError(race, localize(
			`The "Random Initial Careers" table for ${classLabel(careerClass)} has no result for d100=${result}. Fix the table so it covers 01–100 exactly once.`,
			`Tabela „Losowe Profesje Początkowe” dla klasy ${classLabel(careerClass)} nie ma wyniku dla k100=${result}. Popraw tabelę tak, aby zakres 01–100 był pokryty dokładnie jeden raz.`,
		));
	}

	const career = await resolveCareerReference(row.career, race, careerClass, row);
	await CareerProgression.assignInitialCareer(sheet, career);
	await createRollChatCard(actor, race, careerClass, row, roll, career);
	void actor.sheet?.render?.();
}

async function validateCareerTable(race, careerClass, table) {
	if (!table.length) {
		throw new RaceDefinitionError(race, localize(
			`The "Random Initial Careers" table for Career Class ${classLabel(careerClass)} is empty. Add d100 rows covering 01–100.`,
			`Tabela „Losowe Profesje Początkowe” dla klasy ${classLabel(careerClass)} jest pusta. Dodaj wiersze k100 pokrywające zakres 01–100.`,
		));
	}

	const coverage = Array.from({ length: 101 }, () => 0);
	for (let index = 0; index < table.length; index += 1) {
		const row = table[index];
		const min = wholeNumber(row?.min, 0);
		const max = wholeNumber(row?.max, 0);
		if (min < 1 || max > 100 || min > max) {
			throw new RaceDefinitionError(race, localize(
				`"Random Initial Careers" / ${classLabel(careerClass)} row ${index + 1} has invalid d100 range ${min}–${max}. Use a valid range inside 01–100.`,
				`„Losowe Profesje Początkowe” / ${classLabel(careerClass)}: wiersz ${index + 1} ma błędny zakres k100 ${min}–${max}. Użyj poprawnego zakresu w granicach 01–100.`,
			));
		}
		if (!careerReferenceHasIdentity(row?.career)) {
			throw new RaceDefinitionError(race, localize(
				`"Random Initial Careers" / ${classLabel(careerClass)} / ${rangeLabel(row)} has no valid Career reference. Drop a Career Item onto that row again.`,
				`„Losowe Profesje Początkowe” / ${classLabel(careerClass)} / ${rangeLabel(row)} nie zawiera prawidłowego odwołania do Profesji. Upuść ponownie Przedmiot Profesji na ten wiersz.`,
			));
		}
		for (let value = min; value <= max; value += 1) coverage[value] += 1;
	}

	const gap = firstCoverageRun(coverage, 0);
	if (gap) {
		throw new RaceDefinitionError(race, localize(
			`"Random Initial Careers" / ${classLabel(careerClass)} has a d100 gap at ${rangeText(gap.start, gap.end)}. Cover every result from 01 to 100.`,
			`„Losowe Profesje Początkowe” / ${classLabel(careerClass)} ma lukę k100 w zakresie ${rangeText(gap.start, gap.end)}. Każdy wynik od 01 do 100 musi być pokryty.`,
		));
	}
	const overlap = firstCoverageAboveOne(coverage);
	if (overlap) {
		throw new RaceDefinitionError(race, localize(
			`"Random Initial Careers" / ${classLabel(careerClass)} has overlapping d100 ranges at ${rangeText(overlap.start, overlap.end)}. Every result must belong to exactly one row.`,
			`„Losowe Profesje Początkowe” / ${classLabel(careerClass)} ma nakładające się zakresy k100 w ${rangeText(overlap.start, overlap.end)}. Każdy wynik musi należeć dokładnie do jednego wiersza.`,
		));
	}

	/* Resolve every row before rolling. This makes a broken Race template fail
	 * deterministically instead of succeeding or failing depending on d100. */
	for (const row of table) await resolveCareerReference(row.career, race, careerClass, row);
}

async function resolveCareerReference(reference, race, expectedClass, row) {
	let career = null;
	const uuid = String(reference?.uuid ?? "").trim();
	if (uuid) {
		try { career = await foundry.utils.fromUuid(uuid); }
		catch (_error) { career = null; }
	}

	if (!(career instanceof foundry.documents.Item) || career.type !== "career") {
		const rulesId = normalize(reference?.rulesId);
		const name = normalize(reference?.name);
		career = [...(game.items ?? [])].find((item) =>
			item?.type === "career" && (
				(rulesId && normalize(item.system?.rulesId) === rulesId) ||
				(!rulesId && name && normalize(item.name) === name)
			),
		) ?? null;
	}

	const location = localize(
		`Random Initial Careers / ${classLabel(expectedClass)} / ${rangeLabel(row)}`,
		`Losowe Profesje Początkowe / ${classLabel(expectedClass)} / ${rangeLabel(row)}`,
	);
	if (!(career instanceof foundry.documents.Item) || career.type !== "career") {
		throw new RaceDefinitionError(race, localize(
			`${location}: referenced Career "${String(reference?.name ?? reference?.rulesId ?? "—")}" is not available. Drop the Career Item onto this row again.`,
			`${location}: wskazana Profesja „${String(reference?.name ?? reference?.rulesId ?? "—")}" nie jest dostępna. Upuść ponownie Przedmiot Profesji na ten wiersz.`,
		));
	}
	if (String(career.system?.tier ?? "") !== CAREER_TIER.BASIC) {
		throw new RaceDefinitionError(race, localize(
			`${location}: ${career.name} is not a Basic Career. Random initial-Career tables may contain only Basic Careers.`,
			`${location}: ${career.name} nie jest Profesją Podstawową. Tabele losowych Profesji początkowych mogą zawierać wyłącznie Profesje Podstawowe.`,
		));
	}
	const actualClass = canonicalClassId(career.system?.class);
	if (actualClass !== expectedClass) {
		throw new RaceDefinitionError(race, localize(
			`${location}: ${career.name} belongs to Career Class ${classLabel(actualClass)}, but this table is for ${classLabel(expectedClass)}.`,
			`${location}: ${career.name} należy do Klasy Zawodowej ${classLabel(actualClass)}, ale ta tabela jest przeznaczona dla klasy ${classLabel(expectedClass)}.`,
		));
	}
	return career;
}

async function showDice(roll) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;
	if (!Array.isArray(roll?.dice) || !roll.dice.length) return;
	try { await dice3d.showForRoll(roll, game.user, true, [], false); }
	catch (error) { console.error("WFRP1ED | Unable to display initial-Career dice animation.", error); }
}

async function createRollChatCard(actor, race, careerClass, row, roll, career) {
	const content = `<section class="wfrp1e-race-generation-card">
		<h3 class="wfrp1e-race-generation-card__title">${escapeHtml(localize("Initial Career Roll", "Losowanie Profesji Początkowej"))}</h3>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Race", "Rasa"))}</span><strong>${escapeHtml(race.name)}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Career Class", "Klasa Zawodowa"))}</span><strong>${escapeHtml(classLabel(careerClass))}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Roll", "Rzut"))}</span><strong>${escapeHtml(`k100 = ${wholeNumber(roll.total, 0)}`)}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Table range", "Zakres tabeli"))}</span><strong>${escapeHtml(rangeLabel(row))}</strong></div>
		<div class="wfrp1e-race-generation-card__row wfrp1e-race-generation-card__row--final"><span>${escapeHtml(localize("Initial Career", "Profesja początkowa"))}</span><strong>${escapeHtml(career.name)}</strong></div>
	</section>`;
	await ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content,
		flags: { wfrp1ed: { raceInitialCareerGeneration: { actorUuid: actor.uuid, raceUuid: race.uuid, careerUuid: career.uuid } } },
	});
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ?? actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function careerReferenceHasIdentity(reference) {
	return Boolean(
		String(reference?.uuid ?? "").trim() ||
		String(reference?.rulesId ?? "").trim() ||
		String(reference?.name ?? "").trim(),
	);
}

function canonicalClassId(value) {
	const aliases = {
		warrior: "warrior", wojownik: "warrior",
		ranger: "ranger", "wędrowiec": "ranger", wedrowiec: "ranger",
		rogue: "rogue", "łotr": "rogue", lotr: "rogue", "łotrzyk": "rogue", lotrzyk: "rogue",
		academic: "academic", uczony: "academic",
	};
	return aliases[normalize(value)] ?? "";
}

function classLabel(value) {
	const labels = {
		warrior: ["Warrior", "Wojownik"],
		ranger: ["Ranger", "Wędrowiec"],
		rogue: ["Rogue", "Łotrzyk"],
		academic: ["Academic", "Uczony"],
	};
	const entry = labels[value];
	return entry ? (game.i18n.lang === "pl" ? entry[1] : entry[0]) : String(value || "—");
}

function firstCoverageRun(coverage, expected) {
	for (let start = 1; start <= 100; start += 1) {
		if (coverage[start] !== expected) continue;
		let end = start;
		while (end + 1 <= 100 && coverage[end + 1] === expected) end += 1;
		return { start, end };
	}
	return null;
}

function firstCoverageAboveOne(coverage) {
	for (let start = 1; start <= 100; start += 1) {
		if (coverage[start] <= 1) continue;
		let end = start;
		while (end + 1 <= 100 && coverage[end + 1] > 1) end += 1;
		return { start, end };
	}
	return null;
}

function rangeLabel(row) {
	return rangeText(wholeNumber(row?.min, 0), wholeNumber(row?.max, 0));
}

function rangeText(start, end) {
	const format = (value) => String(value).padStart(2, "0");
	return start === end ? format(start) : `${format(start)}–${format(end)}`;
}

function wholeNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function escapeHtml(value) {
	return foundry.utils.escapeHTML(String(value ?? ""));
}

function classicSheetRoot(root) {
	if (!(root instanceof HTMLElement)) return null;
	return root.matches?.(".wfrp1ed-classic-sheet") ? root : root.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function reportError(error, race) {
	console.error("WFRP1ED | Race initial Career generation failed.", error);
	if (error instanceof RaceDefinitionError) {
		ui.notifications.error(error.message, { permanent: true });
		return;
	}
	ui.notifications.error(error?.message ?? localize(
		`Unable to generate the initial Career from Race ${race?.name ?? "—"}.`,
		`Nie udało się wylosować Profesji początkowej z Rasy ${race?.name ?? "—"}.`,
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
