const NORMALIZE_GUARD = "wfrp1edCareerSkillIdentityNormalization";

install();

/**
 * Transitional Career Skill identity boundary.
 *
 * CareerData owns `grant.skillId`, matching SkillData and Race Skill
 * references. Older Career documents may still persist `grant.rulesId`, while
 * some authoring paths can still emit that legacy spelling during the staged
 * migration.
 *
 * This boundary makes persistence canonical without changing Career mechanics:
 *
 * - every Skill grant resolves identity as non-empty `skillId`, otherwise the
 *   legacy `rulesId`;
 * - every newly created or updated Career Skill grant persists that identity in
 *   `skillId`;
 * - the legacy `rulesId` property is removed from Skill grants in the outgoing
 *   Career update so new writes no longer extend the legacy data contract;
 * - Trapping grants and Career Exit `rulesId` values are untouched;
 * - untouched legacy Career documents remain readable through CareerData and
 *   the still-transitional readers until their dedicated reader migration.
 *
 * Full Career loads are normalized by CareerData.migrateData(). This hook is
 * needed for Foundry v14 differential updates, because CareerPartialMigrationFix
 * correctly bypasses broad legacy migration for partial writes.
 */
function install() {
	Hooks.on("preCreateItem", (item, data, options) => {
		if (item?.type !== "career") return;
		if (options?.[NORMALIZE_GUARD] === true) return;
		normalizeSourceSkills(data);
	});

	Hooks.on("preUpdateItem", (item, changes, options) => {
		if (item?.type !== "career") return;
		if (options?.[NORMALIZE_GUARD] === true) return;
		normalizeChangedSkills(changes);
	});
}

function normalizeSourceSkills(source) {
	if (!source || typeof source !== "object") return;
	const system = source.system;
	if (!system || typeof system !== "object") return;
	if (!Array.isArray(system.skills)) return;
	system.skills = normalizeSkillEntries(system.skills);
}

function normalizeChangedSkills(changes) {
	if (!changes || typeof changes !== "object") return;

	if (Object.hasOwn(changes, "system.skills")) {
		if (Array.isArray(changes["system.skills"])) {
			changes["system.skills"] = normalizeSkillEntries(changes["system.skills"]);
		}
		return;
	}

	const nested = foundry.utils.getProperty(changes, "system.skills");
	if (!Array.isArray(nested)) return;
	foundry.utils.setProperty(changes, "system.skills", normalizeSkillEntries(nested));
}

export function normalizeSkillEntries(source) {
	const entries = Array.isArray(source) ? foundry.utils.deepClone(source) : [];
	for (const entry of entries) {
		for (const choice of entry?.choices ?? []) {
			for (const grant of choice?.grants ?? []) {
				if (String(grant?.documentSubtype ?? "") !== "skill") continue;
				const skillId = String(grant?.skillId ?? "").trim() ||
					String(grant?.rulesId ?? "").trim();
				if (skillId) grant.skillId = skillId;
				delete grant.rulesId;
			}
		}
	}
	return entries;
}
