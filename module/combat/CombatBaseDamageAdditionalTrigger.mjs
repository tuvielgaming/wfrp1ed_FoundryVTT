import { TestResultChat } from "../tests/TestResultChat.mjs";
import {
	canEditCombatDamageDiceTotal,
	requestCombatDamageDiceTotalUpdate,
} from "./CombatDamageIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-base-damage-six-trigger-request";
const SOCKET_RESPONSE_TYPE = "combat-base-damage-six-trigger-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingRequests = new Map();
const activeTransitions = new Set();

/*
 * Physical-dice bridge for the one rule boundary a summed damage override cannot
 * express by itself: an initial melee damage d6 of 6 triggers the Core Additional
 * Damage WS confirmation Test.
 *
 * The ordinary Damage-card editor still owns the numeric damage total. This
 * module intervenes only when a physical correction crosses the base-d6 value 6:
 *
 * - 1..5 -> 6: record 6 as the adjudicated initial die and publish the normal,
 *   editable Additional Damage WS confirmation Test.
 * - 6 -> 1..5: the trigger no longer exists, so remove the derived Additional
 *   Damage Test and its exploding dice, then rebuild damage from the corrected
 *   base d6.
 *
 * Values >= 6 entered after Additional Damage has actually been triggered remain
 * ordinary summed-dice overrides. We do not attempt to reconstruct individual
 * physical dice from that sum.
 *
 * CombatAdjudicationReconciliation remains responsible for edits of the WS Test
 * and for the subsequent exploding d6 rolls. This module therefore owns only the
 * trigger boundary, not a second copy of Additional Damage mechanics.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		decorateBaseDamageBoundary(message, html);
		setTimeout(() => decorateBaseDamageBoundary(message, html), 0);
	});
});

Hooks.once("ready", () => {
	game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
});

function decorateBaseDamageBoundary(message, html) {
	const sourceMessage = sourceAttackMessage(message);
	if (!sourceMessage) return;

	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!isBoundaryEditableState(rollState) || !damageState?.packet?.id) return;
	if (!canEditCombatDamageDiceTotal(sourceMessage, game.user)) return;

	const root = asElement(html);
	if (!root) return;
	const inputs = [
		...root.querySelectorAll?.(
			"[data-wfrp-damage-dice-total], [data-wfrp-base-damage-d6-input]",
		) ?? [],
	];
	for (const input of inputs) {
		if (!(input instanceof HTMLInputElement)) continue;
		if (input.dataset.wfrpAdditionalDamageBoundary === "true") continue;
		input.dataset.wfrpAdditionalDamageBoundary = "true";
		input.addEventListener(
			"change",
			(event) => captureBoundaryChange(event, sourceMessage, input),
			{ capture: true },
		);
	}
}

function captureBoundaryChange(event, sourceMessage, input) {
	const value = Number(input.value);
	if (!isD6(value)) return;

	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!shouldHandleBoundaryTransition(rollState, value)) return;

	/* Prevent the ordinary summed-total listener from committing the same change
	 * first. Crossing 6 must reconcile the Additional Damage branch atomically. */
	event.preventDefault();
	event.stopImmediatePropagation();
	input.disabled = true;
	input.readOnly = true;

	void requestBaseDamageBoundaryChange(sourceMessage, value)
		.catch((error) => {
			console.error(
				"WFRP1ED | Unable to reconcile Additional Damage trigger boundary.",
				error,
			);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to reconcile the Additional Damage trigger.",
					"Nie udało się uzgodnić wyzwalacza Obrażeń dodatkowych.",
				),
			);
		})
		.finally(() => {
			if (!input.isConnected) return;
			const current = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
			input.value = String(nonNegativeInteger(current?.diceTotal));
			const editable = canEditCombatDamageDiceTotal(sourceMessage, game.user);
			input.disabled = !editable;
			input.readOnly = !editable;
		});
}

async function requestBaseDamageBoundaryChange(message, value) {
	const normalized = d6Strict(value, "Base damage d6");
	if (!canEditCombatDamageDiceTotal(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to edit this damage roll.",
			"Nie masz uprawnień do edycji tego rzutu obrażeń.",
		));
	}
	if (game.user?.isGM) {
		return applyBaseDamageBoundaryAsAuthority(message, normalized, game.user);
	}
	return requestGmTransition(message, normalized);
}

async function applyBaseDamageBoundaryAsAuthority(message, value, requestingUser) {
	const actionKey = String(message?.id ?? "");
	if (!actionKey || activeTransitions.has(actionKey)) {
		throw new Error("This Additional Damage trigger transition is already being resolved.");
	}
	if (!canEditCombatDamageDiceTotal(message, requestingUser)) {
		throw new Error("The requesting user may not edit this damage roll.");
	}

	const normalized = d6Strict(value, "Base damage d6");
	const previous = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? {},
	);
	if (!shouldHandleBoundaryTransition(previous, normalized)) return previous;

	activeTransitions.add(actionKey);
	try {
		if (normalized === 6) {
			return await applyTriggerAsAuthority(
				message,
				previous,
				requestingUser,
			);
		}
		return await removeTriggerAsAuthority(
			message,
			previous,
			normalized,
			requestingUser,
		);
	} finally {
		activeTransitions.delete(actionKey);
	}
}

async function applyTriggerAsAuthority(message, previous, requestingUser) {
	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const attackTestState = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!attack || !attackTestState || !isSingleBaseDamageState(previous)) {
		throw new Error("This damage result is not a pending single base d6.");
	}
	if (Number(previous.initialDie) === 6) return previous;

	const attacker = actorFromUuidSync(attack?.attacker?.uuid);
	if (!(attacker instanceof foundry.documents.Actor)) {
		throw new Error("The attacking Actor is no longer available.");
	}

	let generatedTestMessage = null;
	try {
		const prepared = foundry.utils.deepClone(previous);
		applyInitialDieAdjudication(prepared, 6, requestingUser);
		prepared.damageDice = [6];
		prepared.diceTotal = 6;
		prepared.diceTotalOriginal = 6;
		clearSummedOverride(prepared);
		prepared.additionalDamage = emptyAdditionalDamage(true);
		prepared.updatedBy = String(requestingUser?.id ?? "");
		prepared.updatedAt = Date.now();

		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, prepared);
		/* Canonical Strength/Toughness/Armour/Parry/DamagePacket recalculation. */
		await requestCombatDamageDiceTotalUpdate(message, 6);

		const result = await attacker.rollTest("ws", {
			modifier: 0,
			ruleEffects: [],
			resultVisibility: attackTestState?.resultVisibility,
		});
		if (!result?.chatMessage) {
			throw new Error(
				"The Additional Damage WS Test did not produce its expected result.",
			);
		}
		generatedTestMessage = result.chatMessage;
		await markAdditionalDamageTest(
			generatedTestMessage,
			message,
			requestingUser,
		);

		/* Updating the marked Test intentionally hands off to
		 * CombatAdjudicationReconciliation. It reads the editable WS result, rolls
		 * exploding d6s on success, clears them on failure, and rebuilds damage. */
		return foundry.utils.deepFreeze(foundry.utils.deepClone(
			message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? prepared,
		));
	} catch (error) {
		if (generatedTestMessage?.canUserModify?.(game.user, "delete")) {
			await generatedTestMessage.delete().catch(() => {});
		}
		await restorePreviousDamageState(message, previous);
		throw error;
	}
}

async function removeTriggerAsAuthority(
	message,
	previous,
	value,
	requestingUser,
) {
	if (Number(previous.initialDie) !== 6) {
		throw new Error("Additional Damage is not currently triggered by the base d6.");
	}

	const testMessage = additionalDamageTestForAttack(message, previous);
	if (
		testMessage &&
		!testMessage.canUserModify?.(game.user, "delete")
	) {
		throw new Error(
			"The derived Additional Damage Test cannot be removed by the active GM.",
		);
	}

	try {
		const prepared = foundry.utils.deepClone(previous);
		applyInitialDieAdjudication(prepared, value, requestingUser);
		prepared.damageDice = [value];
		prepared.diceTotal = value;
		prepared.diceTotalOriginal = value;
		clearSummedOverride(prepared);
		prepared.additionalDamage = emptyAdditionalDamage(false);
		prepared.updatedBy = String(requestingUser?.id ?? "");
		prepared.updatedAt = Date.now();

		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, prepared);
		/* The same canonical recalculation path now rebuilds damage without any
		 * Additional Damage contribution. */
		await requestCombatDamageDiceTotalUpdate(message, value);

		if (testMessage) await testMessage.delete();

		return foundry.utils.deepFreeze(foundry.utils.deepClone(
			message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? prepared,
		));
	} catch (error) {
		await restorePreviousDamageState(message, previous);
		throw error;
	}
}

function applyInitialDieAdjudication(state, value, requestingUser) {
	const original = d6Strict(
		state.initialDieOriginal ?? state.initialDie,
		"Original base damage d6",
	);
	state.initialDieOriginal = original;
	state.initialDie = value;
	state.initialDieOverridden = value !== original;
	state.initialDieOverriddenBy = state.initialDieOverridden
		? String(requestingUser?.id ?? "")
		: null;
	state.initialDieOverriddenAt = state.initialDieOverridden
		? Date.now()
		: null;
}

function clearSummedOverride(state) {
	state.diceTotalOverridden = false;
	state.diceTotalOverriddenBy = null;
	state.diceTotalOverriddenAt = null;
}

function emptyAdditionalDamage(triggered) {
	return {
		triggered: triggered === true,
		testMessageId: null,
		testRoll: null,
		testTarget: null,
		testSucceeded: false,
		extraDice: [],
	};
}

async function markAdditionalDamageTest(testMessage, attackMessage, requestingUser) {
	const state = foundry.utils.deepClone(
		testMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY) ?? {},
	);
	if (!state || typeof state !== "object") {
		throw new Error("The Additional Damage WS Test has no result state.");
	}
	state.testName = localize("Additional Damage", "Obrażenia dodatkowe");
	state.updatedBy = String(requestingUser?.id ?? game.user?.id ?? "");
	state.updatedAt = Date.now();
	const content = await TestResultChat._render(state);
	await testMessage.update({
		content,
		[`flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`]: state,
		[`flags.${FLAG_SCOPE}.${ADDITIONAL_DAMAGE_FLAG_KEY}`]: {
			version: 1,
			attackMessageId: String(attackMessage?.id ?? ""),
			attackMessageUuid: String(attackMessage?.uuid ?? ""),
			createdAt: Date.now(),
		},
	});
}

async function restorePreviousDamageState(message, previous) {
	try {
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, previous);
		await requestCombatDamageDiceTotalUpdate(
			message,
			nonNegativeInteger(previous?.diceTotal),
		);
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, previous);
	} catch (rollbackError) {
		console.error(
			"WFRP1ED | Failed to restore damage after Additional Damage boundary error.",
			rollbackError,
		);
	}
}

function sourceAttackMessage(message) {
	if (message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return message;
	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.sourceAttackMessageId) return null;
	return game.messages?.get(String(view.sourceAttackMessageId)) ?? null;
}

function isBoundaryEditableState(state) {
	return isSingleBaseDamageState(state) || Number(state?.initialDie) === 6;
}

function isSingleBaseDamageState(state) {
	if (state?.status !== "resolved") return false;
	const dice = Array.isArray(state.damageDice) ? state.damageDice : [];
	if (dice.length !== 1) return false;
	return isD6(state.initialDie);
}

function shouldHandleBoundaryTransition(state, value) {
	if (state?.status !== "resolved" || !isD6(value)) return false;
	const initial = Number(state.initialDie);
	if (initial === 6) return value >= 1 && value <= 5;
	return value === 6 && isSingleBaseDamageState(state);
}

function additionalDamageTestForAttack(attackMessage, rollState) {
	const storedId = String(rollState?.additionalDamage?.testMessageId ?? "").trim();
	if (storedId) {
		const stored = game.messages?.get(storedId);
		if (stored) return stored;
	}

	const attackId = String(attackMessage?.id ?? "");
	if (!attackId) return null;
	return [...(game.messages ?? [])]
		.filter((message) => {
			const marker = message.getFlag?.(FLAG_SCOPE, ADDITIONAL_DAMAGE_FLAG_KEY);
			return String(marker?.attackMessageId ?? "") === attackId;
		})
		.sort((left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0))[0] ?? null;
}

async function requestGmTransition(message, value) {
	if (!game.socket) {
		throw new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		));
	}
	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to reconcile Additional Damage.",
			"Do uzgodnienia Obrażeń dodatkowych wymagany jest aktywny MG.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the Additional Damage transition in time.",
				"MG nie rozstrzygnął zmiany Obrażeń dodatkowych w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
			value,
		});
	});
}

async function handleSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === SOCKET_RESPONSE_TYPE) {
		handleSocketResponse(payload);
		return;
	}
	if (payload.type !== SOCKET_REQUEST_TYPE || !isPrimaryActiveGM()) return;

	const response = {
		type: SOCKET_RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		const requester = game.users?.get(String(payload.requestUserId ?? ""));
		const message = game.messages?.get(String(payload.messageId ?? ""));
		if (!requester?.active) throw new Error("The requesting user is not active.");
		if (!message) throw new Error("The requested attack message is unavailable.");
		response.result = await applyBaseDamageBoundaryAsAuthority(
			message,
			payload.value,
			requester,
		);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected Additional Damage boundary change.", error);
		response.error = error?.message ?? "Unable to reconcile Additional Damage.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleSocketResponse(payload) {
	if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;
	pendingRequests.delete(requestId);
	clearTimeout(pending.timeout);
	if (!payload.ok) {
		pending.reject(new Error(String(
			payload.error ?? "Unable to reconcile Additional Damage.",
		)));
		return;
	}
	pending.resolve(payload.result ?? null);
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

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(game.user?.isGM && primaryActiveGM()?.id === game.user.id);
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}

function d6Strict(value, label) {
	const number = Number(value);
	if (!isD6(number)) {
		throw new Error(`${label} must be an integer from 1 to 6.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
