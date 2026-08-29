import {
	RACE_CAREER_CLASSES,
	RACE_CAREER_OVERRIDE_MODE,
	RACE_CHARACTERISTIC_IDS,
	RACE_INITIAL_SKILL_MODE,
} from "../data-models/item/RaceData.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

const CHARACTERISTIC_LABELS = Object.freeze({
	m: ["Sz", "M"], ws: ["WW", "WS"], bs: ["US", "BS"], s: ["S", "S"],
	t: ["Wt", "T"], w: ["Żyw", "W"], i: ["I", "I"], a: ["A", "A"],
	dex: ["Zr", "Dex"], ld: ["CP", "Ld"], int: ["Int", "Int"],
	cl: ["Op", "Cl"], wp: ["SW", "WP"], fel: ["Ogd", "Fel"],
});

export class RaceItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: ["wfrp1ed", "sheet", "item", "race-item-sheet", "wfrp1ed-parchment-window"],
		position: { width: 900, height: 860 },
		tag: "form",
		form: { submitOnChange: true, closeOnSubmit: false },
		actions: {
			addLanguage: this.#addLanguage,
			deleteLanguage: this.#deleteLanguage,
			addPsychology: this.#addPsychology,
			deletePsychology: this.#deletePsychology,
			addAgeBand: this.#addAgeBand,
			deleteAgeBand: this.#deleteAgeBand,
			deleteMandatoryRule: this.#deleteMandatoryRule,
			deleteMandatoryChoice: this.#deleteMandatoryChoice,
			deleteTableRow: this.#deleteTableRow,
			addCareerOverride: this.#addCareerOverride,
			deleteCareerOverride: this.#deleteCareerOverride,
			addRequirement: this.#addRequirement,
			deleteRequirement: this.#deleteRequirement,
		},
	};

	static PARTS = {
		form: { template: "systems/wfrp1ed/templates/item/race-sheet.hbs" },
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const source = sourceObject(this.document);

		context.item = this.document;
		context.system = source;
		context.editable = this.isEditable;
		context.raceUi = {
			characteristics: RACE_CHARACTERISTIC_IDS.map((id) => ({
				id,
				label: characteristicLabel(id),
				formula: String(source.profile?.[id] ?? ""),
			})),
			languages: presentLanguages(source.languages),
			psychology: presentPsychology(source.psychology),
			ageBands: presentAgeBands(source.age?.skillCountModifiers),
			mandatorySkills: presentMandatorySkills(source.mandatorySkills),
			careerOverrides: presentCareerOverrides(source.careerClassOverrides),
			careerClasses: RACE_CAREER_CLASSES.map((careerClass) => ({
				id: careerClass,
				label: careerClassLabel(careerClass),
				skillRows: presentTableRows(source.skillTables?.[careerClass], "skillTables", careerClass),
				careerRows: presentTableRows(source.basicCareerTables?.[careerClass], "basicCareerTables", careerClass),
				skillValidation: validatePercentileTable(source.skillTables?.[careerClass]),
				careerValidation: validatePercentileTable(source.basicCareerTables?.[careerClass]),
			})),
			characteristicOptions: RACE_CHARACTERISTIC_IDS.map((id) => ({ id, label: characteristicLabel(id) })),
			labels: labels(),
		};
		return context;
	}

	_onRender(context, options) {
		super._onRender(context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement)) return;

		for (const input of root.querySelectorAll("[data-race-array-edit]")) {
			if (input.dataset.raceArrayBound === "true") continue;
			input.dataset.raceArrayBound = "true";
			input.addEventListener("change", (event) => {
				void this.#persistArrayEdit(event.currentTarget).catch(reportAuthoringError);
			});
		}
	}

	async _onDropDocument(event, document) {
		if (!this.isEditable) return null;
		const target = event.target?.closest?.("[data-race-drop-zone]");
		if (!target) return super._onDropDocument(event, document);

		const zone = String(target.dataset.raceDropZone ?? "");
		if (!(document instanceof foundry.documents.Item)) return null;

		if (zone === "mandatorySkillsNew") {
			if (document.type !== "skill") return warnDrop("Skill", "Umiejętność");
			await this.#dropMandatorySkill(null, document);
			return document;
		}

		if (zone === "mandatorySkillChoice") {
			if (document.type !== "skill") return warnDrop("Skill", "Umiejętność");
			await this.#dropMandatorySkill(integer(target.dataset.ruleIndex, -1), document);
			return document;
		}

		if (zone === "skillTable") {
			if (document.type !== "skill") return warnDrop("Skill", "Umiejętność");
			await this.#dropTableDocument("skillTables", target, document);
			return document;
		}

		if (zone === "careerTable") {
			if (document.type !== "career") return warnDrop("Career", "Profesję");
			await this.#dropTableDocument("basicCareerTables", target, document);
			return document;
		}

		return super._onDropDocument(event, document);
	}

	async #persistArrayEdit(input) {
		if (!this.isEditable || !(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
		const kind = String(input.dataset.raceArrayEdit ?? "");
		const index = integer(input.dataset.index, -1);
		if (index < 0) return;

		if (["languages", "psychology", "ageBands"].includes(kind)) {
			const path = kind === "ageBands" ? "age.skillCountModifiers" : kind;
			const source = cloneArray(foundry.utils.getProperty(this.document.system, path));
			if (!source[index]) return;
			source[index][String(input.dataset.field ?? "")] = inputValue(input);
			await this.document.update({ [`system.${path}`]: source });
			return;
		}

		if (kind === "mandatoryRules") {
			const rules = cloneArray(this.document.system?.mandatorySkills);
			if (!rules[index]) return;
			const field = String(input.dataset.field ?? "");
			rules[index][field] = field === "minInitialSkills" || field === "choose"
				? Math.max(1, integer(input.value, 1))
				: String(input.value ?? "");
			await this.document.update({ "system.mandatorySkills": rules });
			return;
		}

		if (kind === "tableRows") {
			const tableName = String(input.dataset.table ?? "");
			const careerClass = String(input.dataset.careerClass ?? "");
			if (!["skillTables", "basicCareerTables"].includes(tableName) || !RACE_CAREER_CLASSES.includes(careerClass)) return;
			const tables = foundry.utils.deepClone(this.document.system?.[tableName]?.toObject?.() ?? this.document.system?.[tableName] ?? {});
			const rows = cloneArray(tables[careerClass]);
			if (!rows[index]) return;
			rows[index][String(input.dataset.field ?? "")] = clampPercentile(input.value);
			tables[careerClass] = rows;
			await this.document.update({ [`system.${tableName}`]: tables });
			return;
		}

		if (kind === "careerOverrides") {
			const overrides = cloneArray(this.document.system?.careerClassOverrides);
			if (!overrides[index]) return;
			const field = String(input.dataset.field ?? "");
			const value = String(input.value ?? "");

			if (field === "class" && overrides.some((entry, entryIndex) => entryIndex !== index && entry.class === value)) {
				warnAuthoring(
					"Each Career Class can have only one racial override. Edit the existing override instead.",
					"Każda Klasa Profesji może mieć tylko jeden wyjątek rasowy. Edytuj istniejący wyjątek zamiast tworzyć drugi.",
				);
				this.render({ force: true });
				return;
			}

			overrides[index][field] = value;
			await this.document.update({ "system.careerClassOverrides": overrides });
			return;
		}

		if (kind === "requirements") {
			const overrideIndex = integer(input.dataset.overrideIndex, -1);
			const requirementIndex = integer(input.dataset.requirementIndex, -1);
			const overrides = cloneArray(this.document.system?.careerClassOverrides);
			const requirement = overrides[overrideIndex]?.requirements?.[requirementIndex];
			if (!requirement) return;
			const field = String(input.dataset.field ?? "");
			const value = field === "value" ? integer(input.value, 0) : String(input.value ?? "");

			if (field === "characteristic" && overrides[overrideIndex].requirements.some((entry, entryIndex) => entryIndex !== requirementIndex && entry.characteristic === value)) {
				warnAuthoring(
					"The same Characteristic cannot appear twice in one Career Class override.",
					"Ta sama Cecha nie może występować dwa razy w jednym wyjątku Klasy Profesji.",
				);
				this.render({ force: true });
				return;
			}

			requirement[field] = value;
			await this.document.update({ "system.careerClassOverrides": overrides });
		}
	}

	async #dropMandatorySkill(ruleIndex, document) {
		const rules = cloneArray(this.document.system?.mandatorySkills);
		const grant = skillReference(document);

		if (ruleIndex !== null && ruleIndex >= 0 && rules[ruleIndex]) {
			const rule = rules[ruleIndex];
			rule.choices ??= [];
			if (rule.choices.some((choice) => choice.grants?.some((candidate) => sameReference(candidate, grant)))) return;
			rule.choices.push({
				id: foundry.utils.randomID(),
				label: grantDisplayName(grant),
				grants: [grant],
			});
			if (rule.choices.length > 1 && rule.mode === RACE_INITIAL_SKILL_MODE.ALL) {
				rule.mode = RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE;
			}
		} else {
			rules.push({
				id: foundry.utils.randomID(),
				minInitialSkills: 1,
				mode: RACE_INITIAL_SKILL_MODE.ALL,
				choose: 1,
				choices: [{ id: foundry.utils.randomID(), label: grantDisplayName(grant), grants: [grant] }],
			});
		}
		await this.document.update({ "system.mandatorySkills": rules });
	}

	async #dropTableDocument(tableName, target, document) {
		const careerClass = String(target.dataset.careerClass ?? "");
		if (!RACE_CAREER_CLASSES.includes(careerClass)) return;
		const tables = foundry.utils.deepClone(this.document.system?.[tableName]?.toObject?.() ?? this.document.system?.[tableName] ?? {});
		const rows = cloneArray(tables[careerClass]);
		const start = Math.min(100, Math.max(1, rows.reduce((max, row) => Math.max(max, integer(row?.max, 0)), 0) + 1));
		rows.push(tableName === "skillTables"
			? { min: start, max: start, grant: skillReference(document) }
			: { min: start, max: start, career: documentReference(document) });
		tables[careerClass] = rows;
		await this.document.update({ [`system.${tableName}`]: tables });
	}

	static async #addLanguage() {
		const entries = cloneArray(this.document.system?.languages);
		entries.push({ rulesId: "", name: "" });
		await this.document.update({ "system.languages": entries });
	}

	static async #deleteLanguage(_event, target) {
		await deleteIndexed(this.document, "languages", target?.dataset?.index);
	}

	static async #addPsychology() {
		const entries = cloneArray(this.document.system?.psychology);
		entries.push({ rulesId: "", name: "", description: "" });
		await this.document.update({ "system.psychology": entries });
	}

	static async #deletePsychology(_event, target) {
		await deleteIndexed(this.document, "psychology", target?.dataset?.index);
	}

	static async #addAgeBand() {
		const entries = cloneArray(this.document.system?.age?.skillCountModifiers);
		const start = entries.length ? Math.max(...entries.map((entry) => integer(entry.maxAge, 15))) + 1 : 16;
		entries.push({ minAge: start, maxAge: start + 9, modifier: 0 });
		await this.document.update({ "system.age.skillCountModifiers": entries });
	}

	static async #deleteAgeBand(_event, target) {
		const entries = cloneArray(this.document.system?.age?.skillCountModifiers);
		removeAt(entries, target?.dataset?.index);
		await this.document.update({ "system.age.skillCountModifiers": entries });
	}

	static async #deleteMandatoryRule(_event, target) {
		await deleteIndexed(this.document, "mandatorySkills", target?.dataset?.index);
	}

	static async #deleteMandatoryChoice(_event, target) {
		const ruleIndex = integer(target?.dataset?.ruleIndex, -1);
		const choiceIndex = integer(target?.dataset?.choiceIndex, -1);
		const rules = cloneArray(this.document.system?.mandatorySkills);
		if (!rules[ruleIndex]?.choices?.[choiceIndex]) return;
		rules[ruleIndex].choices.splice(choiceIndex, 1);
		if (!rules[ruleIndex].choices.length) rules.splice(ruleIndex, 1);
		else if (rules[ruleIndex].choices.length === 1) rules[ruleIndex].mode = RACE_INITIAL_SKILL_MODE.ALL;
		await this.document.update({ "system.mandatorySkills": rules });
	}

	static async #deleteTableRow(_event, target) {
		const tableName = String(target?.dataset?.table ?? "");
		const careerClass = String(target?.dataset?.careerClass ?? "");
		const index = integer(target?.dataset?.index, -1);
		if (!["skillTables", "basicCareerTables"].includes(tableName) || !RACE_CAREER_CLASSES.includes(careerClass) || index < 0) return;
		const tables = foundry.utils.deepClone(this.document.system?.[tableName]?.toObject?.() ?? this.document.system?.[tableName] ?? {});
		const rows = cloneArray(tables[careerClass]);
		rows.splice(index, 1);
		tables[careerClass] = rows;
		await this.document.update({ [`system.${tableName}`]: tables });
	}

	static async #addCareerOverride() {
		const overrides = cloneArray(this.document.system?.careerClassOverrides);
		const unused = RACE_CAREER_CLASSES.find((careerClass) => !overrides.some((entry) => entry.class === careerClass));
		if (!unused) {
			warnAuthoring(
				"All four Career Classes already have racial overrides.",
				"Wszystkie cztery Klasy Profesji mają już wyjątki rasowe.",
			);
			return;
		}
		overrides.push({ class: unused, mode: RACE_CAREER_OVERRIDE_MODE.REPLACE_REQUIREMENTS, requirements: [] });
		await this.document.update({ "system.careerClassOverrides": overrides });
	}

	static async #deleteCareerOverride(_event, target) {
		await deleteIndexed(this.document, "careerClassOverrides", target?.dataset?.index);
	}

	static async #addRequirement(_event, target) {
		const index = integer(target?.dataset?.index, -1);
		const overrides = cloneArray(this.document.system?.careerClassOverrides);
		if (!overrides[index]) return;
		overrides[index].requirements ??= [];
		const unused = RACE_CHARACTERISTIC_IDS.find((characteristic) =>
			!overrides[index].requirements.some((entry) => entry.characteristic === characteristic),
		);
		if (!unused) {
			warnAuthoring(
				"Every Characteristic is already used in this Career Class override.",
				"Każda Cecha jest już użyta w tym wyjątku Klasy Profesji.",
			);
			return;
		}
		overrides[index].requirements.push({ characteristic: unused, operator: "gte", value: 30 });
		await this.document.update({ "system.careerClassOverrides": overrides });
	}

	static async #deleteRequirement(_event, target) {
		const overrideIndex = integer(target?.dataset?.overrideIndex, -1);
		const requirementIndex = integer(target?.dataset?.requirementIndex, -1);
		const overrides = cloneArray(this.document.system?.careerClassOverrides);
		if (!overrides[overrideIndex]?.requirements?.[requirementIndex]) return;
		overrides[overrideIndex].requirements.splice(requirementIndex, 1);
		await this.document.update({ "system.careerClassOverrides": overrides });
	}
}

function presentLanguages(source) {
	return cloneArray(source).map((entry, index) => ({ ...entry, index }));
}

function presentPsychology(source) {
	return cloneArray(source).map((entry, index) => ({ ...entry, index }));
}

function presentAgeBands(source) {
	return cloneArray(source).map((entry, index) => ({ ...entry, index }));
}

function presentMandatorySkills(source) {
	return cloneArray(source).map((rule, index) => ({
		...rule,
		index,
		modeOptions: [
			{ value: RACE_INITIAL_SKILL_MODE.ALL, label: localize("All listed", "Wszystkie wymienione"), selected: rule.mode === RACE_INITIAL_SKILL_MODE.ALL },
			{ value: RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE, label: localize("Random choice", "Losowy wybór"), selected: rule.mode === RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE },
		],
		choices: cloneArray(rule.choices).map((choice, choiceIndex) => ({
			...choice,
			choiceIndex,
			display: cloneArray(choice.grants).map(grantDisplayName).join(" + ") || choice.label || "—",
		})),
	}));
}

function presentCareerOverrides(source) {
	return cloneArray(source).map((entry, index) => ({
		...entry,
		index,
		classOptions: RACE_CAREER_CLASSES.map((careerClass) => ({ value: careerClass, label: careerClassLabel(careerClass), selected: entry.class === careerClass })),
		modeOptions: [
			{ value: RACE_CAREER_OVERRIDE_MODE.REPLACE_REQUIREMENTS, label: localize("Replace requirements", "Zastąp wymagania"), selected: entry.mode === RACE_CAREER_OVERRIDE_MODE.REPLACE_REQUIREMENTS },
			{ value: RACE_CAREER_OVERRIDE_MODE.FORBID, label: localize("Forbidden", "Niedostępna"), selected: entry.mode === RACE_CAREER_OVERRIDE_MODE.FORBID },
		],
		requirements: cloneArray(entry.requirements).map((requirement, requirementIndex) => ({
			...requirement,
			requirementIndex,
			characteristicOptions: RACE_CHARACTERISTIC_IDS.map((id) => ({ value: id, label: characteristicLabel(id), selected: requirement.characteristic === id })),
		})),
	}));
}

function presentTableRows(source, table, careerClass) {
	return cloneArray(source).map((row, index) => ({
		...row,
		index,
		table,
		careerClass,
		display: table === "skillTables" ? grantDisplayName(row.grant) : referenceDisplayName(row.career),
	}));
}

export function validatePercentileTable(source) {
	const rows = cloneArray(source).map((row, index) => ({
		index,
		min: clampPercentile(row?.min),
		max: clampPercentile(row?.max),
	}));
	const occupied = Array(101).fill(0);
	const invalidRanges = [];
	for (const row of rows) {
		if (row.min > row.max) {
			invalidRanges.push(`${row.min}-${row.max}`);
			continue;
		}
		for (let value = row.min; value <= row.max; value += 1) occupied[value] += 1;
	}
	const gaps = [];
	const overlaps = [];
	collectRanges(occupied, 0, gaps);
	collectRanges(occupied, 2, overlaps, true);
	const complete = rows.length > 0 && !gaps.length && !overlaps.length && !invalidRanges.length;
	return {
		complete,
		statusClass: complete ? "is-valid" : "is-invalid",
		label: complete
			? localize("Complete 01-100", "Pełne 01-100")
			: [
				gaps.length ? `${localize("gaps", "luki")}: ${gaps.join(", ")}` : "",
				overlaps.length ? `${localize("overlaps", "nakładanie")}: ${overlaps.join(", ")}` : "",
				invalidRanges.length ? `${localize("invalid", "błędne")}: ${invalidRanges.join(", ")}` : "",
			].filter(Boolean).join("; ") || localize("Empty", "Pusta"),
	};
}

function collectRanges(occupied, exact, output, greaterOrEqual = false) {
	let start = null;
	for (let value = 1; value <= 101; value += 1) {
		const match = value <= 100 && (greaterOrEqual ? occupied[value] >= exact : occupied[value] === exact);
		if (match && start === null) start = value;
		if (!match && start !== null) {
			const end = value - 1;
			output.push(start === end ? twoDigits(start) : `${twoDigits(start)}-${twoDigits(end)}`);
			start = null;
		}
	}
}

function skillReference(document) {
	return { uuid: String(document.uuid ?? ""), rulesId: String(document.system?.rulesId ?? ""), name: String(document.name ?? ""), specialisation: String(document.system?.specialisation ?? "") };
}

function documentReference(document) {
	return { uuid: String(document.uuid ?? ""), rulesId: String(document.system?.rulesId ?? ""), name: String(document.name ?? "") };
}

function sameReference(a, b) {
	const aRules = String(a?.rulesId ?? "");
	const bRules = String(b?.rulesId ?? "");
	if (aRules && bRules) return aRules === bRules && String(a?.specialisation ?? "") === String(b?.specialisation ?? "");
	return String(a?.uuid ?? "") && String(a?.uuid ?? "") === String(b?.uuid ?? "");
}

function grantDisplayName(grant) {
	const name = referenceDisplayName(grant);
	const specialisation = String(grant?.specialisation ?? "").trim();
	return specialisation ? `${name} (${specialisation})` : name;
}

function referenceDisplayName(reference) {
	return String(reference?.name ?? reference?.rulesId ?? "").trim() || "—";
}

async function deleteIndexed(document, path, rawIndex) {
	const entries = cloneArray(foundry.utils.getProperty(document.system, path));
	removeAt(entries, rawIndex);
	await document.update({ [`system.${path}`]: entries });
}

function removeAt(entries, rawIndex) {
	const index = integer(rawIndex, -1);
	if (index >= 0 && index < entries.length) entries.splice(index, 1);
}

function sourceObject(document) {
	return document.system?.toObject?.() ?? foundry.utils.deepClone(document.system ?? {});
}

function cloneArray(value) {
	return Array.isArray(value) ? foundry.utils.deepClone(value) : [];
}

function inputValue(input) {
	if (input.type === "number") return integer(input.value, 0);
	return String(input.value ?? "");
}

function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function clampPercentile(value) {
	return Math.min(100, Math.max(1, integer(value, 1)));
}

function twoDigits(value) {
	return String(value).padStart(2, "0");
}

function characteristicLabel(id) {
	const pair = CHARACTERISTIC_LABELS[id] ?? [id, id];
	return game.i18n.lang === "pl" ? pair[0] : pair[1];
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

function warnDrop(englishType, polishType) {
	ui.notifications.warn(localize(`Drop a ${englishType} Item here.`, `Upuść tutaj Przedmiot typu ${polishType}.`));
	return null;
}

function warnAuthoring(english, polish) {
	ui.notifications.warn(localize(english, polish));
}

function reportAuthoringError(error) {
	console.error("WFRP1ED | Race authoring update failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function labels() {
	return {
		name: localize("Name", "Nazwa"), rulesId: localize("Rules ID", "Identyfikator reguły"),
		rulesIdHint: localize("Stable language-neutral rule identity.", "Stała, niezależna od języka tożsamość reguły."),
		description: localize("Description", "Opis"),
		profile: localize("Starting profile formulas", "Charakterystyki początkowe (formuły)"),
		profileHint: localize("These formulas are rolled once during character creation. They are not permanent racial modifiers.", "Te formuły są rzucane jeden raz podczas tworzenia postaci. Nie są stałymi modyfikatorami rasowymi."),
		racialProperties: localize("Racial properties", "Właściwości rasy"), nightVision: localize("Night Vision", "Widzenie w ciemnościach"), startingAlignment: localize("Starting alignment", "Początkowy charakter"),
		height: localize("Height generation", "Losowanie wzrostu"), maleFormula: localize("Male formula", "Formuła mężczyzny"), femaleFormula: localize("Female formula", "Formuła kobiety"), unit: localize("Unit", "Jednostka"),
		age: localize("Age generation", "Losowanie wieku"), youngFormula: localize("Young", "Młody"), matureFormula: localize("Mature", "Dojrzały"), minimumAge: localize("Minimum age", "Minimalny wiek"), rerollBelowMinimum: localize("If below minimum, roll again and add", "Jeśli poniżej minimum, rzuć ponownie i dodaj"),
		fate: localize("Initial Fate", "Początkowe Punkty Przeznaczenia"), fateFormula: localize("Formula", "Formuła"), fateMinimum: localize("Minimum", "Minimum"),
		languages: localize("Languages", "Języki"), psychology: localize("Psychology", "Psychologia"), ageBands: localize("Age → initial Skill modifier", "Wiek → modyfikator początkowych Umiejętności"), mandatorySkills: localize("Mandatory racial Skills", "Obowiązkowe Umiejętności rasowe"), careerOverrides: localize("Career Class overrides", "Wyjątki Klas Profesji"),
		add: localize("Add", "Dodaj"), delete: localize("Delete", "Usuń"), rulesIdentity: localize("Rules ID", "ID reguły"), displayName: localize("Name", "Nazwa"), psychologyDescription: localize("Description", "Opis"), minAge: localize("From", "Od"), maxAge: localize("To", "Do"), modifier: localize("Modifier", "Modyfikator"), minInitialSkills: localize("Applies from Skill count", "Od liczby Umiejętności"), mode: localize("Mode", "Tryb"), choose: localize("Choose", "Wybierz"),
		dropMandatory: localize("Drop a Skill anywhere in this section to create a new rule. To add it as an alternative to an existing choice group, drop it directly onto the name/badge of one of the Skills already in that group.", "Upuść Umiejętność w dowolnym miejscu tej sekcji, aby utworzyć nową regułę. Aby dodać ją jako alternatywę do istniejącej grupy wyboru, upuść ją bezpośrednio na nazwę/znacznik jednej z Umiejętności już należących do tej grupy."),
		skillTables: localize("Initial Skill D100 tables", "Tabele K100 początkowych Umiejętności"), careerTables: localize("Basic Career D100 tables", "Tabele K100 Profesji Podstawowych"),
		dropSkillTable: localize("Drop Skills here. Edit the D100 ranges directly; the validator checks 01-100 coverage.", "Upuszczaj tutaj Umiejętności. Zakresy K100 edytuj bezpośrednio; walidator sprawdza pokrycie 01-100."),
		dropCareerTable: localize("Drop Careers here. Edit the D100 ranges directly; the validator checks 01-100 coverage.", "Upuszczaj tutaj Profesje. Zakresy K100 edytuj bezpośrednio; walidator sprawdza pokrycie 01-100."),
		range: localize("D100", "K100"), result: localize("Result", "Wynik"), validation: localize("Validation", "Walidacja"), careerClass: localize("Career Class", "Klasa Profesji"), overrideMode: localize("Override", "Wyjątek"), requirements: localize("Requirements", "Wymagania"), characteristic: localize("Characteristic", "Cecha"), operator: localize("Operator", "Operator"), value: localize("Value", "Wartość"), addRequirement: localize("Add requirement", "Dodaj wymaganie"),
	};
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
