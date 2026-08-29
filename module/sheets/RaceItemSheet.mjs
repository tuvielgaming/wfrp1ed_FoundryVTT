import {
	RACE_CAREER_CLASSES,
	RACE_CHARACTERISTIC_IDS,
} from "../data-models/item/RaceData.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

const CHARACTERISTIC_LABELS = Object.freeze({
	m: ["Sz", "M"],
	ws: ["WW", "WS"],
	bs: ["US", "BS"],
	s: ["S", "S"],
	t: ["Wt", "T"],
	w: ["Żyw", "W"],
	i: ["I", "I"],
	a: ["A", "A"],
	dex: ["Zr", "Dex"],
	ld: ["CP", "Ld"],
	int: ["Int", "Int"],
	cl: ["Op", "Cl"],
	wp: ["SW", "WP"],
	fel: ["Ogd", "Fel"],
});

/**
 * Native Foundry v14 sheet for WFRP 1e Race Items.
 *
 * This first authoring surface intentionally exposes the scalar generation
 * contract (profile, vision, alignment, height, age, Fate). The model already
 * owns the structured skill/career distributions; dedicated row editors are
 * added in the next character-generation slice so authors never have to edit
 * JSON or manage external RollTable UUIDs.
 */
export class RaceItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"race-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 820,
			height: 820,
		},
		tag: "form",
		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},
	};

	static PARTS = {
		form: {
			template: "systems/wfrp1ed/templates/item/race-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const source = this.document.system?.toObject?.() ??
			foundry.utils.deepClone(this.document.system ?? {});

		context.item = this.document;
		context.system = source;
		context.editable = this.isEditable;
		context.raceUi = {
			characteristics: RACE_CHARACTERISTIC_IDS.map((id) => ({
				id,
				label: characteristicLabel(id),
				formula: String(source.profile?.[id] ?? ""),
			})),
			careerClasses: RACE_CAREER_CLASSES.map((careerClass) => ({
				id: careerClass,
				label: careerClassLabel(careerClass),
				skillRows: source.skillTables?.[careerClass]?.length ?? 0,
				careerRows: source.basicCareerTables?.[careerClass]?.length ?? 0,
			})),
			counts: {
				languages: source.languages?.length ?? 0,
				psychology: source.psychology?.length ?? 0,
				ageBands: source.age?.skillCountModifiers?.length ?? 0,
				mandatorySkills: source.mandatorySkills?.length ?? 0,
				careerOverrides: source.careerClassOverrides?.length ?? 0,
			},
			labels: labels(),
		};

		return context;
	}
}

function characteristicLabel(id) {
	const labels = CHARACTERISTIC_LABELS[id] ?? [id, id];
	return game.i18n.lang === "pl" ? labels[0] : labels[1];
}

function careerClassLabel(id) {
	const labels = {
		warrior: ["Wojownik", "Warrior"],
		ranger: ["Wędrowiec", "Ranger"],
		rogue: ["Łotrzyk", "Rogue"],
		academic: ["Uczony", "Academic"],
	};
	const pair = labels[id] ?? [id, id];
	return game.i18n.lang === "pl" ? pair[0] : pair[1];
}

function labels() {
	return {
		name: localize("Name", "Nazwa"),
		rulesId: localize("Rules ID", "Identyfikator reguły"),
		rulesIdHint: localize(
			"Stable language-neutral rule identity. Leave blank for an ordinary custom race unless another rule must address it by ID.",
			"Stała, niezależna od języka tożsamość reguły. Dla zwykłej własnej rasy pozostaw puste, chyba że inna reguła musi odwoływać się do niej po ID.",
		),
		description: localize("Description", "Opis"),
		profile: localize("Starting profile formulas", "Formuły profilu początkowego"),
		profileHint: localize(
			"These formulas are rolled once during character creation. They are not permanent racial modifiers.",
			"Te formuły są rzucane jeden raz podczas tworzenia postaci. Nie są stałymi modyfikatorami rasowymi.",
		),
		racialProperties: localize("Racial properties", "Właściwości rasy"),
		nightVision: localize("Night Vision", "Widzenie w ciemnościach"),
		startingAlignment: localize("Starting alignment", "Początkowy charakter"),
		height: localize("Height generation", "Losowanie wzrostu"),
		maleFormula: localize("Male formula", "Formuła mężczyzny"),
		femaleFormula: localize("Female formula", "Formuła kobiety"),
		unit: localize("Unit", "Jednostka"),
		age: localize("Age generation", "Losowanie wieku"),
		youngFormula: localize("Young", "Młody"),
		matureFormula: localize("Mature", "Dojrzały"),
		minimumAge: localize("Minimum age", "Minimalny wiek"),
		rerollBelowMinimum: localize(
			"If below minimum, roll again and add",
			"Jeśli poniżej minimum, rzuć ponownie i dodaj",
		),
		fate: localize("Initial Fate", "Początkowe Punkty Przeznaczenia"),
		fateFormula: localize("Formula", "Formuła"),
		fateMinimum: localize("Minimum", "Minimum"),
		structuredData: localize("Structured creation data", "Strukturalne dane tworzenia"),
		structuredHint: localize(
			"The Race Item already owns these collections. Dedicated drag-and-drop editors for them are the next implementation slice.",
			"Przedmiot Rasy już posiada te kolekcje. Dedykowane edytory z przeciąganiem i upuszczaniem będą następnym etapem implementacji.",
		),
		languages: localize("Languages", "Języki"),
		psychology: localize("Psychology", "Psychologia"),
		ageBands: localize("Age/skill bands", "Przedziały wieku/umiejętności"),
		mandatorySkills: localize("Mandatory skill rules", "Reguły obowiązkowych umiejętności"),
		careerOverrides: localize("Career Class overrides", "Wyjątki Klas Profesji"),
		skillTableRows: localize("Skill table rows", "Wiersze tabel umiejętności"),
		careerTableRows: localize("Basic Career rows", "Wiersze Profesji Podstawowych"),
	};
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
