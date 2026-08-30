export const CHARACTER_GENDER = Object.freeze({
	MALE: "male",
	FEMALE: "female",
});

export const CAREER_CLASS = Object.freeze({
	WARRIOR: "warrior",
	RANGER: "ranger",
	ROGUE: "rogue",
	ACADEMIC: "academic",
});

const GENDER_ALIASES = Object.freeze({
	male: CHARACTER_GENDER.MALE,
	m: CHARACTER_GENDER.MALE,
	man: CHARACTER_GENDER.MALE,
	"mężczyzna": CHARACTER_GENDER.MALE,
	mezczyzna: CHARACTER_GENDER.MALE,
	female: CHARACTER_GENDER.FEMALE,
	f: CHARACTER_GENDER.FEMALE,
	woman: CHARACTER_GENDER.FEMALE,
	kobieta: CHARACTER_GENDER.FEMALE,
	k: CHARACTER_GENDER.FEMALE,
});

const CAREER_CLASS_ALIASES = Object.freeze({
	warrior: CAREER_CLASS.WARRIOR,
	wojownik: CAREER_CLASS.WARRIOR,
	ranger: CAREER_CLASS.RANGER,
	"wędrowiec": CAREER_CLASS.RANGER,
	wedrowiec: CAREER_CLASS.RANGER,
	rogue: CAREER_CLASS.ROGUE,
	"łotr": CAREER_CLASS.ROGUE,
	lotr: CAREER_CLASS.ROGUE,
	"łotrzyk": CAREER_CLASS.ROGUE,
	lotrzyk: CAREER_CLASS.ROGUE,
	academic: CAREER_CLASS.ACADEMIC,
	uczony: CAREER_CLASS.ACADEMIC,
});

/**
 * Canonicalize a Character Gender value. New Character Creation writes only
 * the language-neutral ids, while legacy/localized aliases remain readable.
 */
export function canonicalGender(value) {
	return GENDER_ALIASES[normalize(value)] ?? "";
}

export function genderShortLabel(value) {
	const canonical = canonicalGender(value);
	if (canonical === CHARACTER_GENDER.MALE) return "M";
	if (canonical === CHARACTER_GENDER.FEMALE) return game.i18n.lang === "pl" ? "K" : "F";
	return "—";
}

export function genderFullLabel(value) {
	const canonical = canonicalGender(value);
	if (canonical === CHARACTER_GENDER.MALE) return localize("Male", "Mężczyzna");
	if (canonical === CHARACTER_GENDER.FEMALE) return localize("Female", "Kobieta");
	return localize("Not selected", "Nie wybrano");
}

/** Canonical Career Class id used by rules and persisted Actor data. */
export function canonicalCareerClass(value) {
	return CAREER_CLASS_ALIASES[normalize(value)] ?? "";
}

export function careerClassLabel(value) {
	const canonical = canonicalCareerClass(value);
	const labels = {
		[CAREER_CLASS.WARRIOR]: ["Warrior", "Wojownik"],
		[CAREER_CLASS.RANGER]: ["Ranger", "Wędrowiec"],
		[CAREER_CLASS.ROGUE]: ["Rogue", "Łotrzyk"],
		[CAREER_CLASS.ACADEMIC]: ["Academic", "Uczony"],
	};
	const pair = labels[canonical];
	return pair ? (game.i18n.lang === "pl" ? pair[1] : pair[0]) : String(value ?? "");
}

/**
 * Present a canonical creation-owned value outside Character Creation Mode.
 *
 * The presentation input intentionally has no `name`: localized labels such as
 * `M`, `K` or `Wojownik` must never be included in Actor form submission and
 * replace the canonical `male`, `female`, `warrior`, ... rules values.
 *
 * Future Character Creation enumerations should use this helper instead of
 * directly rewriting the value of a named form control.
 */
export function applyCreationValuePresentation(field, {
	inputName,
	displayValue,
	fullLabel = displayValue,
}) {
	if (!(field instanceof HTMLElement)) return null;

	let input = field.querySelector("input[data-wfrp1ed-creation-value-presentation]");
	if (!(input instanceof HTMLInputElement)) {
		input = field.querySelector(`input[name="${cssEscape(inputName)}"]`)
			?? field.querySelector("input");
		if (!(input instanceof HTMLInputElement)) return null;
		input.removeAttribute("name");
		input.readOnly = true;
		input.tabIndex = -1;
		input.dataset.wfrp1edCreationValuePresentation = "true";
	}

	input.value = String(displayValue ?? "");
	input.title = String(fullLabel ?? displayValue ?? "");
	input.setAttribute("aria-label", String(fullLabel ?? displayValue ?? ""));
	return input;
}

function cssEscape(value) {
	return globalThis.CSS?.escape?.(String(value ?? "")) ?? String(value ?? "").replace(/["\\]/g, "\\$&");
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
