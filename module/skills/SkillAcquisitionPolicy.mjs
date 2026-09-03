const POLICY_KIND = Object.freeze({
	STACKING: "stacking",
	QUALIFIED: "qualified",
});

/**
 * Audited WFRP 1e Core rules for Skills which may be acquired more than once.
 *
 * Pick Lock and Pick Pocket stack +10 for every acquisition after the first and
 * the Core rules state no maximum; Pick Lock explicitly illustrates +10, +20,
 * +30, etc. These are represented by one owned Skill Item with a persistent
 * acquisition count.
 *
 * Musicianship may be acquired a second or third time to extend the character's
 * competence across the three instrument fields (stringed, wind, percussion).
 * Divining may optionally be acquired a second time for another divination
 * form. Those acquisitions represent distinct qualifications, not repeated +10
 * stacking, so they remain separate specialised Skill Items.
 */
const CORE_REPEATABLE_SKILL_POLICIES = Object.freeze({
	picklock: Object.freeze({
		kind: POLICY_KIND.STACKING,
		maxAcquisitions: null,
	}),
	pickpocket: Object.freeze({
		kind: POLICY_KIND.STACKING,
		maxAcquisitions: null,
	}),
	musicianship: Object.freeze({
		kind: POLICY_KIND.QUALIFIED,
		maxAcquisitions: 3,
	}),
	divining: Object.freeze({
		kind: POLICY_KIND.QUALIFIED,
		maxAcquisitions: 2,
	}),
});

export const SKILL_ACQUISITION_POLICY_KIND = POLICY_KIND;

/**
 * Return the audited repeatable-acquisition policy for a canonical Skill id.
 * Non-repeatable or custom Skills return null.
 *
 * @param {string} skillId
 * @returns {{kind:string,maxAcquisitions:number|null}|null}
 */
export function skillAcquisitionPolicy(skillId) {
	return CORE_REPEATABLE_SKILL_POLICIES[normalizeSkillId(skillId)] ?? null;
}

/**
 * Whether repeated acquisitions of this Skill stack numerically on one owned
 * Skill record.
 *
 * @param {string} skillId
 * @returns {boolean}
 */
export function isStackingRepeatableSkill(skillId) {
	return skillAcquisitionPolicy(skillId)?.kind === POLICY_KIND.STACKING;
}

/**
 * Normalize persisted acquisition counts. Every owned Skill represents at
 * least one acquisition.
 *
 * @param {*} value
 * @returns {number}
 */
export function normalizeSkillAcquisitions(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 1;
	return Math.max(1, Math.trunc(number));
}

function normalizeSkillId(value) {
	return String(value ?? "")
		.normalize("NFKC")
		.trim()
		.toLowerCase();
}
