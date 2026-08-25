import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import { DamagePacket } from "../damage/DamagePacket.mjs";
import { PeriodicDirectDamageEngine } from "../damage/PeriodicDirectDamageEngine.mjs";
import { synchronizeFatalStatus } from "../criticals/FatalCriticalIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const PARRY_ECONOMY_FLAG_KEY = "attackEconomy";
const DODGE_ECONOMY_FLAG_KEY = "dodgeEconomy";
const AUTHORIZED_DAMAGE_APPLICATION_OPTION =
	"wfrp1edAuthorizedDamageApplication";
const DEFENCE_RESOLVED_STATUS = "resolved";
const DEFENCE_INVALIDATED_STATUS = "invalidated";
const DAMAGE_REVERTED_STATE = "reverted";

const { DialogV2 } = foundry.applications.api;

installDefenceResourceSnapshots();
installDamageRevertedPresentation();

Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;

	menuItems.push(
		{
			label: localize("Invalidate defence", "Unieważnij obronę"),
			icon: '<i class="fa-solid fa-rotate-left"></i>',
			visible: (target) => canInvalidateDefenceMessage(
				messageFromContextTarget(target),
			),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void invalidateDefenceMessage(message);
			},
		},
		{
			label: localize("Invalidate damage", "Unieważnij obrażenia"),
			icon: '<i class="fa-solid fa-heart-circle-plus"></i>',
			visible: (target) => canInvalidateDamageMessage(
				messageFromContextTarget(target),
			),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void invalidateDamageMessage(message);
			},
		},
	);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	decorateInvalidatedDefence(message, html);
	decorateRevertedDamage(message, html);
});

/**
 * Wrap the existing authoritative defence commit without changing its rule
 * implementation. For managed Parry/Dodge responses we capture the exact
 * Combatant flag state immediately before and after the successful transaction.
 * A later GM rollback can therefore restore the previous state without guessing
 * how Default Parry, Optional Parry, Shield Full Defence, or Dodge affected it.
 */
function installDefenceResourceSnapshots() {
	if (CombatDefenceTransaction.__wfrpRollbackSnapshotInstalled === true) return;

	const original = CombatDefenceTransaction.commitResponse;
	CombatDefenceTransaction.commitResponse = async function wrappedCommitResponse(
		message,
		response,
		itemUuid,
		requestingUser,
	) {
		const responseId = String(response ?? "");
		const resourceFlagKey = defenceResourceFlagKey(responseId);
		let combatant = null;
		let before = null;

		if (resourceFlagKey) {
			const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
			const defender = await actorFromAttackState(attackState);
			combatant = combatantForActor(defender);
			if (combatant) {
				before = flagSnapshot(combatant, resourceFlagKey);
			}
		}

		const result = await original.call(
			this,
			message,
			response,
			itemUuid,
			requestingUser,
		);

		const attackState = mutableObject(
			message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY),
		);
		const defence = attackState?.defence;
		if (
			!resourceFlagKey ||
			defence?.status !== DEFENCE_RESOLVED_STATUS ||
			defence.managedByCombat !== true ||
			!combatant ||
			!before
		) {
			return result;
		}

		const after = flagSnapshot(combatant, resourceFlagKey);
		if (!after) return result;

		const resourceTransaction = {
			version: 1,
			kind: responseId,
			flagKey: resourceFlagKey,
			combatId: String(combatant.parent?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			before,
			after,
			capturedAt: Date.now(),
		};

		attackState.defence = {
			...defence,
			resourceTransaction: foundry.utils.deepClone(resourceTransaction),
		};
		await message.update({
			[`flags.${FLAG_SCOPE}.${ATTACK_FLAG_KEY}`]: attackState,
		});

		const defenceMessage = game.messages?.get(
			String(defence.testMessageId ?? ""),
		);
		const defenceResult = mutableObject(
			defenceMessage?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY),
		);
		if (defenceMessage && defenceResult) {
			defenceResult.resourceTransaction =
				foundry.utils.deepClone(resourceTransaction);
			await defenceMessage.update({
				[`flags.${FLAG_SCOPE}.${DEFENCE_RESULT_FLAG_KEY}`]: defenceResult,
			});
		}

		return result;
	};

	Object.defineProperty(
		CombatDefenceTransaction,
		"__wfrpRollbackSnapshotInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/** Keep reverted damage cards non-actionable and clearly labelled. */
function installDamageRevertedPresentation() {
	if (DamageChat.__wfrpRollbackPresentationInstalled === true) return;

	const originalCanApply = DamageChat.canApplyMessage;
	DamageChat.canApplyMessage = function patchedCanApplyMessage(
		message,
		user = game.user,
	) {
		const state = this._stateFromMessage(message);
		const actor = state ? this._targetActorSync(state) : null;
		const transaction = actor && state
			? DamageApplication.transactionFor(actor, state.packet.id)
			: null;
		if (transaction?.state === DAMAGE_REVERTED_STATE) return false;
		return originalCanApply.call(this, message, user);
	};

	const originalCanApplyState = DamageChat.canApplyMessageState;
	DamageChat.canApplyMessageState = function patchedCanApplyMessageState(
		state,
		actor,
		user = game.user,
	) {
		const transaction = actor && state?.packet?.id
			? DamageApplication.transactionFor(actor, state.packet.id)
			: null;
		if (transaction?.state === DAMAGE_REVERTED_STATE) return false;
		return originalCanApplyState.call(this, state, actor, user);
	};

	const originalStatusLabel = DamageChat._statusLabel;
	DamageChat._statusLabel = function patchedStatusLabel(
		state,
		actor,
		transaction,
	) {
		if (transaction?.state === DAMAGE_REVERTED_STATE) {
			return localize(
				`REVERTED · restored Wounds ${transaction.woundsAfter} → ${transaction.woundsBefore}`,
				`COFNIĘTO · przywrócono Żywotność ${transaction.woundsAfter} → ${transaction.woundsBefore}`,
			);
		}
		return originalStatusLabel.call(this, state, actor, transaction);
	};

	Object.defineProperty(
		DamageChat,
		"__wfrpRollbackPresentationInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function canInvalidateDefenceMessage(message) {
	if (!game.user?.isGM || !message?.id) return false;
	const resultState = message.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	if (!isObject(resultState) || resultState.invalidated === true) return false;
	if (!new Set(["parry", "dodge"]).has(String(resultState.response ?? ""))) {
		return false;
	}

	const attackMessage = game.messages?.get(
		String(resultState.attackMessageId ?? ""),
	);
	const attackState = attackMessage?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const defence = attackState?.defence;
	if (
		!attackMessage ||
		defence?.status !== DEFENCE_RESOLVED_STATUS ||
		String(defence.testMessageId ?? "") !== String(message.id)
	) {
		return false;
	}

	const defenderUuid = String(
		resultState.defenderUuid ?? attackState?.target?.uuid ?? "",
	);
	const latest = latestResolvedDefenceForActor(defenderUuid);
	if (!latest || String(latest.attackMessage.id) !== String(attackMessage.id)) {
		return false;
	}

	if (
		defence.managedByCombat === true &&
		!isObject(defence.resourceTransaction ?? resultState.resourceTransaction)
	) {
		return false;
	}

	return true;
}

async function invalidateDefenceMessage(defenceMessage) {
	try {
		if (!game.user?.isGM) {
			throw new Error("Only a GM can invalidate a defence transaction.");
		}

		const resultState = mutableObject(
			defenceMessage?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY),
		);
		if (!resultState) {
			throw new Error("This ChatMessage is not a resolved defence Test.");
		}

		const attackMessage = game.messages?.get(
			String(resultState.attackMessageId ?? ""),
		);
		const attackState = mutableObject(
			attackMessage?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY),
		);
		const defence = attackState?.defence;
		if (
			!attackMessage ||
			defence?.status !== DEFENCE_RESOLVED_STATUS ||
			String(defence.testMessageId ?? "") !== String(defenceMessage.id)
		) {
			throw new Error("The linked defence is no longer the active resolved defence.");
		}

		const defender = await actorFromAttackState(attackState);
		if (!(defender instanceof foundry.documents.Actor)) {
			throw new Error("The defending Actor is no longer available.");
		}

		const latest = latestResolvedDefenceForActor(defender.uuid);
		if (!latest || latest.attackMessage.id !== attackMessage.id) {
			throw new Error(
				"Only the latest defence transaction for this Actor can be invalidated.",
			);
		}

		const resourceTransaction = mutableObject(
			defence.resourceTransaction ?? resultState.resourceTransaction,
		);
		preflightResourceRollback(defence, resourceTransaction);

		const linkedDamage = linkedAppliedDamageMessages(
			attackMessage,
			defenceMessage,
			defender,
		);
		preflightDamageCascade(defender, linkedDamage);

		const cascadeSummary = damageCascadeSummary(linkedDamage);
		const confirmed = await DialogV2.confirm({
			window: {
				title: localize("Invalidate defence", "Unieważnij obronę"),
			},
			content: confirmationContent({
				defender,
				defence,
				cascadeSummary,
			}),
		});
		if (!confirmed) return;

		let restoredWounds = 0;
		let removedCriticalWounds = 0;
		for (const entry of linkedDamage) {
			const reverted = await revertDamageMessage(entry.message, {
				reason: "defence-invalidated",
				skipLatestCheck: true,
			});
			restoredWounds += Number(reverted?.transaction?.amountApplied ?? 0);
			removedCriticalWounds += Number(reverted?.removedCriticalWounds ?? 0);
		}

		await restoreDefenceResource(defence, resourceTransaction);

		const invalidatedAt = Date.now();
		const invalidatedDefence = {
			...foundry.utils.deepClone(defence),
			status: DEFENCE_INVALIDATED_STATUS,
			invalidatedAt,
			invalidatedBy: String(game.user?.id ?? ""),
		};
		const history = Array.isArray(attackState.defenceHistory)
			? foundry.utils.deepClone(attackState.defenceHistory)
			: [];
		history.push(invalidatedDefence);
		attackState.defenceHistory = history;
		delete attackState.defence;
		attackState.updatedBy = game.user?.id ?? "";
		attackState.updatedAt = invalidatedAt;

		resultState.invalidated = true;
		resultState.invalidatedAt = invalidatedAt;
		resultState.invalidatedBy = String(game.user?.id ?? "");

		await attackMessage.update({
			[`flags.${FLAG_SCOPE}.${ATTACK_FLAG_KEY}`]: attackState,
		});
		await defenceMessage.update({
			[`flags.${FLAG_SCOPE}.${DEFENCE_RESULT_FLAG_KEY}`]: resultState,
		});

		void defender.sheet?.render?.();
		void ui.chat?.render?.({ force: true });

		const resourceLabel = defence.response === "dodge"
			? localize("Dodge Blow attempt refunded", "Próba Uniku została zwrócona")
			: localize("Parry resource refunded", "Zasób parowania został zwrócony");
		const damageLabel = linkedDamage.length > 0
			? localize(
				` ${linkedDamage.length} damage transaction(s) reverted; ${restoredWounds} Wounds restored.`,
				` Cofnięto ${linkedDamage.length} transakcji obrażeń; przywrócono ${restoredWounds} Żywotności.`,
			)
			: "";
		const criticalLabel = removedCriticalWounds > 0
			? localize(
				` Removed ${removedCriticalWounds} linked Critical Wound(s).`,
				` Usunięto ${removedCriticalWounds} powiązanych Ran Krytycznych.`,
			)
			: "";
		ui.notifications.info(
			`${localize("Defence invalidated", "Obrona unieważniona")}: ${defender.name}. ${resourceLabel}.${damageLabel}${criticalLabel}`,
		);
	} catch (error) {
		console.error("WFRP1ED | Unable to invalidate defence transaction.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to invalidate the defence transaction.",
				"Nie udało się unieważnić transakcji obrony.",
			),
		);
	}
}

function canInvalidateDamageMessage(message) {
	if (!game.user?.isGM || !message?.id) return false;
	const state = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!isObject(state?.packet)) return false;
	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return false;
	const transaction = DamageApplication.transactionFor(actor, state.packet.id);
	if (transaction?.state !== "applied") return false;
	const latest = latestAppliedDamageTransaction(actor);
	return latest?.packetId === String(state.packet.id ?? "");
}

async function invalidateDamageMessage(message) {
	try {
		if (!game.user?.isGM) {
			throw new Error("Only a GM can invalidate applied damage.");
		}

		const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		const actor = actorFromUuidSync(state?.packet?.targetActorUuid);
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error("The damage target Actor is unavailable.");
		}
		const transaction = DamageApplication.transactionFor(actor, state.packet.id);
		if (transaction?.state !== "applied") {
			throw new Error("This damage transaction is not currently applied.");
		}
		const latest = latestAppliedDamageTransaction(actor);
		if (latest?.packetId !== String(state.packet.id ?? "")) {
			throw new Error(
				"Only the latest applied damage transaction for this Actor can be invalidated.",
			);
		}
		preflightSingleDamage(actor, transaction);

		const criticalCount = linkedCriticalWounds(actor, state.packet.id).length;
		const confirmed = await DialogV2.confirm({
			window: {
				title: localize("Invalidate damage", "Unieważnij obrażenia"),
			},
			content: `<p>${escapeHtml(localize(
				`Invalidate the latest damage on ${actor.name}? This will restore Wounds ${transaction.woundsAfter} → ${transaction.woundsBefore}${criticalCount > 0 ? ` and remove ${criticalCount} linked Critical Wound(s)` : ""}.`,
				`Unieważnić ostatnie obrażenia postaci ${actor.name}? Przywróci to Żywotność ${transaction.woundsAfter} → ${transaction.woundsBefore}${criticalCount > 0 ? ` i usunie ${criticalCount} powiązanych Ran Krytycznych` : ""}.`,
			))}</p>`,
		});
		if (!confirmed) return;

		const reverted = await revertDamageMessage(message, {
			reason: "gm-invalidated",
		});
		void ui.chat?.render?.({ force: true });

		ui.notifications.info(localize(
			`Damage invalidated for ${actor.name}. Restored ${reverted.transaction.amountApplied} Wounds${reverted.removedCriticalWounds > 0 ? ` and removed ${reverted.removedCriticalWounds} Critical Wound(s)` : ""}.`,
			`Obrażenia postaci ${actor.name} unieważnione. Przywrócono ${reverted.transaction.amountApplied} Żywotności${reverted.removedCriticalWounds > 0 ? ` i usunięto ${reverted.removedCriticalWounds} Ran Krytycznych` : ""}.`,
		));
	} catch (error) {
		console.error("WFRP1ED | Unable to invalidate damage transaction.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to invalidate damage.",
				"Nie udało się unieważnić obrażeń.",
			),
		);
	}
}

function preflightResourceRollback(defence, transaction) {
	if (defence.managedByCombat !== true) return;
	if (!transaction) {
		throw new Error(
			"This defence predates safe rollback snapshots and cannot be automatically refunded.",
		);
	}
	const combat = game.combats?.get(String(transaction.combatId ?? ""));
	const combatant = combat?.combatants?.get(String(transaction.combatantId ?? ""));
	if (!combatant) {
		throw new Error("The Combatant used by this defence is no longer available.");
	}
	const current = flagSnapshot(combatant, transaction.flagKey);
	if (!sameSnapshot(current, transaction.after)) {
		throw new Error(
			"The defender resource state changed after this defence. Revert newer dependent actions first.",
		);
	}
}

async function restoreDefenceResource(defence, transaction) {
	if (defence.managedByCombat !== true) return;
	preflightResourceRollback(defence, transaction);
	const combat = game.combats.get(String(transaction.combatId));
	const combatant = combat.combatants.get(String(transaction.combatantId));
	await combatant.setFlag(
		FLAG_SCOPE,
		String(transaction.flagKey),
		foundry.utils.deepClone(transaction.before),
	);
}

function linkedAppliedDamageMessages(attackMessage, defenceMessage, defender) {
	const linked = [];
	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		if (!isObject(state?.packet)) continue;
		if (String(state.packet.targetActorUuid ?? "") !== String(defender.uuid)) {
			continue;
		}
		if (!damageSourceMatches(state.packet.source, attackMessage, defenceMessage)) {
			continue;
		}
		const transaction = DamageApplication.transactionFor(
			defender,
			state.packet.id,
		);
		if (transaction?.state !== "applied") continue;
		linked.push({ message, state, transaction });
	}
	linked.sort((first, second) =>
		(Number(second.transaction.appliedAt) - Number(first.transaction.appliedAt)) ||
		String(second.transaction.id ?? "").localeCompare(String(first.transaction.id ?? "")),
	);
	return linked;
}

function preflightDamageCascade(actor, linkedDamage) {
	if (linkedDamage.length === 0) return;
	const applied = appliedDamageTransactions(actor);
	if (applied.length < linkedDamage.length) {
		throw new Error("Linked damage history is no longer available for safe rollback.");
	}

	for (let index = 0; index < linkedDamage.length; index += 1) {
		if (applied[index]?.packetId !== linkedDamage[index]?.transaction?.packetId) {
			throw new Error(
				"A newer damage transaction exists for this Actor. Invalidate newer damage first.",
			);
		}
		preflightFatalRollback(actor, linkedDamage[index].transaction);
	}

	let expectedWounds = readRemainingWounds(actor);
	for (const entry of linkedDamage) {
		if (expectedWounds !== Number(entry.transaction.woundsAfter)) {
			throw new Error(
				"Current Wounds no longer match the linked damage history. Newer/manual Wounds changes must be resolved first.",
			);
		}
		expectedWounds = Number(entry.transaction.woundsBefore);
	}
}

function preflightSingleDamage(actor, transaction) {
	const latest = latestAppliedDamageTransaction(actor);
	if (latest?.packetId !== String(transaction.packetId ?? "")) {
		throw new Error(
			"Only the latest applied damage transaction for this Actor can be invalidated.",
		);
	}
	if (readRemainingWounds(actor) !== Number(transaction.woundsAfter)) {
		throw new Error(
			"Current Wounds differ from the recorded post-damage value. Revert newer/manual Wounds changes first.",
		);
	}
	preflightFatalRollback(actor, transaction);
}

function preflightFatalRollback(actor, transaction) {
	const packetId = String(transaction?.packetId ?? "");
	if (!packetId) return;
	const fatal = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY)?.[packetId];
	if (fatal?.state !== "applied") return;
	const fate = objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY)?.[packetId];
	if (isObject(fate)) {
		throw new Error(localize(
			"This fatal Critical has already consumed a Fate Point. Revert the Fate intervention before invalidating its damage.",
			"To śmiertelne trafienie krytyczne zużyło już Punkt Przeznaczenia. Przed unieważnieniem jego obrażeń cofnij interwencję Punktu Przeznaczenia.",
		));
	}
}

async function revertDamageMessage(message, {
	reason,
	skipLatestCheck = false,
} = {}) {
	const state = mutableObject(message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY));
	if (!state?.packet?.id) {
		throw new Error("The linked ChatMessage does not contain damage state.");
	}
	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The damage target Actor is no longer available.");
	}
	const transaction = DamageApplication.transactionFor(actor, state.packet.id);
	if (transaction?.state !== "applied") {
		throw new Error("The linked damage transaction is no longer applied.");
	}
	if (!skipLatestCheck) preflightSingleDamage(actor, transaction);
	else if (readRemainingWounds(actor) !== Number(transaction.woundsAfter)) {
		throw new Error("Linked damage is no longer at the top of the Wounds history.");
	}
	if (skipLatestCheck) preflightFatalRollback(actor, transaction);

	const criticalWounds = linkedCriticalWounds(actor, state.packet.id);
	if (criticalWounds.length > 0) {
		await actor.deleteEmbeddedDocuments(
			"Item",
			criticalWounds.map((item) => item.id),
		);
	}

	const applications = mutableObject(
		actor.getFlag?.(FLAG_SCOPE, DAMAGE_APPLICATIONS_FLAG_KEY),
	) ?? {};
	const revertedAt = Date.now();
	const reverted = {
		...foundry.utils.deepClone(transaction),
		state: DAMAGE_REVERTED_STATE,
		revertedAt,
		revertedBy: String(game.user?.id ?? ""),
		revertReason: String(reason ?? "gm-invalidated"),
	};
	applications[String(state.packet.id)] = foundry.utils.deepClone(reverted);

	const fatalApplications = mutableObject(
		actor.getFlag?.(FLAG_SCOPE, FATAL_APPLICATIONS_FLAG_KEY),
	) ?? {};
	const fatalApplication = fatalApplications[String(state.packet.id)];
	if (fatalApplication?.state === "applied") {
		fatalApplications[String(state.packet.id)] = {
			...foundry.utils.deepClone(fatalApplication),
			state: "reverted",
			revertedAt,
			revertedBy: String(game.user?.id ?? ""),
			revertReason: String(reason ?? "damage-invalidated"),
		};
	}

	const actorChanges = {
		"system.status.wounds.value": Number(transaction.woundsBefore),
		[`flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`]: applications,
	};
	if (fatalApplication?.state === "applied") {
		actorChanges[`flags.${FLAG_SCOPE}.${FATAL_APPLICATIONS_FLAG_KEY}`] =
			fatalApplications;
	}

	await actor.update(
		actorChanges,
		{ [AUTHORIZED_DAMAGE_APPLICATION_OPTION]: true },
	);
	if (fatalApplication?.state === "applied") {
		await synchronizeFatalStatus(actor);
	}

	state.application = foundry.utils.deepClone(reverted);
	state.updatedBy = game.user?.id ?? "";
	state.updatedAt = Date.now();
	await message.update({
		[`flags.${FLAG_SCOPE}.${DAMAGE_FLAG_KEY}`]: state,
	});
	DamageChat.refreshVisibleMessage(message);
	try {
		await PeriodicDirectDamageEngine.handleRevertedDamage({
			actor,
			packet: DamagePacket.fromJSON(state.packet),
		});
	} catch (error) {
		console.error(
			"WFRP1ED | Damage was reverted, but its periodic-effect lifecycle could not be synchronized.",
			error,
		);
		ui.notifications.error(
			game.i18n.lang === "pl"
				? "Obrażenia cofnięto, ale nie udało się zsynchronizować powiązanego efektu okresowego."
				: "Damage was reverted, but its linked periodic effect could not be synchronized.",
		);
	}

	return {
		transaction: reverted,
		removedCriticalWounds: criticalWounds.length,
		fatalCriticalReverted: fatalApplication?.state === "applied",
	};
}

function latestResolvedDefenceForActor(actorUuid) {
	const uuid = String(actorUuid ?? "");
	if (!uuid) return null;
	const candidates = [];
	let sequence = 0;
	for (const attackMessage of game.messages ?? []) {
		sequence += 1;
		const attackState = attackMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const defence = attackState?.defence;
		if (String(attackState?.target?.uuid ?? "") !== uuid) continue;
		if (defence?.status !== DEFENCE_RESOLVED_STATUS) continue;
		candidates.push({
			attackMessage,
			attackState,
			defence,
			resolvedAt: Number(defence.resolvedAt) || 0,
			sequence,
		});
	}
	candidates.sort((first, second) =>
		(second.resolvedAt - first.resolvedAt) ||
		(second.sequence - first.sequence),
	);
	return candidates[0] ?? null;
}

function latestAppliedDamageTransaction(actor) {
	return appliedDamageTransactions(actor)[0] ?? null;
}

function appliedDamageTransactions(actor) {
	const applications = actor?.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_APPLICATIONS_FLAG_KEY,
	);
	if (!isObject(applications)) return [];
	return Object.entries(applications)
		.map(([packetId, transaction]) => ({
			...foundry.utils.deepClone(transaction),
			packetId: String(transaction?.packetId ?? packetId),
		}))
		.filter((entry) => entry.state === "applied")
		.sort((first, second) =>
			(Number(second.appliedAt) - Number(first.appliedAt)) ||
			String(second.id ?? "").localeCompare(String(first.id ?? "")),
		);
}

function linkedCriticalWounds(actor, packetId) {
	const id = String(packetId ?? "");
	return [...(actor?.items ?? [])].filter((item) =>
		item?.type === "criticalWound" &&
		String(item.system?.resolution?.damagePacketId ?? "") === id,
	);
}

function damageSourceMatches(source, attackMessage, defenceMessage) {
	if (!isObject(source)) return false;
	const ids = new Set([
		String(attackMessage?.id ?? ""),
		String(defenceMessage?.id ?? ""),
	].filter(Boolean));
	const uuids = new Set([
		String(attackMessage?.uuid ?? ""),
		String(defenceMessage?.uuid ?? ""),
		attackMessage?.id ? `ChatMessage.${attackMessage.id}` : "",
		defenceMessage?.id ? `ChatMessage.${defenceMessage.id}` : "",
	].filter(Boolean));
	return ids.has(String(source.id ?? "")) ||
		uuids.has(String(source.uuid ?? ""));
}

function damageCascadeSummary(linkedDamage) {
	if (linkedDamage.length === 0) return null;
	const wounds = linkedDamage.reduce(
		(sum, entry) => sum + Number(entry.transaction.amountApplied ?? 0),
		0,
	);
	const criticals = linkedDamage.reduce(
		(sum, entry) => sum + linkedCriticalWounds(
			actorFromUuidSync(entry.state.packet.targetActorUuid),
			entry.state.packet.id,
		).length,
		0,
	);
	return { count: linkedDamage.length, wounds, criticals };
}

function confirmationContent({ defender, defence, cascadeSummary }) {
	const response = defence.response === "dodge"
		? localize("Dodge Blow", "Unik")
		: localize(`Parry with ${defence.itemName ?? "weapon"}`, `Parowanie: ${defence.itemName ?? "broń"}`);
	const lines = [
		localize(
			`Invalidate the latest defence for ${defender.name}: ${response}? The defence resource will be refunded and the attack will return to pending defence.`,
			`Unieważnić ostatnią obronę postaci ${defender.name}: ${response}? Zasób obrony zostanie zwrócony, a atak ponownie będzie oczekiwał na wybór obrony.`,
		),
	];
	if (cascadeSummary) {
		lines.push(localize(
			`This will also automatically revert ${cascadeSummary.count} linked damage transaction(s), restore ${cascadeSummary.wounds} Wounds${cascadeSummary.criticals > 0 ? `, and remove ${cascadeSummary.criticals} linked Critical Wound(s)` : ""}.`,
			`Automatycznie cofnięte zostaną także ${cascadeSummary.count} powiązane transakcje obrażeń, przywrócone ${cascadeSummary.wounds} punkty Żywotności${cascadeSummary.criticals > 0 ? ` oraz usunięte ${cascadeSummary.criticals} powiązane Rany Krytyczne` : ""}.`,
		));
	}
	return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function decorateInvalidatedDefence(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	if (state?.invalidated !== true) return;
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!card || card.querySelector("[data-wfrp-defence-invalidated]")) return;
	card.classList.add("is-wfrp-transaction-invalidated");
	const notice = document.createElement("div");
	notice.className = "wfrp-transaction-invalidated";
	notice.dataset.wfrpDefenceInvalidated = "";
	notice.textContent = localize(
		"INVALIDATED — resource refunded; linked attack reopened",
		"UNIEWAŻNIONO — zasób zwrócony; powiązany atak ponownie otwarty",
	);
	const panel = card.querySelector("[data-wfrp-combat-defence-result]");
	if (panel) panel.prepend(notice);
	else card.prepend(notice);
}

function decorateRevertedDamage(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return;
	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, state.packet.id)
		: null;
	if (transaction?.state !== DAMAGE_REVERTED_STATE) return;
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	card?.classList.add("is-wfrp-transaction-reverted");
}

function defenceResourceFlagKey(response) {
	if (response === "parry") return PARRY_ECONOMY_FLAG_KEY;
	if (response === "dodge") return DODGE_ECONOMY_FLAG_KEY;
	return null;
}

function flagSnapshot(combatant, key) {
	const value = combatant?.getFlag?.(FLAG_SCOPE, String(key ?? ""));
	return isObject(value) ? foundry.utils.deepClone(value) : null;
}

function sameSnapshot(first, second) {
	return stableJson(first) === stableJson(second);
}

function stableJson(value) {
	return JSON.stringify(stableValue(value));
}

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])]),
	);
}

async function actorFromAttackState(attackState) {
	const uuid = String(attackState?.target?.uuid ?? "").trim();
	if (!uuid || typeof globalThis.fromUuid !== "function") return null;
	try {
		const document = await globalThis.fromUuid(uuid);
		return document?.documentName === "Actor"
			? document
			: document?.actor ?? null;
	} catch (_error) {
		return null;
	}
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return document?.documentName === "Actor"
			? document
			: document?.actor ?? null;
	} catch (_error) {
		return null;
	}
}

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started || !actor) return null;
	const exact = [...combat.combatants].filter(
		(entry) => entry.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];
	const sameId = [...combat.combatants].filter(
		(entry) => entry.actor?.id && actor.id && entry.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(
		entry?.dataset?.messageId ??
			target?.attr?.("data-message-id") ??
			target?.data?.("message-id") ??
			"",
	).trim();
	return messageId ? game.messages?.get(messageId) ?? null : null;
}

function readRemainingWounds(actor) {
	const value = Number(actor?.system?.status?.wounds?.value);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		throw new Error("The Actor has no valid remaining Wounds value.");
	}
	return Math.max(0, value);
}

function objectFlag(actor, key) {
	const value = actor?.getFlag?.(FLAG_SCOPE, key);
	return isObject(value) ? value : {};
}

function mutableObject(value) {
	return isObject(value) ? foundry.utils.deepClone(value) : null;
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
