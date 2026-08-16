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
const TIMED_FLAG_KEY = "criticalTimed";
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
 * Foundry can prepare an Item-embedded timed ActiveEffect as expired even while
 * our WFRP round anchor still says the consequence is active. For system-managed
 * timed Criticals, `flags.wfrp1ed.criticalTimed.expiredAtRound` is therefore the
 * authoritative expiry boundary. The native duration remains presentation and
 * compatibility data, not the only source of truth.
 */
RuleEffectResolver.registerCandidateProvider(PROVIDER_ID, ({ actor, targetId }) => {
	if (!(actor instanceof foundry.documents.Actor)) return [];
	if (!SUPPORTED_TARGETS.has(String(targetId ?? ""))) return [];

	const results = [];
	for (const wound of actor.items ?? []) {
		if (wound?.type !== CRITICAL_WOUND_TYPE) continue;

		for (const effect of wound.effects ?? []) {
			const generic = effect.getFlag?.(FLAG_SCOPE, GENERIC_EFFECT_FLAG_KEY);
			if (effect?.disabled === true || isExpiredForWfrp(effect, generic)) continue;
			if (isNativelyDiscoverable(effect, targetId)) continue;

			if (generic?.kind === "characteristics") {
				const changes = ruleChanges(effect);
				for (let index = 0; index < changes.length; index += 1) {
					const decoded = decodeRuleEffectChange(changes[index]);
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

/**
 * Match the generic resolver's native discovery contract. If Foundry considers
 * the effect expired, native discovery will not see it; the fallback may still
 * restore it when the WFRP timed flag says the duration has not actually ended.
 */
function isNativelyDiscoverable(effect, targetId) {
	if (effect?.disabled === true || effect?.duration?.expired === true) return false;
	const item = effect?.parent;
	const ownedItem =
		item instanceof foundry.documents.Item &&
		item.parent instanceof foundry.documents.Actor;
	if (ownedItem) {
		if (effect.transfer === false) return false;
	} else if (effect?.active === false) {
		return false;
	}
	return ruleChanges(effect).some((change) =>
		decodeRuleEffectChange(change)?.targetId === targetId);
}

function isExpiredForWfrp(effect, generic) {
	if (generic?.kind === "characteristics") {
		const timed = effect.getFlag?.(FLAG_SCOPE, TIMED_FLAG_KEY);
		if (
			timed &&
			typeof timed === "object" &&
			String(timed.units ?? "") === "rounds"
		) {
			return positiveInteger(timed.expiredAtRound) > 0;
		}
	}
	return effect?.duration?.expired === true;
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
		if (touched) refreshActorSheetIfOpen(actor);
	}
}

function refreshActorSheetIfOpen(actor) {
	const sheet = actor?.sheet;
	if (!sheet?.rendered) return;
	void sheet.render();
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
