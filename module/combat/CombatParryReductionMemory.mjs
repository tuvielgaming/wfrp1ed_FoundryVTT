const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const TEST_FLAG_KEY = "testResultState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";

const rememberedParryReduction = new Map();

/**
 * Preserve an already-rolled physical Parry reduction d6 across later edits of
 * the linked Parry Test.
 *
 * CombatAdjudicationReconciliation temporarily clears/rebuilds the attack damage
 * state while a Defence Test result is changed. The previous implementation only
 * tried to copy the d6 from the attack message during that rebuild, but at that
 * point another reconciliation step may already have cleared the flag. Capture
 * the adjudicated reduction when the Defence Test edit starts, then inject that
 * dormant value into the rebuilt attack state for both failure and restored
 * success. Damage ignores the value while `succeeded=false`; if the same Parry
 * later becomes successful again the canonical reconciliation sees the preserved
 * d6 and rebuilds damage immediately instead of asking for another reduction
 * roll. If no Parry reduction has ever been rolled, nothing is invented and the
 * normal `awaiting-parry` flow remains unchanged.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	captureBeforeDefenceAdjudication(message, changes);
	preserveDuringDamageRebuild(message, changes);
});

function captureBeforeDefenceAdjudication(message, changes) {
	if (!testStateChanged(changes)) return;
	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	const attackMessageId = String(defence?.attackMessageId ?? "").trim();
	if (!attackMessageId) return;

	const attackMessage = game.messages?.get(attackMessageId);
	const attack = attackMessage?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const current = attackMessage?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (attack?.family !== "melee" || !isD6(current?.parry?.reduction)) return;

	rememberedParryReduction.set(attackMessageId, {
		reduction: Number(current.parry.reduction),
		itemName: String(current.parry.itemName ?? ""),
		itemUuid: String(current.parry.itemUuid ?? ""),
	});
}

function preserveDuringDamageRebuild(message, changes) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family !== "melee") return;

	const incoming = changedDamageRoll(changes);
	if (!incoming?.parry || typeof incoming.parry !== "object") return;
	if (incoming.parry.succeeded !== false && incoming.parry.succeeded !== true) return;

	const current = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const remembered = rememberedParryReduction.get(String(message.id ?? ""));
	const reduction = isD6(current?.parry?.reduction)
		? Number(current.parry.reduction)
		: isD6(remembered?.reduction)
			? Number(remembered.reduction)
			: null;
	if (reduction === null) return;

	if (!isD6(incoming.parry.reduction)) {
		incoming.parry.reduction = reduction;
	}

	const itemName = String(current?.parry?.itemName ?? remembered?.itemName ?? "");
	const itemUuid = String(current?.parry?.itemUuid ?? remembered?.itemUuid ?? "");
	if (!String(incoming.parry.itemName ?? "").trim() && itemName.trim()) {
		incoming.parry.itemName = itemName;
	}
	if (!String(incoming.parry.itemUuid ?? "").trim() && itemUuid.trim()) {
		incoming.parry.itemUuid = itemUuid;
	}

	rememberedParryReduction.set(String(message.id ?? ""), {
		reduction,
		itemName: String(incoming.parry.itemName ?? itemName),
		itemUuid: String(incoming.parry.itemUuid ?? itemUuid),
	});
}

function changedDamageRoll(changes) {
	if (!changes || typeof changes !== "object") return null;
	const direct = changes?.flags?.[FLAG_SCOPE]?.[COMBAT_DAMAGE_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
	const flat = changes?.[`flags.${FLAG_SCOPE}.${COMBAT_DAMAGE_FLAG_KEY}`];
	if (flat && typeof flat === "object" && !Array.isArray(flat)) return flat;
	return null;
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	if (Object.keys(changes).some((key) => key === path || key.startsWith(`${path}.`))) return true;
	const scoped = changes?.flags?.[FLAG_SCOPE];
	if (!scoped || typeof scoped !== "object") return false;
	return Object.keys(scoped).some((key) => key === TEST_FLAG_KEY || key.startsWith(`${TEST_FLAG_KEY}.`));
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}
