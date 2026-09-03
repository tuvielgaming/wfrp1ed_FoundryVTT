import {
	normalizeSkillAcquisitions,
} from "../skills/SkillAcquisitionBootstrap.mjs";
import {
	getStandardTestSkillRule,
} from "./standard-test-skill-rules.mjs";

/**
 * Resolve owned Skill Items which may affect one WFRP 1e Standard Test.
 *
 * This class deliberately does not decide whether a potentially relevant
 * skill applies in the current fictional situation. The core Standard Tests
 * rule explicitly leaves that decision to the GM. Instead, it groups owned
 * Skill Items by stable `system.skillId` and returns the audited effects which
 * the Standard Test dialog may present for adjudication.
 */
export class StandardTestSkillResolver {
	/**
	 * Find all owned, rules-linked Skill Items with effects for `testId`.
	 *
	 * Canonical repeatable Skills store their acquisition total on the owned
	 * Skill Item. Legacy development-world duplicates are still summed here so
	 * old Actors continue to produce the correct modifier until their duplicate
	 * rows are cleaned up.
	 *
	 * @param {Actor} actor
	 * @param {string} testId
	 * @returns {readonly Object[]}
	 */
	static candidates(actor, testId) {
		if (!actor?.items) {
			throw new Error(
				"Standard Test skill resolution requires an Actor with Items.",
			);
		}

		const requestedTestId = String(testId ?? "").trim();

		if (!requestedTestId) {
			throw new Error(
				"Standard Test skill resolution requires a test id.",
			);
		}

		const groups = new Map();

		for (const item of actor.items) {
			if (item.type !== "skill") {
				continue;
			}

			const rulesId = String(
				item.system?.skillId ?? "",
			).trim();

			if (!rulesId) {
				continue;
			}

			const rule = getStandardTestSkillRule(rulesId);

			if (!rule) {
				continue;
			}

			const effects = rule.effects.filter(
				(effect) =>
					effect.testId === requestedTestId ||
					effect.testId === "standardTests",
			);

			if (effects.length === 0) {
				continue;
			}

			let group = groups.get(rulesId);

			if (!group) {
				group = {
					rulesId,
					name: item.name,
					items: [],
					acquisitions: 0,
					effects,
				};

				groups.set(rulesId, group);
			}

			group.items.push(item);
			group.acquisitions += normalizeSkillAcquisitions(
				item.system?.acquisitions,
			);
		}

		const candidates = [...groups.values()].map((group) =>
			Object.freeze({
				rulesId: group.rulesId,
				name: group.name,
				acquisitions: group.acquisitions,
				itemIds: Object.freeze(
					group.items.map((item) => item.id),
				),
				effects: Object.freeze([...group.effects]),
			}),
		);

		return Object.freeze(candidates);
	}
}
