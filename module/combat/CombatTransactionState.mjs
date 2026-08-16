import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_FLAG_KEY = "damageState";

/**
 * Return the authoritative melee Attack ChatMessage which owns a combat Test.
 *
 * Attack, Defence and Additional Damage confirmation Tests are separate chat
 * cards, but all three ultimately feed one attack transaction. Keeping this
 * lookup in one small dependency avoids each adjudication/presentation layer
 * inventing a different definition of when that transaction is closed.
 *
 * @param {ChatMessage|null} message
 * @returns {ChatMessage|null}
 */
export function combatAttackSourceForTest(message) {
	if (!message?.id) return null;

	if (message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) {
		return message;
	}

	const defence = message.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	if (defence?.attackMessageId) {
		return game.messages?.get(String(defence.attackMessageId)) ?? null;
	}

	const additional = message.getFlag?.(FLAG_SCOPE, ADDITIONAL_DAMAGE_FLAG_KEY);
	if (additional?.attackMessageId) {
		return game.messages?.get(String(additional.attackMessageId)) ?? null;
	}

	return null;
}

/**
 * Whether an intermediate combat Test is closed against adjudication.
 *
 * Positive Damage remains editable until Apply Damage creates the authoritative
 * Actor transaction. This allows the Attack, Defence/Parry and Additional Damage
 * confirmation results to be corrected after damage dice are rolled; the normal
 * reconciliation path then invalidates/rebuilds that still-unapplied damage.
 *
 * Once damage is applied, all earlier test cards become immutable until the GM
 * explicitly invalidates/reverts that damage transaction. A resolved zero-damage
 * result is terminal immediately because there is no Apply Damage action to act
 * as a later transaction boundary.
 *
 * @param {ChatMessage|null} message Attack/Defence/Additional-Damage Test card
 * @returns {boolean}
 */
export function isCombatTestAdjudicationLocked(message) {
	const source = combatAttackSourceForTest(message);
	if (!source) return false;

	const damage = source.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!damage?.packet?.id) return false;

	const actor = actorFromUuidSync(damage.packet.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, damage.packet.id)
		: damage.application ?? null;

	if (transaction?.state === "reverted") return false;
	if (transaction?.state === "applied") return true;

	const finalAmount = Number(damage.resolution?.finalAmount);
	return Number.isFinite(finalAmount) && finalAmount <= 0;
}

/**
 * Explain the current edit boundary for UI tooltips/errors.
 *
 * @returns {string}
 */
export function combatTestLockReason() {
	return game.i18n.lang === "pl"
		? "Transakcja ataku jest zamknięta po zastosowaniu obrażeń. Unieważnij obrażenia, aby ponownie zmienić wcześniejsze wyniki testów."
		: "The attack transaction is closed after damage was applied. Invalidate damage to change earlier test results again.";
}

function actorFromUuidSync(uuid) {
	const value = String(uuid ?? "").trim();
	if (!value) return null;

	try {
		const document = foundry.utils.fromUuidSync(value);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}

	return null;
}
