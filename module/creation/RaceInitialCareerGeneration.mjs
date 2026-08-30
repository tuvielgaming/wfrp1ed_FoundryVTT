import { CareerProgression } from "../careers/CareerProgression.mjs";
import "../races/RaceCareerTableAdvisory.mjs";
import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

class RaceDefinitionError extends Error {
	constructor(race, detail) {
		const name = String(race?.name ?? localize("Unnamed Race", "Rasa bez nazwy"));
		super(localize(`Invalid Race template — ${name}. ${detail}`, `Błędnie zdefiniowany szablon Rasy — ${name}. ${detail}`));
		this.name = "RaceDefinitionError";
	}
}

install();

function install() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
		const root = asElement(element) ?? asElement(application?.element);
		const sheet = classicSheetRoot(root);
		if (sheet instanceof HTMLElement) installControl(application, actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const app = actor.sheet;
			const sheet = classicSheetRoot(asElement(app?.element));
			if (sheet instanceof HTMLElement) installControl(app, actor, sheet);
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
	button.title = localize(`Roll initial Career from Race: ${race.name}`, `Wylosuj Profesję początkową według rasy: ${race.name}`);
	button.setAttribute("aria-label", button.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void generate(application, actor, race).catch((error) => reportError(error, race));
	});
	field.append(button);
}

async function generate(sheet, actor, race) {
	if (!sheet?.document || String(sheet.document.uuid ?? "") !== String(actor.uuid ?? "")) {
		throw new Error(localize("The Character sheet is not available for initial Career assignment.", "Karta postaci nie jest dostępna do przypisania Profesji początkowej."));
	}
	const careerClass = canonicalClassId(actor.system?.details?.careerClass);
	if (!careerClass) throw new Error(localize("Select a Career Class before rolling the initial Career.", "Wybierz Klasę Zawodową przed losowaniem Profesji początkowej."));

	const table = Array.isArray(race.system?.basicCareerTables?.[careerClass]) ? race.system.basicCareerTables[careerClass] : [];
	await validateTable(race, careerClass, table);

	const roll = await new Roll("1d100").evaluate({ allowInteractive: false });
	await showDice(roll);
	const result = wholeNumber(roll.total, 0);
	const row = table.find((r) => result >= wholeNumber(r?.min, 1) && result <= wholeNumber(r?.max, 100));
	if (!row?.career) throw new RaceDefinitionError(race, localize(
		`The "Random Initial Careers" table for ${classLabel(careerClass)} has no result for d100=${result}.`,
		`Tabela „Losowe Profesje Początkowe” dla klasy ${classLabel(careerClass)} nie ma wyniku dla k100=${result}.`,
	));

	const career = await resolveCareer(row.career, race, careerClass, row);
	await CareerProgression.assignInitialCareer(sheet, career);
	await createChat(actor, race, careerClass, row, roll, career);
	void actor.sheet?.render?.();
}

async function validateTable(race, careerClass, table) {
	if (!table.length) throw new RaceDefinitionError(race, localize(
		`The "Random Initial Careers" table for ${classLabel(careerClass)} is empty.`,
		`Tabela „Losowe Profesje Początkowe” dla klasy ${classLabel(careerClass)} jest pusta.`,
	));

	const coverage = Array(101).fill(0);
	for (let index = 0; index < table.length; index += 1) {
		const row = table[index];
		const min = wholeNumber(row?.min, 0);
		const max = wholeNumber(row?.max, 0);
		if (min < 1 || max > 100 || min > max) throw new RaceDefinitionError(race, localize(
			`"Random Initial Careers" / ${classLabel(careerClass)} row ${index + 1} has invalid d100 range ${min}–${max}.`,
			`„Losowe Profesje Początkowe” / ${classLabel(careerClass)}: wiersz ${index + 1} ma błędny zakres k100 ${min}–${max}.`,
		));
		if (!careerReferenceHasIdentity(row?.career)) throw new RaceDefinitionError(race, localize(
			`"Random Initial Careers" / ${classLabel(careerClass)} / ${rangeLabel(row)} has no valid Career reference.`,
			`„Losowe Profesje Początkowe” / ${classLabel(careerClass)} / ${rangeLabel(row)} nie zawiera prawidłowego odwołania do Profesji.`,
		));
		for (let value = min; value <= max; value += 1) coverage[value] += 1;
	}

	const gap = coverageRun(coverage, (value) => value === 0);
	if (gap) throw new RaceDefinitionError(race, localize(
		`"Random Initial Careers" / ${classLabel(careerClass)} has a d100 gap at ${rangeText(gap.start, gap.end)}.`,
		`„Losowe Profesje Początkowe” / ${classLabel(careerClass)} ma lukę k100 w zakresie ${rangeText(gap.start, gap.end)}.`,
	));
	const overlap = coverageRun(coverage, (value) => value > 1);
	if (overlap) throw new RaceDefinitionError(race, localize(
		`"Random Initial Careers" / ${classLabel(careerClass)} has overlapping d100 ranges at ${rangeText(overlap.start, overlap.end)}.`,
		`„Losowe Profesje Początkowe” / ${classLabel(careerClass)} ma nakładające się zakresy k100 w ${rangeText(overlap.start, overlap.end)}.`,
	));

	// The Race table is authoritative. Resolve references, but do not enforce tier/class policy.
	for (const row of table) await resolveCareer(row.career, race, careerClass, row);
}

async function resolveCareer(reference, race, tableClass, row) {
	let career = null;
	const uuid = String(reference?.uuid ?? "").trim();
	if (uuid) {
		try { career = await foundry.utils.fromUuid(uuid); } catch (_error) { career = null; }
	}
	if (!(career instanceof foundry.documents.Item) || career.type !== "career") {
		const rulesId = normalize(reference?.rulesId);
		const name = normalize(reference?.name);
		career = [...(game.items ?? [])].find((item) => item?.type === "career" && ((rulesId && normalize(item.system?.rulesId) === rulesId) || (!rulesId && name && normalize(item.name) === name))) ?? null;
	}
	if (!(career instanceof foundry.documents.Item) || career.type !== "career") {
		const location = localize(`Random Initial Careers / ${classLabel(tableClass)} / ${rangeLabel(row)}`, `Losowe Profesje Początkowe / ${classLabel(tableClass)} / ${rangeLabel(row)}`);
		throw new RaceDefinitionError(race, localize(
			`${location}: referenced Career "${String(reference?.name ?? reference?.rulesId ?? "—")}" is not available.`,
			`${location}: wskazana Profesja „${String(reference?.name ?? reference?.rulesId ?? "—")}” nie jest dostępna.`,
		));
	}
	return career;
}

async function showDice(roll) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function" || !Array.isArray(roll?.dice) || !roll.dice.length) return;
	try { await dice3d.showForRoll(roll, game.user, true, [], false); }
	catch (error) { console.error("WFRP1ED | Unable to display initial-Career dice animation.", error); }
}

async function createChat(actor, race, careerClass, row, roll, career) {
	const content = `<section class="wfrp1e-race-generation-card">
		<h3 class="wfrp1e-race-generation-card__title">${escapeHtml(localize("Initial Career Roll", "Losowanie Profesji Początkowej"))}</h3>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Race", "Rasa"))}</span><strong>${escapeHtml(race.name)}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Career Class", "Klasa Zawodowa"))}</span><strong>${escapeHtml(classLabel(careerClass))}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Roll", "Rzut"))}</span><strong>${escapeHtml(`k100 = ${wholeNumber(roll.total, 0)}`)}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Table range", "Zakres tabeli"))}</span><strong>${escapeHtml(rangeLabel(row))}</strong></div>
		<div class="wfrp1e-race-generation-card__row wfrp1e-race-generation-card__row--final"><span>${escapeHtml(localize("Initial Career", "Profesja początkowa"))}</span><strong>${escapeHtml(career.name)}</strong></div>
	</section>`;
	await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, flags: { wfrp1ed: { raceInitialCareerGeneration: { actorUuid: actor.uuid, raceUuid: race.uuid, careerUuid: career.uuid } } } });
}

function embeddedRace(actor) { return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ?? actor?.items?.find?.((item) => item.type === "race") ?? null; }
function careerReferenceHasIdentity(ref) { return Boolean(String(ref?.uuid ?? "").trim() || String(ref?.rulesId ?? "").trim() || String(ref?.name ?? "").trim()); }
function canonicalClassId(value) {
	const aliases = { warrior: "warrior", wojownik: "warrior", ranger: "ranger", "wędrowiec": "ranger", wedrowiec: "ranger", rogue: "rogue", "łotr": "rogue", lotr: "rogue", "łotrzyk": "rogue", lotrzyk: "rogue", academic: "academic", uczony: "academic" };
	return aliases[normalize(value)] ?? "";
}
function classLabel(value) {
	const labels = { warrior: ["Warrior", "Wojownik"], ranger: ["Ranger", "Wędrowiec"], rogue: ["Rogue", "Łotrzyk"], academic: ["Academic", "Uczony"] };
	const entry = labels[value];
	return entry ? (game.i18n.lang === "pl" ? entry[1] : entry[0]) : String(value || "—");
}
function coverageRun(coverage, predicate) {
	for (let start = 1; start <= 100; start += 1) {
		if (!predicate(coverage[start])) continue;
		let end = start;
		while (end + 1 <= 100 && predicate(coverage[end + 1])) end += 1;
		return { start, end };
	}
	return null;
}
function rangeLabel(row) { return rangeText(wholeNumber(row?.min, 0), wholeNumber(row?.max, 0)); }
function rangeText(start, end) { const f = (v) => String(v).padStart(2, "0"); return start === end ? f(start) : `${f(start)}–${f(end)}`; }
function wholeNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : fallback; }
function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function escapeHtml(value) { return foundry.utils.escapeHTML(String(value ?? "")); }
function classicSheetRoot(root) { return root instanceof HTMLElement ? (root.matches?.(".wfrp1ed-classic-sheet") ? root : root.querySelector?.(".wfrp1ed-classic-sheet") ?? null) : null; }
function asElement(value) { if (value?.nodeType === 1 && typeof value.querySelector === "function") return value; if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0]; return null; }
function reportError(error, race) {
	console.error("WFRP1ED | Race initial Career generation failed.", error);
	if (error instanceof RaceDefinitionError) return ui.notifications.error(error.message, { permanent: true });
	ui.notifications.error(error?.message ?? localize(`Unable to generate the initial Career from Race ${race?.name ?? "—"}.`, `Nie udało się wylosować Profesji początkowej z Rasy ${race?.name ?? "—"}.`));
}
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }
