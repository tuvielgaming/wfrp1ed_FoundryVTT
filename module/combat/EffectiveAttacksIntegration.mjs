import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";
import { CombatAttackSheetStatus } from "./CombatAttackSheetStatus.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ACTOR_REMAINING_FLAG_KEY = "manualAttacksRemaining";

let installed = false;
let originalAllowance = null;
let originalSetRemaining = null;
let originalCommitRemaining = null;
let originalDecorate = null;

/**
 * Bridge the effective Attacks characteristic into the special Attacks resource.
 *
 * A is not merely a displayed profile number: CombatAttackEconomy turns it into
 * a per-round allowance and CombatAttackSheetStatus renders remaining/maximum.
 * Those consumers historically read raw `system.characteristics.a.current`, so
 * generic rule effects could correctly mark A as modified while combat still
 * used the unmodified value. This integration makes all Attacks consumers use
 * Actor.getCharacteristicValue("a"), regardless of whether the modifier comes
 * from a Critical Wound, Skill, spell, equipment, or any future rule provider.
 */
Hooks.once("init", () => install());

function install() {
	if (installed) return;
	installed = true;

	originalAllowance = CombatAttackEconomy.allowance;
	CombatAttackEconomy.allowance = function effectiveAttackAllowance(combatant) {
		const effective = effectiveAttacks(combatant?.actor);
		return effective ?? originalAllowance.call(this, combatant);
	};

	originalSetRemaining = CombatAttackSheetStatus.setRemaining;
	CombatAttackSheetStatus.setRemaining = async function setEffectiveRemaining(
		actor,
		combatant,
		remaining,
	) {
		const value = combatant
			? remaining
			: clampRemaining(remaining, effectiveAttacks(actor));
		return originalSetRemaining.call(this, actor, combatant, value);
	};

	originalCommitRemaining = CombatAttackSheetStatus.commitRemaining;
	CombatAttackSheetStatus.commitRemaining = async function commitEffectiveRemaining(
		actor,
		combatant,
		remaining,
		requestingUser,
	) {
		const value = combatant
			? remaining
			: clampRemaining(remaining, effectiveAttacks(actor));
		return originalCommitRemaining.call(
			this,
			actor,
			combatant,
			value,
			requestingUser,
		);
	};

	originalDecorate = CombatAttackSheetStatus.decorate;
	CombatAttackSheetStatus.decorate = function decorateEffectiveAttacks(
		application,
		element,
	) {
		originalDecorate.call(this, application, element);
		const actor = application?.document;
		if (!actor || actor.documentName !== "Actor") return;

		/* In started Combat the original presentation already uses the patched
		 * CombatAttackEconomy allowance. Outside Combat it has a separate manual
		 * resource path, so normalize that presentation here as well. */
		if (combatantForActor(actor)) return;
		decorateOutsideCombat(element, actor);
	};
}

function decorateOutsideCombat(root, actor) {
	const allowance = effectiveAttacks(actor);
	if (allowance === null) return;
	const wrapper = root?.querySelector?.("[data-wfrp-current-attacks]");
	if (!wrapper) return;

	const stored = Number(actor.getFlag?.(FLAG_SCOPE, ACTOR_REMAINING_FLAG_KEY));
	const remaining = Number.isFinite(stored) && Number.isInteger(stored)
		? Math.min(allowance, Math.max(0, stored))
		: allowance;

	const input = wrapper.querySelector(".characteristic-current-attacks-input");
	if (input) {
		input.max = String(allowance);
		input.value = String(remaining);
	}
	const maximum = wrapper.querySelector(".characteristic-current-attacks-max");
	if (maximum) maximum.textContent = String(allowance);
	const readonly = wrapper.querySelector(".characteristic-current-attacks-readonly");
	if (readonly) readonly.textContent = `${remaining}/${allowance}`;
}

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started) return null;
	const active = combat.combatant;
	if (sameActor(active?.actor, actor)) return active;

	const exact = [...combat.combatants].filter(
		(combatant) => combatant.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];

	const sameId = [...combat.combatants].filter(
		(combatant) => combatant.actor?.id && actor.id && combatant.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function effectiveAttacks(actor) {
	if (!actor) return null;
	try {
		if (typeof actor.getCharacteristicValue === "function") {
			const value = Number(actor.getCharacteristicValue("a"));
			if (Number.isFinite(value)) return Math.max(0, Math.trunc(value));
		}
	} catch (_error) {
		/* Fall through to raw compatibility data. */
	}

	const characteristic = actor.system?.characteristics?.a;
	for (const candidate of [
		characteristic?.current,
		characteristic?.value,
		characteristic,
	]) {
		const value = Number(candidate);
		if (Number.isFinite(value)) return Math.max(0, Math.trunc(value));
	}
	return null;
}

function clampRemaining(value, allowance) {
	const numeric = Number(value);
	const maximum = Number.isFinite(Number(allowance))
		? Math.max(0, Math.trunc(Number(allowance)))
		: 0;
	return Number.isFinite(numeric)
		? Math.min(maximum, Math.max(0, Math.trunc(numeric)))
		: 0;
}

function sameActor(first, second) {
	if (!first || !second) return false;
	if (first.uuid && second.uuid) return first.uuid === second.uuid;
	return Boolean(first.id && second.id && first.id === second.id);
}
