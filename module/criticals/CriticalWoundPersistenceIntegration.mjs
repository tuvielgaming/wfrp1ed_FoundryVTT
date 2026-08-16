import {
	encodeRuleEffectChange,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
} from "../effects/RuleEffectRegistry.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_EFFECT_FLAG_KEY = "coreCriticalConsequence";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const CRITICAL_WOUND_TYPE = "criticalWound";
const repairingEffects = new Set();

/*
 * Foundry v14 stores ActiveEffect change records in the document's top-level
 * `changes` field. System-managed legacy Core wound effects are repaired in both
 * that native field and flags.wfrp1ed.ruleChanges. RuleEffectResolver now reads
 * enabled Item transfer effects directly, so a second runtime candidate provider
 * is neither required nor desirable here.
 */
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
				if (await persistManagedRuleChanges(effect)) touchedActors.add(actor);
			}
		}
	}
	for (const actor of touchedActors) refreshActorSheetIfOpen(actor);
}

async function persistManagedRuleChanges(effect) {
	const desired = desiredRuleChanges(effect);
	if (!desired) return false;

	const source = effect.toObject?.() ?? {};
	const currentNative = Array.isArray(source.changes) ? source.changes : [];
	const currentFlag = effect.getFlag?.(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY);
	if (sameJson(currentNative, desired) && sameJson(currentFlag, desired)) return false;

	const key = String(effect.uuid ?? "");
	repairingEffects.add(key);
	try {
		await effect.update({
			changes: foundry.utils.deepClone(desired),
			[`flags.${FLAG_SCOPE}.${RULE_CHANGES_FLAG_KEY}`]: foundry.utils.deepClone(desired),
		});
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
	if (location !== "leg" || !new Set([5, 6, 7]).has(effectNumber)) return null;

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

function refreshActorSheetIfOpen(actor) {
	const sheet = actor?.sheet;
	if (!sheet?.rendered) return;
	void sheet.render();
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
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function reportPersistenceError(error) {
	console.error("WFRP1ED | Unable to persist/repair a Core Critical Wound rule effect.", error);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
