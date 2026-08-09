import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
} from "./RuleEffectRegistry.mjs";

/**
 * Discover declarative WFRP rule effects from an Actor and its owned Items.
 *
 * The resolver is deliberately Item-type agnostic. Skills are only the first
 * authoring surface; weapons, equipment, spells, traits, diseases and future
 * Item types can contribute the same rule language without consumer-specific
 * Item-name checks.
 *
 * This layer discovers candidate effects only. It does not decide whether a
 * contextual/manual effect applies in the current fictional situation and it
 * never mutates the underlying ActiveEffect Document for one-roll choices.
 */
export class RuleEffectResolver {
	/**
	 * Return all WFRP rule changes matching one stable target id.
	 *
	 * @param {Actor} actor
	 * @param {string} targetId
	 * @param {Object} options
	 * @returns {readonly Object[]}
	 */
	static candidates(actor, targetId, options = {}) {
		if (!actor) {
			throw new Error(
				"WFRP rule effect resolution requires an Actor.",
			);
		}

		const requestedTarget = String(targetId ?? "").trim();

		if (!requestedTarget) {
			throw new Error(
				"WFRP rule effect resolution requires a target id.",
			);
		}

		const includeActorEffects = options.includeActorEffects !== false;
		const includeItemEffects = options.includeItemEffects !== false;
		const results = [];

		if (includeActorEffects) {
			for (const effect of actor.effects ?? []) {
				this.#collectEffect({
					actor,
					effect,
					sourceItem: null,
					targetId: requestedTarget,
					results,
				});
			}
		}

		if (includeItemEffects) {
			for (const item of actor.items ?? []) {
				if (!this.#sourceItemAvailable(item, options)) {
					continue;
				}

				for (const effect of item.effects ?? []) {
					this.#collectEffect({
						actor,
						effect,
						sourceItem: item,
						targetId: requestedTarget,
						results,
					});
				}
			}
		}

		results.sort(compareCandidates);

		return Object.freeze(
			results.map((candidate) => Object.freeze(candidate)),
		);
	}

	/**
	 * Build a serializable per-roll selection snapshot from candidate effects.
	 *
	 * Missing selections use the safe defaults:
	 * - automatic effects are selected;
	 * - contextual/manual effects are not silently applied.
	 *
	 * @param {readonly Object[]} candidates
	 * @param {Object|Map<string, boolean>} selections
	 * @returns {readonly Object[]}
	 */
	static snapshot(candidates, selections = {}) {
		const result = [];

		for (const candidate of candidates ?? []) {
			const selected = readSelection(
				selections,
				candidate.id,
				candidate.applicability ===
					RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			);

			result.push(Object.freeze({
				id: candidate.id,
				selected,
				targetId: candidate.targetId,
				operation: candidate.operation,
				formula: candidate.formula,
				applicability: candidate.applicability,
				side: candidate.side,
				stacking: candidate.stacking,
				condition: candidate.condition,
				source: Object.freeze({
					effectUuid: candidate.effectUuid,
					effectName: candidate.effectName,
					itemUuid: candidate.itemUuid,
					itemName: candidate.itemName,
					itemType: candidate.itemType,
				}),
			}));
		}

		return Object.freeze(result);
	}

	static #collectEffect({
		actor,
		effect,
		sourceItem,
		targetId,
		results,
	}) {
		if (!effect || !this.#effectAvailable(effect)) {
			return;
		}

		/*
		 * Foundry v14 stores effect changes on the ActiveEffect type data model:
		 * `effect.system.changes`. The former top-level `effect.changes` path is
		 * legacy/shim territory and must not be used as the WFRP source of truth.
		 */
		const changes = Array.isArray(effect.system?.changes)
			? effect.system.changes
			: Array.from(effect.system?.changes ?? []);

		for (let index = 0; index < changes.length; index += 1) {
			const decoded = decodeRuleEffectChange(changes[index]);

			if (!decoded || decoded.targetId !== targetId) {
				continue;
			}

			results.push({
				id: effectCandidateId(effect, index, sourceItem),
				targetId: decoded.targetId,
				target: decoded.target,
				operation: decoded.operation,
				formula: decoded.formula,
				applicability: decoded.applicability,
				side: decoded.side,
				stacking: decoded.stacking,
				condition: decoded.condition,
				priority: decoded.priority,
				defaultSelected:
					decoded.applicability ===
					RULE_EFFECT_APPLICABILITY.AUTOMATIC,
				actorUuid: actor.uuid,
				effectUuid: effect.uuid,
				effectName: effect.name,
				itemUuid: sourceItem?.uuid ?? null,
				itemName: sourceItem?.name ?? null,
				itemType: sourceItem?.type ?? null,
			});
		}
	}

	/**
	 * Persistent ActiveEffect state gates discovery. Additional source-state
	 * semantics (equipped/worn/active spell/disease stage/etc.) belong to the
	 * source Item contract and can be supplied through `sourcePredicate` until
	 * those Item types gain audited native data models.
	 */
	static #effectAvailable(effect) {
		if (effect.disabled === true) {
			return false;
		}

		if (effect.active === false) {
			return false;
		}

		return true;
	}

	static #sourceItemAvailable(item, options) {
		if (!item) {
			return false;
		}

		if (typeof options.sourcePredicate === "function") {
			return options.sourcePredicate(item) !== false;
		}

		return true;
	}
}

function effectCandidateId(effect, index, item) {
	return [
		item?.uuid ?? "actor",
		effect.id ?? effect.uuid ?? "effect",
		index,
	].join("::");
}

function compareCandidates(first, second) {
	if (first.priority !== second.priority) {
		return first.priority - second.priority;
	}

	const sourceName = String(
		first.itemName ?? first.effectName ?? "",
	).localeCompare(
		String(second.itemName ?? second.effectName ?? ""),
		game.i18n.lang,
		{ sensitivity: "base" },
	);

	if (sourceName !== 0) {
		return sourceName;
	}

	return first.id.localeCompare(second.id);
}

function readSelection(selections, id, fallback) {
	if (selections instanceof Map) {
		return selections.has(id)
			? selections.get(id) === true
			: fallback;
	}

	if (
		selections &&
		typeof selections === "object" &&
		Object.hasOwn(selections, id)
	) {
		return selections[id] === true;
	}

	return fallback;
}
