import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
} from "./RuleEffectRegistry.mjs";

const RULE_FLAG_SCOPE = "wfrp1ed";
const RULE_FLAG_KEY = "ruleChanges";
const DEFAULT_PROVIDER_PRIORITY = 50;

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
	static #candidateProviders = new Map();

	/**
	 * Register one read-only runtime candidate source.
	 *
	 * Providers are for rule choices derived from current game state rather than
	 * a persistent ActiveEffect. They return the same neutral candidate shape so
	 * existing roll selection and audit code remains the single consumer.
	 *
	 * @param {string} id
	 * @param {Function} provider
	 * @returns {string}
	 */
	static registerCandidateProvider(id, provider) {
		const normalizedId = String(id ?? "").trim();
		if (!normalizedId) {
			throw new Error("WFRP rule candidate provider requires an id.");
		}
		if (typeof provider !== "function") {
			throw new Error(
				`WFRP rule candidate provider '${normalizedId}' must be a function.`,
			);
		}
		if (this.#candidateProviders.has(normalizedId)) {
			throw new Error(
				`WFRP rule candidate provider '${normalizedId}' is already registered.`,
			);
		}

		this.#candidateProviders.set(normalizedId, provider);
		return normalizedId;
	}

	/** @returns {boolean} */
	static unregisterCandidateProvider(id) {
		return this.#candidateProviders.delete(String(id ?? "").trim());
	}

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
		const includeCandidateProviders =
			options.includeCandidateProviders !== false;
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

		if (includeCandidateProviders) {
			this.#collectProvidedCandidates({
				actor,
				targetId: requestedTarget,
				options,
				results,
			});
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

		const changes = ruleChanges(effect);

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

	static #collectProvidedCandidates({
		actor,
		targetId,
		options,
		results,
	}) {
		for (const [providerId, provider] of this.#candidateProviders.entries()) {
			const provided = provider({ actor, targetId, options });

			if (provided === undefined || provided === null) {
				continue;
			}

			if (!Array.isArray(provided)) {
				throw new Error(
					`WFRP rule candidate provider '${providerId}' must return an array.`,
				);
			}

			for (const rawCandidate of provided) {
				const candidate = normalizeProvidedCandidate(
					rawCandidate,
					providerId,
					actor,
					targetId,
				);

				if (candidate) {
					results.push(candidate);
				}
			}
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

function normalizeProvidedCandidate(raw, providerId, actor, targetId) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}

	const id = String(raw.id ?? "").trim();
	const candidateTarget = String(raw.targetId ?? targetId).trim();

	if (!id || candidateTarget !== targetId) {
		return null;
	}

	return {
		id,
		targetId,
		target: raw.target ?? null,
		operation: String(raw.operation ?? "").trim(),
		formula: String(raw.formula ?? "").trim(),
		applicability: String(raw.applicability ?? "contextual").trim(),
		side: String(raw.side ?? "self").trim(),
		stacking: String(raw.stacking ?? "once").trim(),
		condition: String(raw.condition ?? "").trim(),
		priority: Number.isFinite(Number(raw.priority))
			? Number(raw.priority)
			: DEFAULT_PROVIDER_PRIORITY,
		defaultSelected: raw.defaultSelected === true,
		actorUuid: raw.actorUuid ?? actor.uuid,
		effectUuid: raw.effectUuid ?? null,
		effectName: raw.effectName ?? providerId,
		itemUuid: raw.itemUuid ?? null,
		itemName: raw.itemName ?? null,
		itemType: raw.itemType ?? null,
	};
}

function ruleChanges(effect) {
	const flagged = effect?.getFlag?.(RULE_FLAG_SCOPE, RULE_FLAG_KEY);

	if (Array.isArray(flagged)) {
		return foundry.utils.deepClone(flagged);
	}

	const system = effect?.system?.toObject?.() ?? {};
	const changes = Array.isArray(system.changes)
		? system.changes
		: [];

	return foundry.utils.deepClone(
		changes.filter((change) => Boolean(decodeRuleEffectChange(change))),
	);
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
