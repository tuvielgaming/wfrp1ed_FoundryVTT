/*
 * Stable identities for audited WFRP 1e core Skills which participate in
 * implemented system mechanics.
 *
 * This file historically began with Standard Test skills only, which is why
 * its filename is retained for compatibility. `luck` is now included because
 * the Skill Item sheet needs one stable rulesId for the dedicated Luck
 * subsystem. StandardTestSkillResolver still consumes only rulesIds which have
 * entries in standard-test-skill-rules.mjs, so adding Luck here does not make
 * it a Standard Test modifier.
 *
 * Mechanics authority:
 * - English Core Rulebook, Skills index and descriptions, printed pp. 45-58.
 * - English Core Rulebook, Standard Tests, printed pp. 66-72.
 *
 * Polish terminology authority:
 * - Polish Core Rulebook, Lista Umiejętności and descriptions, printed
 *   pp. 45-58.
 * - Polish Core Rulebook, Standardowe Testy, printed pp. 66-71.
 *
 * These ids are language-neutral mechanical identities. They are deliberately
 * independent from Item.name, which remains editable presentation/content.
 */

export const STANDARD_TEST_SKILL_IDENTITIES = deepFreeze({
	acrobatics: identity("Acrobatics"),
	acting: identity("Acting"),
	acuteHearing: identity("Acute Hearing"),
	ambidextrous: identity("Ambidextrous"),
	animalTraining: identity("Animal Training"),
	art: identity("Art"),
	boatBuilding: identity("Boat Building"),
	bribery: identity("Bribery"),
	carpentry: identity("Carpentry"),
	charm: identity("Charm"),
	clown: identity("Clown"),
	comedian: identity("Comedian"),
	concealmentRural: identity("Concealment Rural"),
	concealmentUrban: identity("Concealment Urban"),
	contortionist: identity("Contortionist"),
	dance: identity("Dance"),
	engineer: identity("Engineer"),
	escapology: identity("Escapology"),
	etiquette: identity("Etiquette"),
	evaluate: identity("Evaluate"),
	fireEating: identity("Fire Eating"),
	followTrail: identity("Follow Trail"),
	gamble: identity("Gamble"),
	haggle: identity("Haggle"),
	immunityToDisease: identity("Immunity to Disease"),
	immunityToPoison: identity("Immunity to Poison"),
	jester: identity("Jester"),
	juggle: identity("Juggle"),
	linguistics: identity("Linguistics"),
	luck: { label: "Luck / Szczęście", labelKey: "WFRP1ED.Skill.Luck" },
	mimic: identity("Mimic"),
	mining: identity("Mining"),
	musicianship: identity("Musicianship"),
	palmistry: identity("Palmistry"),
	pickLock: identity("Pick Lock"),
	pickPocket: identity("Pick Pocket"),
	publicSpeaking: identity("Public Speaking"),
	ride: identity("Ride"),
	seduction: identity("Seduction"),
	shadowing: identity("Shadowing"),
	silentMoveRural: identity("Silent Move Rural"),
	silentMoveUrban: identity("Silent Move Urban"),
	sing: identity("Sing"),
	smithing: identity("Smithing"),
	stoneworking: identity("Stoneworking"),
	storyTelling: identity("Story Telling"),
	strongman: identity("Strongman"),
	superNumerate: identity("Super Numerate"),
	swim: identity("Swim"),
	tailor: identity("Tailor"),
	torture: identity("Torture"),
	trickRiding: identity("Trick Riding"),
	wit: identity("Wit"),
});

/**
 * Return one audited identity by stable rules id.
 *
 * @param {string} rulesId
 * @returns {Object|null}
 */
export function getStandardTestSkillIdentity(rulesId) {
	const id = String(rulesId ?? "").trim();

	return STANDARD_TEST_SKILL_IDENTITIES[id] ?? null;
}

/**
 * Build one immutable identity descriptor.
 *
 * @param {string} englishLabel
 * @returns {Object}
 */
function identity(englishLabel) {
	return {
		label: englishLabel,
		labelKey: `WFRP1ED.Skill.${skillKey(englishLabel)}`,
	};
}

/**
 * Convert an audited English label into its localization-key suffix.
 *
 * This affects presentation keys only. The language-neutral rules id remains
 * the object key above and must never be derived from localized Item names.
 *
 * @param {string} label
 * @returns {string}
 */
function skillKey(label) {
	return String(label)
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((part) =>
			part.charAt(0).toUpperCase() + part.slice(1),
		)
		.join("");
}

function deepFreeze(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.isFrozen(value)
	) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return Object.freeze(value);
}