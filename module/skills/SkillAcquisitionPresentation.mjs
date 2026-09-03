/**
 * Register presentation-only helpers for repeated Skill acquisitions.
 *
 * The helpers read persistent Actor-owned Skill data but perform no mechanical
 * calculation or mutation. They keep the Classic-sheet label compact while
 * remaining compatible with development worlds which still contain legacy
 * duplicate Pick Lock/Pick Pocket Items.
 */
export function registerSkillAcquisitionPresentation() {
	Hooks.once("init", () => {
		Handlebars.registerHelper(
			"wfrp1edSkillAcquisitionVisible",
			(actorId, itemId) => isVisibleSkillRow(actorId, itemId),
		);

		Handlebars.registerHelper(
			"wfrp1edSkillAcquisitionDisplayName",
			(actorId, itemId, fallbackName) =>
				skillAcquisitionDisplayName(actorId, itemId, fallbackName),
		);
	});
}

function isVisibleSkillRow(actorId, itemId) {
	const { item, matches } = stackingMatches(actorId, itemId);
	if (!item || matches.length === 0) return true;
	return String(matches[0]?.id ?? "") === String(item.id ?? "");
}

function skillAcquisitionDisplayName(actorId, itemId, fallbackName) {
	const label = String(fallbackName ?? "");
	const { matches } = stackingMatches(actorId, itemId);
	if (matches.length === 0) return label;

	const acquisitions = matches.reduce(
		(total, item) => total + normalizeAcquisitions(item.system?.acquisitions),
		0,
	);

	return acquisitions > 1 ? `${label} (${acquisitions})` : label;
}

function stackingMatches(actorId, itemId) {
	const actor = game.actors?.get?.(String(actorId ?? ""));
	const item = actor?.items?.get?.(String(itemId ?? ""));
	if (!item || item.type !== "skill") return { item: null, matches: [] };

	const skillId = normalizeText(item.system?.skillId);
	if (!STACKING_SKILL_IDS.has(skillId)) return { item, matches: [] };

	const specialisation = normalizeText(item.system?.specialisation);
	const matches = [...(actor.items ?? [])].filter((candidate) =>
		candidate.type === "skill" &&
		normalizeText(candidate.system?.skillId) === skillId &&
		normalizeText(candidate.system?.specialisation) === specialisation
	);

	return { item, matches };
}

const STACKING_SKILL_IDS = new Set(["picklock", "pickpocket"]);

function normalizeAcquisitions(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 1;
	return Math.max(1, Math.trunc(number));
}

function normalizeText(value) {
	return String(value ?? "")
		.normalize("NFKC")
		.trim()
		.toLowerCase();
}
