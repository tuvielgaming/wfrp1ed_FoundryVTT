import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";
import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";

const defenceReconciliations = new Map();
const additionalDamageReconciliations = new Set();

/**
 * Preserve already-rolled random dice when a GM adjudicates a later combat Test.
 *
 * The base combat integration deliberately invalidates an unapplied DamagePacket
 * when its defence Test changes. That is correct for the derived resolution, but
 * a failed->successful Parry must not become a way to reroll the attacker's
 * already-known damage die. This layer snapshots that roll before invalidation,
 * temporarily pauses automatic damage rolling, and rebuilds only the dependent
 * stages from the original random result.
 *
 * The same principle applies to the Core Additional Damage confirmation Test:
 * editing its result changes whether the extra exploding d6 sequence exists,
 * while the original attack damage d6 is immutable. If the confirmation becomes
 * successful for the first time, only the newly-required extra d6 sequence is
 * rolled.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	if (!testStateChanged(changes)) return;

	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	if (defence?.attackMessageId) {
		prepareDefenceReconciliation(message, defence);
		return;
	}

	const additional = message?.getFlag?.(
		FLAG_SCOPE,
		ADDITIONAL_DAMAGE_FLAG_KEY,
	);
	if (!additional?.attackMessageId) return;

	const attackMessage = game.messages?.get(String(additional.attackMessageId));
	if (!attackMessage) return;
	if (hasAppliedDamage(attackMessage)) {
		ui.notifications.warn(localize(
			"Invalidate the applied damage before changing the Additional Damage confirmation Test.",
			"Przed zmianą testu potwierdzającego Obrażenia dodatkowe unieważnij zastosowane obrażenia.",
		));
		return false;
	}
});

Hooks.on("updateChatMessage", (message, changes) => {
	if (!testStateChanged(changes)) return;

	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	if (defence?.attackMessageId) {
		const snapshot = defenceReconciliations.get(String(message.id));
		if (snapshot) {
			void reconcileDefenceAdjudication(message, snapshot);
		}
		return;
	}

	const additional = message?.getFlag?.(
		FLAG_SCOPE,
		ADDITIONAL_DAMAGE_FLAG_KEY,
	);
	if (additional?.attackMessageId) {
		void reconcileAdditionalDamageAdjudication(message, additional);
	}
});

function prepareDefenceReconciliation(defenceMessage, defence) {
	const attackMessage = game.messages?.get(String(defence.attackMessageId ?? ""));
	if (!attackMessage || hasAppliedDamage(attackMessage)) return;

	const rollState = attackMessage.getFlag?.(
		FLAG_SCOPE,
		COMBAT_DAMAGE_FLAG_KEY,
	);
	if (!rollState) return;

	const damageState = attackMessage.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_FLAG_KEY,
	);
	const suspensionKey = `defence-adjudication:${String(attackMessage.id)}`;
	WfrpRuleSettings.suspendDamageAutomation(suspensionKey);

	const previous = defenceReconciliations.get(String(defenceMessage.id));
	if (previous?.suspensionKey) {
		WfrpRuleSettings.resumeDamageAutomation(previous.suspensionKey);
	}

	const snapshot = {
		attackMessageId: String(attackMessage.id),
		rollState: foundry.utils.deepClone(rollState),
		damageState: damageState ? foundry.utils.deepClone(damageState) : null,
		suspensionKey,
		capturedAt: Date.now(),
	};
	defenceReconciliations.set(String(defenceMessage.id), snapshot);

	/* Safety valve in case another module cancels the update after this hook. */
	setTimeout(() => {
		const current = defenceReconciliations.get(String(defenceMessage.id));
		if (current !== snapshot) return;
		defenceReconciliations.delete(String(defenceMessage.id));
		WfrpRuleSettings.resumeDamageAutomation(suspensionKey);
	}, 2500);
}

async function reconcileDefenceAdjudication(defenceMessage, snapshot) {
	const messageId = String(defenceMessage?.id ?? "");
	if (!messageId || defenceReconciliations.get(messageId) !== snapshot) return;

	const attackMessage = game.messages?.get(String(snapshot.attackMessageId ?? ""));
	if (!attackMessage) {
		finishDefenceReconciliation(messageId, snapshot);
		return;
	}

	try {
		/*
		 * CombatDamageIntegration archives/unsets the stale result asynchronously.
		 * Wait for that authoritative invalidation before rebuilding from our saved
		 * random roll. Automation is suspended during this window, so an NPC cannot
		 * race us by producing a replacement damage die.
		 */
		const cleared = await waitForDamageRollClear(attackMessage, snapshot.rollState);
		if (!cleared) return;

		const outcome = CombatDefenceTransaction.outcomeForAttack(attackMessage);
		if (
			!outcome?.attackHit ||
			outcome.defenceStatus !== "resolved" ||
			!outcome.continueToDamage
		) {
			return;
		}

		const attackState = attackMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (!attackState) return;

		const restored = foundry.utils.deepClone(snapshot.rollState);
		restored.packetId = null;
		restored.finalAmount = null;
		restored.updatedBy = String(game.user?.id ?? "");
		restored.updatedAt = Date.now();

		if (outcome.parrySucceeded) {
			const existingReduction = Number(restored.parry?.reduction);
			const hasExistingReduction =
				Number.isInteger(existingReduction) && existingReduction >= 0;
			restored.parry = {
				...(restored.parry ?? {}),
				succeeded: true,
				itemName: String(attackState.defence?.itemName ?? ""),
				itemUuid: String(attackState.defence?.itemUuid ?? ""),
				reduction: hasExistingReduction ? existingReduction : null,
			};

			if (!hasExistingReduction) {
				restored.status = "awaiting-parry";
				await attackMessage.setFlag(
					FLAG_SCOPE,
					COMBAT_DAMAGE_FLAG_KEY,
					restored,
				);
				return;
			}
		} else {
			restored.parry = {
				...(restored.parry ?? {}),
				succeeded: false,
				reduction: null,
				itemName: "",
				itemUuid: "",
			};
		}

		restored.status = "resolved";
		await rebuildDamageFromPreservedRoll(
			attackMessage,
			attackState,
			restored,
			snapshot.damageState,
		);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to reconcile damage after defence adjudication.",
			error,
		);
		ui.notifications.error(error?.message ?? localize(
			"Unable to reconcile the original damage roll after defence adjudication.",
			"Nie udało się odtworzyć pierwotnego rzutu obrażeń po zmianie wyniku obrony.",
		));
	} finally {
		finishDefenceReconciliation(messageId, snapshot);
		void ui.chat?.render?.({ force: true });
	}
}

function finishDefenceReconciliation(messageId, snapshot) {
	if (defenceReconciliations.get(messageId) === snapshot) {
		defenceReconciliations.delete(messageId);
	}
	if (snapshot?.suspensionKey) {
		WfrpRuleSettings.resumeDamageAutomation(snapshot.suspensionKey);
	}
}

async function waitForDamageRollClear(message, originalRoll) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const current = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		if (!current) return true;

		/* If another integration already reconciled to a different roll, do not clobber it. */
		if (!sameRollIdentity(current, originalRoll)) return false;
		await delay(10);
	}
	return !message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
}

function sameRollIdentity(left, right) {
	return Boolean(
		left &&
		right &&
		Number(left.rolledAt) === Number(right.rolledAt) &&
		Number(left.initialDie) === Number(right.initialDie),
	);
}

async function reconcileAdditionalDamageAdjudication(testMessage, marker) {
	const testMessageId = String(testMessage?.id ?? "");
	if (!testMessageId || additionalDamageReconciliations.has(testMessageId)) return;

	const attackMessage = game.messages?.get(String(marker.attackMessageId ?? ""));
	if (!attackMessage || hasAppliedDamage(attackMessage)) return;
	const rollState = attackMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!rollState || Number(rollState.initialDie) !== 6) return;

	additionalDamageReconciliations.add(testMessageId);
	try {
		const testState = testMessage.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!testState) return;
		const result = TestResultChat._templateContext(testState).result;
		const previous = rollState.additionalDamage ?? {};
		const wasSuccessful = previous.testSucceeded === true;
		const isSuccessful = result.success === true;
		const updated = foundry.utils.deepClone(rollState);
		updated.additionalDamage = {
			...foundry.utils.deepClone(previous),
			triggered: true,
			testMessageId,
			testRoll: Number(result.roll),
			testTarget: Number(result.target),
			testSucceeded: isSuccessful,
			extraDice: Array.isArray(previous.extraDice)
				? [...previous.extraDice]
				: [],
		};

		if (isSuccessful && !wasSuccessful) {
			updated.additionalDamage.extraDice = await rollExplodingAdditionalDamage();
		} else if (!isSuccessful) {
			updated.additionalDamage.extraDice = [];
		}

		/*
		 * An adjudication which crosses success/failure changes the actual dice
		 * participating in damage, so a previous manual sum override is no longer
		 * meaningful. Success->success preserves both extra dice and any manual sum.
		 */
		if (isSuccessful !== wasSuccessful) {
			updated.diceTotalOverridden = false;
			updated.diceTotalOverriddenBy = null;
			updated.diceTotalOverriddenAt = null;
		}

		updated.damageDice = [
			nonNegativeInteger(updated.initialDie),
			...updated.additionalDamage.extraDice.map(nonNegativeInteger),
		];
		const rolledTotal = updated.damageDice.reduce((sum, die) => sum + die, 0);
		updated.diceTotalOriginal = rolledTotal;
		if (!updated.diceTotalOverridden) updated.diceTotal = rolledTotal;
		updated.generatedDamage = Math.max(
			0,
			nonNegativeInteger(updated.diceTotal) +
				integer(updated.strength) +
				integer(updated.weaponDamageModifier),
		);
		updated.rawAmount = updated.generatedDamage;
		updated.updatedBy = String(game.user?.id ?? "");
		updated.updatedAt = Date.now();

		const attackState = attackMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (!attackState) return;

		if (updated.status === "awaiting-parry") {
			await attackMessage.setFlag(
				FLAG_SCOPE,
				COMBAT_DAMAGE_FLAG_KEY,
				updated,
			);
			void ui.chat?.render?.({ force: true });
			return;
		}

		const currentDamage = attackMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		await rebuildDamageFromPreservedRoll(
			attackMessage,
			attackState,
			updated,
			currentDamage,
		);
		void ui.chat?.render?.({ force: true });
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to reconcile Additional Damage adjudication.",
			error,
		);
		ui.notifications.error(error?.message ?? localize(
			"Unable to update damage after changing the Additional Damage confirmation Test.",
			"Nie udało się zaktualizować obrażeń po zmianie testu potwierdzającego Obrażenia dodatkowe.",
		));
	} finally {
		additionalDamageReconciliations.delete(testMessageId);
	}
}

async function rollExplodingAdditionalDamage() {
	const dice = [];
	do {
		const roll = await new Roll("1d6").evaluate({ allowInteractive: false });
		await showRollAnimation(roll);
		const die = Number(roll.total);
		if (!Number.isInteger(die) || die < 1 || die > 6) {
			throw new Error("Additional Damage d6 did not produce a value from 1 to 6.");
		}
		dice.push(die);
		if (die !== 6) break;
	} while (true);
	return dice;
}

async function rebuildDamageFromPreservedRoll(
	message,
	attackState,
	rollState,
	existingDamageState,
) {
	const defender = actorFromUuidSync(
		attackState?.target?.uuid ?? rollState?.defenderUuid,
	);
	if (!(defender instanceof foundry.documents.Actor)) {
		throw new Error("The defender is no longer available for damage reconciliation.");
	}

	const existingPacket = existingDamageState?.packet
		? DamagePacket.fromJSON(existingDamageState.packet)
		: null;
	const parry = rollState.parry ?? {};
	const specialMitigation =
		parry.succeeded === true &&
		Number.isInteger(Number(parry.reduction))
			? {
				parry: {
					reduction: nonNegativeInteger(parry.reduction),
					itemName: String(parry.itemName ?? ""),
					itemUuid: String(parry.itemUuid ?? ""),
				},
			}
			: {};

	const packet = new DamagePacket({
		id: existingPacket?.id ?? null,
		rawAmount: nonNegativeInteger(rollState.generatedDamage),
		targetActorUuid: defender.uuid,
		source: existingPacket?.source ?? {
			kind: "combat-attack",
			id: String(message.id),
			uuid: String(message.uuid ?? `ChatMessage.${message.id}`),
			label: String(attackState.weapon?.name ?? "Melee attack"),
		},
		armour: existingPacket?.mitigation?.armour ?? DAMAGE_MITIGATION_POLICY.APPLY,
		toughness: existingPacket?.mitigation?.toughness ?? DAMAGE_MITIGATION_POLICY.APPLY,
		hitLocation: rollState.hitLocation,
		specialMitigation,
		criticalMode: existingPacket?.critical?.mode ?? DAMAGE_CRITICAL_MODE.DETAILED,
		createdAt: existingPacket?.createdAt ?? Date.now(),
	});
	const resolution = DamageResolver.resolve(packet, {
		toughness: { value: nonNegativeInteger(rollState.toughness) },
		armour: foundry.utils.deepClone(rollState.armour ?? {}),
	});
	const finalized = {
		...foundry.utils.deepClone(rollState),
		version: Math.max(4, Number(rollState.version) || 0),
		status: "resolved",
		packetId: packet.id,
		rawAmount: packet.rawAmount,
		finalAmount: resolution.finalAmount,
		resolvedBy: String(game.user?.id ?? ""),
		resolvedAt: Date.now(),
	};

	await DamageChat.attach(message, { packet, resolution });
	await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, finalized);
	return finalized;
}

function hasAppliedDamage(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return false;
	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	return actor instanceof foundry.documents.Actor &&
		DamageApplication.transactionFor(actor, state.packet.id)?.state === "applied";
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

async function showRollAnimation(roll) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, game.user, true);
	} catch (error) {
		console.warn(
			"WFRP1ED | Dice So Nice could not animate reconciled Additional Damage.",
			error,
		);
	}
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
