/*
 * Stable identities for audited WFRP 1e core Skills which participate in
 * implemented system mechanics.
 *
 * This file historically began with Standard Test skills only, which is why
 * its filename is retained for compatibility. `luck` and `dodgeBlow` are now
 * also included because dedicated rule subsystems need stable Skill identities.
 * StandardTestSkillResolver still consumes only rulesIds which have entries in
 * standard-test-skill-rules.mjs, so adding these identities does not make them
 * generic Standard Test modifiers.
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
	dodgeBlow: localizedIdentity("Dodge Blow", "Uniki"),
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
	luck: localizedIdentity("Luck", "Szczęście"),
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

export function getStandardTestSkillIdentity(rulesId) {
	const id = String(rulesId ?? "").trim();
	return STANDARD_TEST_SKILL_IDENTITIES[id] ?? null;
}

function identity(englishLabel) {
	return {
		label: englishLabel,
		labelKey: `WFRP1ED.Skill.${skillKey(englishLabel)}`,
	};
}

function localizedIdentity(englishLabel, polishLabel) {
	return {
		get label() {
			return globalThis.game?.i18n?.lang === "pl" ? polishLabel : englishLabel;
		},
		labelKey: `WFRP1ED.Skill.${skillKey(englishLabel)}`,
	};
}

function skillKey(label) {
	return String(label)
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
