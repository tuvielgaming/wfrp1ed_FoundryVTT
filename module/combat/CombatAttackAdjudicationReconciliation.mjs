import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";

const reconciliations = new Map();

/**
 * Editing a successful attack d100 must not provide another damage die.
 *
 * CombatDamageIntegration correctly invalidates the derived DamagePacket when
 * the attack Test changes, because the reversed d100 may select a different hit
 * location. This integration preserves the already-known random damage dice and
 * the original Strength/Toughness/parry snapshots, rebuilding only the dependent
 * hit-location/armour/final-damage stages.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	if (!testStateChanged(changes)) return;
	if (!message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return;

	prepareReconciliation(message);
});

Hooks.on("updateChatMessage", (message, changes) => {
	if (!testStateChanged(changes)) return;
	if (!message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return;

	const snapshot = reconciliations.get(String(message.id ?? ""));
	if (snapshot) void reconcileAttackAdjudication(message, snapshot);
});

function prepareReconciliation(message) {
	if (hasAppliedDamage(message)) return;

	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!rollState) return;

	const messageId = String(message.id ?? "");
	const suspensionKey = `attack-adjudication:${messageId}`;
	WfrpRuleSettings.suspendDamageAutomation(suspensionKey);

	const previous = reconciliations.get(messageId);
	if (previous?.suspensionKey) {
		WfrpRuleSettings.resumeDamageAutomation(previous.suspensionKey);
	}

	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const snapshot = {
		rollState: foundry.utils.deepClone(rollState),
		damageState: damageState ? foundry.utils.deepClone(damageState) : null,
		suspensionKey,
	};
	reconciliations.set(messageId, snapshot);

	setTimeout(() => {
		const current = reconciliations.get(messageId);
		if (current !== snapshot) return;
		reconciliations.delete(messageId);
		WfrpRuleSettings.resumeDamageAutomation(suspensionKey);
	}, 3000);
}

async function reconcileAttackAdjudication(message, snapshot) {
	const messageId = String(message?.id ?? "");
	if (!messageId || reconciliations.get(messageId) !== snapshot) return;

	try {
		/* Wait for CombatDamageIntegration to archive/unset the stale derivation. */
		const cleared = await waitForDamageRollClear(message, snapshot.rollState);
		if (!cleared) return;

		const outcome = CombatDefenceTransaction.outcomeForAttack(message);
		if (
			!outcome?.attackHit ||
			outcome.defenceStatus !== "resolved" ||
			!outcome.continueToDamage
		) {
			return;
		}

		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const test = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!attack || !test) return;

		const attackResult = TestResultChat._templateContext(test).result;
		const defender = actorFromUuidSync(
			attack.target?.uuid ?? snapshot.rollState.defenderUuid,
		);
		if (!(defender instanceof foundry.documents.Actor)) {
			throw new Error("The defender is no longer available after attack adjudication.");
		}

		const restored = foundry.utils.deepClone(snapshot.rollState);
		restored.attackRoll = normalizedD100(attackResult.roll);
		restored.hitLocation = hitLocationFromAttackRoll(restored.attackRoll);
		restored.armour = foundry.utils.deepClone(
			CombatEquipment.armourAt(defender, restored.hitLocation),
		);
		/*
		 * Toughness was part of the original damage snapshot. Editing only the
		 * attack d100 must not silently adopt a later characteristic change.
		 */
		restored.toughness = nonNegativeInteger(snapshot.rollState.toughness);
		restored.packetId = null;
		restored.finalAmount = null;
		restored.updatedBy = String(game.user?.id ?? "");
		restored.updatedAt = Date.now();

		/*
		 * Attack adjudication does not invalidate an already-rolled parry-reduction
		 * die. The previous code trusted the stored stage string, which could still
		 * read `awaiting-parry` after an earlier presentation/reconciliation pass and
		 * exposed a second Roll Parry Reduction button even though a real 1d6 result
		 * had already been used. Derive the stage from the authoritative defence plus
		 * the actual reduction value instead.
		 */
		if (outcome.parrySucceeded) {
			const reduction = Number(restored.parry?.reduction);
			const hasReduction = Number.isInteger(reduction) && reduction >= 1 && reduction <= 6;
			restored.parry = {
				...(restored.parry ?? {}),
				succeeded: true,
				itemName: String(attack.defence?.itemName ?? restored.parry?.itemName ?? ""),
				itemUuid: String(attack.defence?.itemUuid ?? restored.parry?.itemUuid ?? ""),
				reduction: hasReduction ? reduction : null,
			};
			if (!hasReduction) {
				restored.status = "awaiting-parry";
				await message.setFlag(
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
			message,
			attack,
			restored,
			snapshot.damageState,
			defender,
		);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to preserve damage after attack adjudication.",
			error,
		);
		ui.notifications.error(error?.message ?? localize(
			"Unable to rebuild damage from the original dice after changing the attack d100.",
			"Nie udało się przeliczyć obrażeń z pierwotnych kości po zmianie K100 ataku.",
		));
	} finally {
		finishReconciliation(messageId, snapshot);
		void ui.chat?.render?.({ force: true });
	}
}

async function rebuildDamageFromPreservedRoll(
	message,
	attack,
	rollState,
	existingDamageState,
	defender,
) {
	const existingPacket = existingDamageState?.packet
		? DamagePacket.fromJSON(existingDamageState.packet)
		: null;
	const parry = rollState.parry ?? {};
	const specialMitigation = {};
	if (
		parry.succeeded === true &&
		Number.isInteger(Number(parry.reduction))
	) {
		specialMitigation.parry = {
					reduction: nonNegativeInteger(parry.reduction),
					itemName: String(parry.itemName ?? ""),
					itemUuid: String(parry.itemUuid ?? ""),
				};
	}
	const armourPenetration = nonNegativeInteger(
		rollState.armourPenetration,
	);
	if (armourPenetration > 0) {
		specialMitigation.armourPenetration = {
			value: armourPenetration,
		};
	}

	const packet = new DamagePacket({
		id: existingPacket?.id ?? null,
		rawAmount: nonNegativeInteger(rollState.generatedDamage),
		unmitigatedAmount: nonNegativeInteger(
			rollState.unmitigatedDamageModifier,
		),
		targetActorUuid: defender.uuid,
		source: existingPacket?.source ?? {
			kind: "combat-attack",
			id: String(message.id),
			uuid: String(message.uuid ?? `ChatMessage.${message.id}`),
			label: String(attack.weapon?.name ?? "Melee attack"),
		},
		armour: existingPacket?.mitigation?.armour ?? mitigationPolicy(
			rollState.armourMitigation,
		),
		toughness: existingPacket?.mitigation?.toughness ?? mitigationPolicy(
			rollState.toughnessMitigation,
		),
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
		version: Math.max(5, Number(rollState.version) || 0),
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

async function waitForDamageRollClear(message, originalRoll) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const current = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		if (!current) return true;
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

function finishReconciliation(messageId, snapshot) {
	if (reconciliations.get(messageId) === snapshot) {
		reconciliations.delete(messageId);
	}
	if (snapshot?.suspensionKey) {
		WfrpRuleSettings.resumeDamageAutomation(snapshot.suspensionKey);
	}
}

function hasAppliedDamage(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return false;
	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	return actor instanceof foundry.documents.Actor &&
		DamageApplication.transactionFor(actor, state.packet.id)?.state === "applied";
}

function hitLocationFromAttackRoll(value) {
	const roll = normalizedD100(value);
	const digits = roll === 100 ? "00" : String(roll).padStart(2, "0");
	const reversed = Number(`${digits[1]}${digits[0]}`) || 100;
	if (reversed <= 15) return "head";
	if (reversed <= 35) return "rightArm";
	if (reversed <= 55) return "leftArm";
	if (reversed <= 80) return "body";
	if (reversed <= 90) return "rightLeg";
	return "leftLeg";
}

function normalizedD100(value) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > 100) {
		throw new Error(`Attack d100 must be an integer from 1 to 100; received '${value}'.`);
	}
	return number;
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

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function mitigationPolicy(value) {
	return value === DAMAGE_MITIGATION_POLICY.IGNORE
		? DAMAGE_MITIGATION_POLICY.IGNORE
		: DAMAGE_MITIGATION_POLICY.APPLY;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
