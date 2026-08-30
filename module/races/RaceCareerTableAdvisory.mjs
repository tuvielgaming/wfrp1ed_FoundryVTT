import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

installRaceCareerTableAdvisory();

/**
 * Starting-Career tables are GM-authored content. Advanced Careers and Careers
 * from another canonical class are therefore allowed, but suspicious drops get
 * a non-blocking warning so accidental authoring mistakes are easier to spot.
 */
function installRaceCareerTableAdvisory() {
	if (RaceItemSheet.prototype.__wfrpRaceCareerTableAdvisoryInstalled === true) return;
	const previous = RaceItemSheet.prototype._onDropDocument;
	if (typeof previous !== "function") return;

	RaceItemSheet.prototype._onDropDocument = async function raceCareerTableAdvisory(event, document) {
		const target = event?.target?.closest?.('[data-race-drop-zone="careerTable"]');
		const isCareerDrop = target instanceof HTMLElement &&
			document instanceof foundry.documents.Item &&
			document.type === "career";
		const tableClass = isCareerDrop ? canonicalClassId(target.dataset.careerClass) : "";

		const result = await previous.call(this, event, document);
		if (isCareerDrop) warnIfUnusualCareer(document, tableClass);
		return result;
	};

	Object.defineProperty(
		RaceItemSheet.prototype,
		"__wfrpRaceCareerTableAdvisoryInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function warnIfUnusualCareer(career, tableClass) {
	const warnings = [];
	const tier = String(career.system?.tier ?? "").trim();
	if (tier === "advanced") {
		warnings.push(localize(
			"it is an Advanced Career (Core starting tables normally use Basic Careers)",
			"jest Profesją Zaawansowaną (tabele początkowe z Księgi Głównej zwykle używają Profesji Podstawowych)",
		));
	}

	const actualClass = canonicalClassId(career.system?.class);
	if (tableClass && actualClass && actualClass !== tableClass) {
		warnings.push(localize(
			`it belongs to ${classLabel(actualClass)}, while the target table is ${classLabel(tableClass)}`,
			`należy do klasy ${classLabel(actualClass)}, a tabela docelowa jest dla klasy ${classLabel(tableClass)}`,
		));
	}
	if (!warnings.length) return;

	ui.notifications.warn(localize(
		`Career "${career.name}" was added to Random Initial Careers / ${classLabel(tableClass)}. Note: ${warnings.join("; ")}. This is only an authoring warning; the entry was kept and can be used during character creation.`,
		`Profesja „${career.name}” została dodana do „Losowe Profesje Początkowe” / ${classLabel(tableClass)}. Uwaga: ${warnings.join("; ")}. To tylko ostrzeżenie podczas tworzenia szablonu — wpis został zachowany i może być użyty podczas tworzenia postaci.`,
	), { permanent: false });
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

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
