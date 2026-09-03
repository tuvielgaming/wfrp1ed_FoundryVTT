import {
	isStackingRepeatableSkill,
	normalizeSkillAcquisitions,
} from "./SkillAcquisitionPolicy.mjs";

/**
 * Register presentation-only helpers for repeated Skill acquisitions.
 *
 * The helpers read persistent Actor-owned Skill data but perform no mechanical
 * calculation or mutation. They keep the Classic-sheet label compact while
 * remaining compatible with development worlds which still contain legacy
 * duplicate Pick Lock/Pick Pocket Items.
 *
 * The Actor is resolved by UUID rather than world-collection id. This is
 * required for unlinked Tokens because their synthetic Actors are not members
 * of `game.actors`, while Foundry v14 UUID resolution can resolve them through
 * their Scene -> Token -> Actor document path.
 */
export function registerSkillAcquisitionPresentation() {
	Hooks.once("init", () => {
		Handlebars.registerHelper(
			"wfrp1edSkillAcquisitionVisible",
			(actorUuid, itemId) => isVisibleSkillRow(actorUuid, itemId),
		);

		Handlebars.registerHelper(
			"wfrp1edSkillAcquisitionDisplayName",
			(actorUuid, itemId, fallbackName) =>
				skillAcquisitionDisplayName(actorUuid, itemId, fallbackName),
		);
	});
}

function isVisibleSkillRow(actorUuid, itemId) {
	const { item, matches } = stackingMatches(actorUuid, itemId);
	if (!item || matches.length === 0) return true;
	return String(matches[0]?.id ?? "") === String(item.id ?? "");
}

function skillAcquisitionDisplayName(actorUuid, itemId, fallbackName) {
	const label = String(fallbackName ?? "");
	const { matches } = stackingMatches(actorUuid, itemId);
	if (matches.length === 0) return label;

	const acquisitions = matches.reduce(
		(total, item) => total + normalizeSkillAcquisitions(item.system?.acquisitions),
		0,
	);

	return acquisitions > 1 ? `${label} (${acquisitions})` : label;
}

function stackingMatches(actorUuid, itemId) {
	const actor = actorFromUuid(actorUuid);
	const item = actor?.items?.get?.(String(itemId ?? ""));
	if (!item || item.type !== "skill") return { item: null, matches: [] };

	const skillId = String(item.system?.skillId ?? "").trim();
	if (!isStackingRepeatableSkill(skillId)) return { item, matches: [] };

	const normalizedSkillId = normalizeText(skillId);
	const specialisation = normalizeText(item.system?.specialisation);
	const matches = [...(actor.items ?? [])].filter((candidate) =>
		candidate.type === "skill" &&
		normalizeText(candidate.system?.skillId) === normalizedSkillId &&
		normalizeText(candidate.system?.specialisation) === specialisation
	);

	return { item, matches };
}

function actorFromUuid(value) {
	const uuid = String(value ?? "").trim();
	if (!uuid) return null;

	const document = foundry.utils.fromUuidSync(uuid);
	return document?.documentName === "Actor" ? document : null;
}

function normalizeText(value) {
	return String(value ?? "")
		.normalize("NFKC")
		.trim()
		.toLowerCase();
}
