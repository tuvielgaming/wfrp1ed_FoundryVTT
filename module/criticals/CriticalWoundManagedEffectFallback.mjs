import {
	decodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "../effects/RuleEffectResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const GENERIC_EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const PROVIDER_ID = "wfrp1ed.core-critical-managed-fallback";
const CRITICAL_WOUND_TYPE = "criticalWound";
const SUPPORTED_EFFECT_NUMBERS = new Set([5, 6, 7]);
const SUPPORTED_TARGETS = new Set([
	"characteristic.m.current",
	"characteristic.i.current",
]);

/**
 * Last-resort reconstruction for managed Core Critical Wound effects.
 *
 * Some Foundry reload paths can report enabled transfer effects embedded in an
 * owned Item as inactive. The persistent wound/effect remains the durable game
 * fact, so reconstruct its declarative WFRP candidate only when native effect
 * discovery cannot see it. Timed generic Critical effects are never restored
 * after their Foundry duration has expired.
 */
RuleEffectResolver.registerCandidateProvider(PROVIDER_ID, ({ actor, targetId }) => {
	if (!(actor instanceof foundry.documents.Actor)) return [];
	if (!SUPPORTED_TARGETS.has(String(targetId ?? ""))) return [];

	const results = [];
	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;

		for (const effect of wound.effects ?? []) {
			if (effect?.disabled === true || effect.duration?.expired === true) continue;
			if (isNativelyDiscoverable(effect, targetId)) continue;

			const generic = effect.getFlag?.(FLAG_SCOPE, GENERIC_EFFECT_FLAG_KEY);
			if (generic?.kind === "characteristics") {
				for (let index = 0; index < ruleChanges(effect).length; index += 1) {
					const decoded = decodeRuleEffectChange(ruleChanges(effect)[index]);
					if (decoded?.targetId !== targetId) continue;
					results.push(candidateFromDecoded({
						actor,
						wound,
						effect,
						decoded,
						id: `${PROVIDER_ID}:generic:${effect.uuid}:${index}`,
					}));
				}
				continue;
			}

			const metadata = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
			const effectNumber = positiveInteger(metadata?.effectNumber);
			if (
				String(metadata?.location ?? "") !== "leg" ||
				!SUPPORTED_EFFECT_NUMBERS.has(effectNumber)
			) continue;

			const characteristicId = String(targetId).split(".")[1];
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

/* Persist provenance immediately for newly created/repaired legacy effects. */
for (const hook of ["createActiveEffect", "updateActiveEffect"]) {
	Hooks.on(hook, (effect) => {
		void persistEffectNumberFromManagedEffect(effect).catch((error) => {
			console.error(
				"WFRP1ED | Unable to persist Critical Wound effect-number provenance.",
				error,
			);
		});
	});
}

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void persistLegacyEffectNumbers().catch((error) => {
		console.error(
			"WFRP1ED | Unable to persist legacy Critical Wound effect numbers.",
			error,
		);
	});
});

function candidateFromDecoded({ actor, wound, effect, decoded, id }) {
	return {
		id,
		targetId: decoded.targetId,
		operation: decoded.operation,
		formula: decoded.formula,
		applicability: decoded.applicability,
		side: decoded.side,
		stacking: decoded.stacking,
		condition: decoded.condition,
		priority: decoded.priority,
		defaultSelected: decoded.applicability === RULE_EFFECT_APPLICABILITY.AUTOMATIC,
		actorUuid: actor.uuid,
		effectUuid: effect.uuid,
		effectName: effect.name,
		itemUuid: wound.uuid,
		itemName: wound.name,
		itemType: wound.type,
	};
}

function isNativelyDiscoverable(effect, targetId) {
	if (effect?.active === false) return false;
	return ruleChanges(effect).some((change) =>
		decodeRuleEffectChange(change)?.targetId === targetId);
}

function ruleChanges(effect) {
	const flagged = effect?.getFlag?.(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY);
	if (Array.isArray(flagged) && flagged.length) return flagged;
	const source = effect?.toObject?.() ?? {};
	if (Array.isArray(source.changes) && source.changes.length) return source.changes;
	const system = effect?.system?.toObject?.() ?? {};
	return Array.isArray(system.changes) ? system.changes : [];
}

async function persistEffectNumberFromManagedEffect(effect) {
	if (!isPrimaryActiveGm()) return false;
	const wound = effect?.parent;
	if (wound?.type !== CRITICAL_WOUND_TYPE) return false;
	const metadata = effect.getFlag?.(FLAG_SCOPE, CORE_EFFECT_FLAG_KEY);
	const effectNumber = positiveInteger(metadata?.effectNumber);
	if (
		String(metadata?.location ?? "") !== "leg" ||
		!SUPPORTED_EFFECT_NUMBERS.has(effectNumber) ||
		positiveInteger(wound.system?.resolution?.effectNumber) === effectNumber
	) return false;

	await wound.update({ "system.resolution.effectNumber": effectNumber });
	return true;
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

			await wound.update({ "system.resolution.effectNumber": effectNumber });
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
