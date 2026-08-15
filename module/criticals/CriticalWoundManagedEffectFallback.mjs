import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const PROVIDER_ID = "wfrp1ed.core-critical-managed-fallback";
const CRITICAL_WOUND_TYPE = "criticalWound";
const SUPPORTED_EFFECT_NUMBERS = new Set([5, 6, 7]);
const SUPPORTED_TARGETS = new Set([
	"characteristic.m.current",
	"characteristic.i.current",
]);

/**
 * Last-resort reconstruction for system-managed Core Critical Wound effects.
 *
 * A persistent wound is the durable game fact. Managed RollTables are lookup
 * infrastructure and their UUID/result ids are not suitable as the only way to
 * reconstruct an ongoing injury after a reload. The embedded ActiveEffect already
 * persists the exact Core consequence number in `coreCriticalConsequence`; use
 * that provenance directly whenever Foundry's ordinary Item-effect discovery
 * cannot see an enabled transfer effect.
 *
 * This provider deliberately stays silent when the same managed effect already
 * exposes a decodable rule change for the requested target and is active, so it
 * cannot double-apply a healthy native ActiveEffect.
 */
RuleEffectResolver.registerCandidateProvider(PROVIDER_ID, ({ actor, targetId }) => {
	if (!(actor instanceof foundry.documents.Actor)) return [];
	if (!SUPPORTED_TARGETS.has(String(targetId ?? ""))) return [];

	const characteristicId = String(targetId).split(".")[1];
	const results = [];

	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;

		for (const effect of wound.effects ?? []) {
			if (effect?.disabled === true) continue;
			const metadata = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
			const effectNumber = positiveInteger(metadata?.effectNumber);
			if (
				String(metadata?.location ?? "") !== "leg" ||
				!SUPPORTED_EFFECT_NUMBERS.has(effectNumber)
			) continue;

			if (isNativelyDiscoverable(effect, targetId)) continue;

			results.push({
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
				actorUuid: actor.uuid,
				effectUuid: effect.uuid,
				effectName: effect.name,
				itemUuid: wound.uuid,
				itemName: wound.name,
				itemType: wound.type,
			});
		}
	}

	return results;
});

/*
 * Persist the consequence number on the wound itself as the new stable
 * provenance field. Legacy wounds are migrated from their managed ActiveEffect
 * flag without consulting a regenerated RollTable.
 */
Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void persistLegacyEffectNumbers().catch((error) => {
		console.error(
			"WFRP1ED | Unable to persist legacy Critical Wound effect numbers.",
			error,
		);
	});
});

function isNativelyDiscoverable(effect, targetId) {
	if (effect?.active === false) return false;
	const changes = ruleChanges(effect);
	return changes.some((change) => {
		const decoded = decodeRuleEffectChange(change);
		return decoded?.targetId === targetId;
	});
}

function ruleChanges(effect) {
	const flagged = effect?.getFlag?.(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY);
	if (Array.isArray(flagged) && flagged.length) return flagged;
	const source = effect?.toObject?.() ?? {};
	if (Array.isArray(source.changes) && source.changes.length) return source.changes;
	const system = effect?.system?.toObject?.() ?? {};
	return Array.isArray(system.changes) ? system.changes : [];
}

async function persistLegacyEffectNumbers() {
	for (const actor of game.actors ?? []) {
		let touched = false;
		for (const wound of actor.items ?? []) {
			if (wound?.type !== CRITICAL_WOUND_TYPE) continue;
			if (positiveInteger(wound.system?.resolution?.effectNumber)) continue;

			const managed = [...(wound.effects ?? [])].find((effect) => {
				const metadata = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
				return String(metadata?.location ?? "") === "leg" &&
					SUPPORTED_EFFECT_NUMBERS.has(positiveInteger(metadata?.effectNumber));
			});
			const effectNumber = positiveInteger(
				managed?.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY)?.effectNumber,
			);
			if (!effectNumber) continue;

			await wound.update({
				"system.resolution.effectNumber": effectNumber,
			});
			touched = true;
		}
		if (touched) void actor.sheet?.render?.({ force: true });
	}
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return Boolean(game.user?.isGM && primaryActiveGm()?.id === game.user.id);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
