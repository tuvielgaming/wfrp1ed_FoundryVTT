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
 */

const CORE_SKILL_SPECIALISATIONS = Object.freeze({
	arcaneLanguage: Object.freeze([
		option("Magick", "Magiczny"),
		option("Old Slann", "Stary Slann"),
		option("Arcane Dwarf", "Tajemny krasnoludzki"),
		option("Arcane Elf", "Tajemny elfi"),
		option("Druidic", "Druidyczny"),
		option("Demonic", "Demoniczny"),
	]),
	secretLanguage: Object.freeze([
		option("Battle", "Bitewny"),
		option("Ranger", "Rangerów"),
		option("Thieves'", "Złodziei"),
		option("Classical", "Klasyczny"),
		option("Guilder", "Gildii"),
	]),
	specialistWeapon: Object.freeze([
		option("Polearm", "Drzewcowa"),
		option("Double-handed Weapons", "Dwuręczna"),
		option("Flail Weapons", "Korbacz"),
		option("Fencing Sword", "Szermiercza"),
		option("Parrying Weapons", "Parująca"),
		option("Lance", "Lanca"),
		option("Net", "Sieć"),
		option("Bomb", "Bomby"),
		option("Incendiaries", "Zapalające"),
		option("Lasso", "Lasso"),
		option("Longbow", "Długi łuk"),
		option("Repeating Crossbow", "Kusza samopowtarzalna"),
		option("Crossbow Pistol", "Kusza pistoletowa"),
		option("Throwing Weapons", "Rzucana"),
		option("Sling", "Proca"),
		option("Blowpipe", "Dmuchawka"),
		option("Artillery", "Artyleria"),
		option("Firearms", "Palna"),
		option("Fist Weapons", "Uliczna"),
	]),
});

/**
 * Return localized Core suggestions for a canonical Skill rulesId.
 *
 * An empty array intentionally means that the Core does not define a finite
 * suggestion list for this Skill. It does not mean that the Skill cannot have
 * a specialisation.
 *
 * @param {string} rulesId Canonical Skill rulesId.
 * @param {string} language Foundry language code.
 * @returns {string[]}
 */
export function coreSkillSpecialisationSuggestions(rulesId, language = "en") {
	const choices = CORE_SKILL_SPECIALISATIONS[String(rulesId ?? "").trim()] ?? [];
	const polish = String(language ?? "").toLocaleLowerCase().startsWith("pl");
	return choices.map((choice) => polish ? choice.pl : choice.en);
}

function option(en, pl) {
	return Object.freeze({ en, pl });
}
