/**
 * Audited WFRP 1e Core specialisation suggestions for Skills whose Core
 * descriptions provide an explicit, finite list.
 *
 * Mechanical authority: English WFRP 1e Core Rulebook.
 * - Arcane Language: printed p. 47
 * - Secret Language: printed p. 55
 * - Specialist Weapon: printed pp. 56-57
 *
 * Polish labels: Polish Core Rulebook.
 * - Język tajemny: printed pp. 49-50
 * - Sekretny język: printed p. 53
 * - Specjalna broń: printed p. 54
 *
 * These values are authoring suggestions only. The Career editor must always
 * permit free-text specialisations, because WFRP 1e also contains qualified
 * Skills whose subject is player-, career-, or campaign-defined (for example
 * Divining and Secret Signs).
 *
 * Stable `id` values are language-neutral mechanical/content identities. Normal
 * Skill authoring still stores the user's displayed specialisation text, while
 * systems which need a language-neutral binding (for example Weapon ->
 * Specialist Weapon requirement) may store the stable id and resolve it back to
 * the localized Core label.
 */

const CORE_SKILL_SPECIALISATIONS = Object.freeze({
	arcaneLanguage: Object.freeze([
		option("magick", "Magick", "Magiczny"),
		option("oldSlann", "Old Slann", "Stary Slann"),
		option("arcaneDwarf", "Arcane Dwarf", "Tajemny krasnoludzki"),
		option("arcaneElf", "Arcane Elf", "Tajemny elfi"),
		option("druidic", "Druidic", "Druidyczny"),
		option("demonic", "Demonic", "Demoniczny"),
	]),
	secretLanguage: Object.freeze([
		option("battle", "Battle", "Bitewny"),
		option("ranger", "Ranger", "Rangerów"),
		option("thieves", "Thieves'", "Złodziei"),
		option("classical", "Classical", "Klasyczny"),
		option("guilder", "Guilder", "Gildii"),
	]),
	specialistWeapon: Object.freeze([
		option("polearm", "Polearm", "Drzewcowa"),
		option("doubleHanded", "Double-handed Weapons", "Dwuręczna"),
		option("flail", "Flail Weapons", "Korbacz"),
		option("fencingSword", "Fencing Sword", "Szermiercza"),
		option("parrying", "Parrying Weapons", "Parująca"),
		option("lance", "Lance", "Lanca"),
		option("net", "Net", "Sieć"),
		option("bomb", "Bomb", "Bomby"),
		option("incendiaries", "Incendiaries", "Zapalające"),
		option("lasso", "Lasso", "Lasso"),
		option("longbow", "Longbow", "Długi łuk"),
		option("repeatingCrossbow", "Repeating Crossbow", "Kusza samopowtarzalna"),
		option("crossbowPistol", "Crossbow Pistol", "Kusza pistoletowa"),
		option("throwing", "Throwing Weapons", "Rzucana"),
		option("sling", "Sling", "Proca"),
		option("blowpipe", "Blowpipe", "Dmuchawka"),
		option("artillery", "Artillery", "Artyleria"),
		option("firearms", "Firearms", "Palna"),
		option("fistWeapons", "Fist Weapons", "Uliczna"),
	]),
});

/** Return localized Core suggestions for a canonical Skill rulesId. */
export function coreSkillSpecialisationSuggestions(rulesId, language = "en") {
	return coreSkillSpecialisationOptions(rulesId, language).map((choice) => choice.label);
}

/**
 * Return stable-id + localized-label options for a canonical Skill rulesId.
 * @returns {{id:string,label:string,en:string,pl:string}[]}
 */
export function coreSkillSpecialisationOptions(rulesId, language = "en") {
	const choices = CORE_SKILL_SPECIALISATIONS[String(rulesId ?? "").trim()] ?? [];
	const polish = String(language ?? "").toLocaleLowerCase().startsWith("pl");
	return choices.map((choice) => Object.freeze({
		id: choice.id,
		label: polish ? choice.pl : choice.en,
		en: choice.en,
		pl: choice.pl,
	}));
}

/** Resolve a Core specialisation id or localized/English label to its stable id. */
export function coreSkillSpecialisationId(rulesId, value) {
	const normalized = normalize(value);
	if (!normalized) return "";
	const choices = CORE_SKILL_SPECIALISATIONS[String(rulesId ?? "").trim()] ?? [];
	const match = choices.find((choice) =>
		normalize(choice.id) === normalized ||
		normalize(choice.en) === normalized ||
		normalize(choice.pl) === normalized
	);
	return match?.id ?? "";
}

/** Resolve a stable Core specialisation id to the localized display label. */
export function coreSkillSpecialisationLabel(rulesId, id, language = "en") {
	const normalized = normalize(id);
	const choice = (CORE_SKILL_SPECIALISATIONS[String(rulesId ?? "").trim()] ?? [])
		.find((candidate) => normalize(candidate.id) === normalized);
	if (!choice) return "";
	return String(language ?? "").toLocaleLowerCase().startsWith("pl") ? choice.pl : choice.en;
}

function option(id, en, pl) {
	return Object.freeze({ id, en, pl });
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}
