import {
	encodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const CRITICAL_WOUND_TYPE = "criticalWound";
const PROVIDER_ID = "wfrp1ed.core-critical-wound-persistence";
const repairingEffects = new Set();

/*
 * Foundry v14 may preserve an Item-embedded ActiveEffect document while dropping
 * custom data which existed only in its transient `system` object. The visible
 * wound/effect therefore survived a restart while the declarative WFRP rule
 * changes no longer reached RuleEffectResolver.
 *
 * System-managed Core wound consequences are persisted redundantly in the
 * stable `flags.wfrp1ed.ruleChanges` contract used by RuleEffectResolver. A
 * small candidate-provider fallback also covers Foundry instances which report
 * an Item-embedded transfer effect as inactive after reload even though the
 * effect itself is enabled.
 */
RuleEffectResolver.registerCandidateProvider(PROVIDER_ID, ({ actor, targetId }) =>
	fallbackCandidates(actor, targetId));

Hooks.on("createActiveEffect", (effect, _options, userId) => {
	if (String(userId ?? "") !== String(game.user?.id ?? "")) return;
	void persistManagedRuleChanges(effect).catch(reportPersistenceError);
});

Hooks.on("updateActiveEffect", (effect, _changes, _options, userId) => {
	if (String(userId ?? "") !== String(game.user?.id ?? "")) return;
	if (repairingEffects.has(String(effect?.uuid ?? ""))) return;
	void persistManagedRuleChanges(effect).catch(reportPersistenceError);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void repairExistingManagedEffects().catch(reportPersistenceError);
});

/*
 * Keep one tooltip implementation. The characteristic decorator deliberately
 * keeps the ordinary HTML `title` tooltip because it works on the rollable
 * characteristic control; remove Foundry's immediate black data-tooltip copy.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		!(actor instanceof foundry.documents.Actor) ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	requestAnimationFrame(() => {
		for (const node of element.querySelectorAll(
			".characteristics-row--current [data-characteristic], " +
			"[data-wfrp-characteristic-effect-marker]",
		)) {
			node.removeAttribute("data-tooltip");
		}
	});
});

async function repairExistingManagedEffects() {
	const touchedActors = new Set();

	for (const actor of game.actors ?? []) {
		for (const wound of actor.items ?? []) {
			if (wound?.type !== CRITICAL_WOUND_TYPE) continue;
			for (const effect of wound.effects ?? []) {
				if (await persistManagedRuleChanges(effect)) {
					touchedActors.add(actor);
				}
			}
		}
	}

	for (const actor of touchedActors) {
		void actor.sheet?.render?.({ force: true });
	}
}

async function persistManagedRuleChanges(effect) {
	const desired = desiredRuleChanges(effect);
	if (!desired) return false;

	const current = effect.getFlag?.(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY);
	if (sameJson(current, desired)) return false;

	const key = String(effect.uuid ?? "");
	repairingEffects.add(key);
	try {
		await effect.setFlag(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY, desired);
	} finally {
		repairingEffects.delete(key);
	}
	return true;
}

function desiredRuleChanges(effect) {
	const wound = effect?.parent;
	if (wound?.type !== CRITICAL_WOUND_TYPE) return null;

	const metadata = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
	const location = String(metadata?.location ?? "");
	const effectNumber = Number(metadata?.effectNumber);
	if (
		location !== "leg" ||
		!new Set([5, 6, 7]).has(effectNumber)
	) {
		return null;
	}

	return ["m", "i"].map((characteristicId) =>
		encodeRuleEffectChange({
			targetId: `characteristic.${characteristicId}.current`,
			operation: RULE_EFFECT_OPERATIONS.MULTIPLY,
			formula: "0.5",
			applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
			side: RULE_EFFECT_SIDES.SELF,
			stacking: "per-acquisition",
			condition: localize(
				"Until medical attention is received",
				"Do czasu otrzymania pomocy medycznej",
			),
		}),
	);
}

function fallbackCandidates(actor, targetId) {
	if (!(actor instanceof foundry.documents.Actor)) return [];
	if (!new Set([
		"characteristic.m.current",
		"characteristic.i.current",
	]).has(String(targetId ?? ""))) return [];

	const candidates = [];
	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;
		for (const effect of wound.effects ?? []) {
			if (effect?.disabled === true) continue;
			const desired = desiredRuleChanges(effect);
			if (!desired) continue;

			/*
			 * Normal RuleEffectResolver discovery is preferred whenever Foundry says
			 * the Item effect is active. This fallback exists only for the reload
			 * state where an enabled transfer effect is reported inactive.
			 */
			if (effect.active !== false) continue;

			const characteristicId = String(targetId).split(".")[1];
			candidates.push({
				id: `${PROVIDER_ID}:${effect.uuid}:${characteristicId}`,
				targetId,
				operation: RULE_EFFECT_OPERATIONS.MULTIPLY,
				formula: "0.5",
				applicability: RULE_EFFECT_APPLICABILITY.AUTOMATIC,
				side: RULE_EFFECT_SIDES.SELF,
				stacking: "per-acquisition",
				condition: localize(
					"Until medical attention is received",
					"Do czasu otrzymania pomocy medycznej",
				),
				priority: 50,
				defaultSelected: true,
				effectUuid: effect.uuid,
				effectName: effect.name,
				itemUuid: wound.uuid,
				itemName: wound.name,
				itemType: wound.type,
			});
		}
	}
	return candidates;
}

function sameJson(first, second) {
	try {
		return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
	} catch (_error) {
		return false;
	}
}

function isPrimaryActiveGm() {
	if (!game.user?.isGM) return false;
	return primaryActiveGm()?.id === game.user.id;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function reportPersistenceError(error) {
	console.error(
		"WFRP1ED | Unable to persist/repair a Core Critical Wound rule effect.",
		error,
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
