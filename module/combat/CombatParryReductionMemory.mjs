const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";

/**
 * Preserve a physical Parry reduction d6 when later adjudication changes the
 * Parry Test from success to failure.
 *
 * CombatAdjudicationReconciliation already preserves the attack's original
 * damage generation when a Defence Test is edited. Historically its failure
 * branch also cleared `parry.reduction`, which meant changing that same Test back
 * to success forced a second Parry d6 roll. Keep the adjudicated d6 as dormant
 * audit state instead. Damage mechanics still ignore it while `succeeded=false`,
 * and the existing reconciliation code automatically reuses it if Parry becomes
 * successful again. If no Parry d6 has ever been rolled, nothing is invented and
 * the normal `awaiting-parry` flow still asks only for that missing d6.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const current = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (attack?.family !== "melee" || !isD6(current?.parry?.reduction)) return;

	const incoming = changedDamageRoll(changes);
	if (!incoming?.parry || incoming.parry.succeeded !== false) return;

	if (!isD6(incoming.parry.reduction)) {
		incoming.parry.reduction = Number(current.parry.reduction);
	}
	/* Item identity is useful audit context and is required again if the same
	 * successful Parry is restored later. Do not let the failure transition erase
	 * it while the dormant d6 is being retained. */
	if (!String(incoming.parry.itemName ?? "").trim()) {
		incoming.parry.itemName = String(current.parry.itemName ?? "");
	}
	if (!String(incoming.parry.itemUuid ?? "").trim()) {
		incoming.parry.itemUuid = String(current.parry.itemUuid ?? "");
	}
});

function changedDamageRoll(changes) {
	if (!changes || typeof changes !== "object") return null;
	const direct = changes?.flags?.[FLAG_SCOPE]?.[COMBAT_DAMAGE_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
	const flat = changes?.[`flags.${FLAG_SCOPE}.${COMBAT_DAMAGE_FLAG_KEY}`];
	if (flat && typeof flat === "object" && !Array.isArray(flat)) return flat;
	return null;
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}
