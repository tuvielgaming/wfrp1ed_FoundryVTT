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
const activeTriggers = new Set();

/*
 * Physical-dice bridge for the one rule boundary a summed damage override cannot
 * express by itself: an initial melee damage d6 of 6 triggers the Core Additional
 * Damage WS confirmation Test.
 *
 * The ordinary damage editor still owns the numeric damage total. This module
 * intervenes only when a pending single base d6 is manually changed from 1..5 to
 * 6. It records 6 as the adjudicated initial die, reuses the existing canonical
 * damage-total recalculation, then publishes the same editable Additional Damage
 * WS Test used by an originally-generated 6. CombatAdjudicationReconciliation
 * remains responsible for success/failure changes and the subsequent exploding
 * d6 rolls, so none of that rule logic is duplicated here.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		decorateBaseDamageSixTrigger(message, html);
		setTimeout(() => decorateBaseDamageSixTrigger(message, html), 0);
	});
});

Hooks.once("ready", () => {
	game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
});

function decorateBaseDamageSixTrigger(message, html) {
	const sourceMessage = sourceAttackMessage(message);
	if (!sourceMessage) return;

	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!isSingleBaseDamageState(rollState) || !damageState?.packet?.id) return;
	if (Number(rollState.initialDie) === 6) return;
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
		if (input.dataset.wfrpAdditionalDamageSixTrigger === "true") continue;
		input.dataset.wfrpAdditionalDamageSixTrigger = "true";
		input.addEventListener(
			"change",
			(event) => captureManualSix(event, sourceMessage, input),
			{ capture: true },
		);
	}
}

function captureManualSix(event, sourceMessage, input) {
	const value = Number(input.value);
	if (value !== 6) return;

	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!isSingleBaseDamageState(rollState) || Number(rollState.initialDie) === 6) {
		return;
	}

	/* Prevent the ordinary summed-total listener from committing the same change
	 * first. This special boundary must create the Additional Damage Test before
	 * the result can be considered fully reconciled. */
	event.preventDefault();
	event.stopImmediatePropagation();
	input.disabled = true;
	input.readOnly = true;

	void requestBaseDamageSixTrigger(sourceMessage)
		.catch((error) => {
			console.error(
				"WFRP1ED | Unable to trigger Additional Damage from manual base d6.",
				error,
			);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to trigger the Additional Damage Test.",
					"Nie udało się uruchomić testu Obrażeń dodatkowych.",
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

async function requestBaseDamageSixTrigger(message) {
	if (!canEditCombatDamageDiceTotal(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to edit this damage roll.",
			"Nie masz uprawnień do edycji tego rzutu obrażeń.",
		));
	}
	if (game.user?.isGM) {
		return applyBaseDamageSixTriggerAsAuthority(message, game.user);
	}
	return requestGmTrigger(message);
}

async function applyBaseDamageSixTriggerAsAuthority(message, requestingUser) {
	const actionKey = String(message?.id ?? "");
	if (!actionKey || activeTriggers.has(actionKey)) {
		throw new Error("This Additional Damage trigger is already being resolved.");
	}
	if (!canEditCombatDamageDiceTotal(message, requestingUser)) {
		throw new Error("The requesting user may not edit this damage roll.");
	}

	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const attackTestState = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	const previous = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? {},
	);
	if (!attack || !attackTestState || !isSingleBaseDamageState(previous)) {
		throw new Error("This damage result is not a pending single base d6.");
	}
	if (Number(previous.initialDie) === 6) return previous;

	const attacker = actorFromUuidSync(attack?.attacker?.uuid);
	if (!(attacker instanceof foundry.documents.Actor)) {
		throw new Error("The attacking Actor is no longer available.");
	}

	let generatedTestMessage = null;
	activeTriggers.add(actionKey);
	try {
		const prepared = foundry.utils.deepClone(previous);
		const originalInitialDie = d6Strict(
			prepared.initialDieOriginal ?? prepared.initialDie,
			"Original base damage d6",
		);
		prepared.initialDieOriginal = originalInitialDie;
		prepared.initialDie = 6;
		prepared.initialDieOverridden = originalInitialDie !== 6;
		prepared.initialDieOverriddenBy = prepared.initialDieOverridden
			? String(requestingUser?.id ?? "")
			: null;
		prepared.initialDieOverriddenAt = prepared.initialDieOverridden
			? Date.now()
			: null;
		prepared.damageDice = [6];
		prepared.diceTotal = 6;
		prepared.diceTotalOriginal = 6;
		prepared.diceTotalOverridden = false;
		prepared.diceTotalOverriddenBy = null;
		prepared.diceTotalOverriddenAt = null;
		prepared.additionalDamage = {
			triggered: true,
			testMessageId: null,
			testRoll: null,
			testTarget: null,
			testSucceeded: false,
			extraDice: [],
		};
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

		/* Updating the marked Test result intentionally hands off to
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
	} finally {
		activeTriggers.delete(actionKey);
	}
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
			"WFRP1ED | Failed to restore damage after Additional Damage trigger error.",
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

function isSingleBaseDamageState(state) {
	if (state?.status !== "resolved") return false;
	const dice = Array.isArray(state.damageDice) ? state.damageDice : [];
	if (dice.length !== 1) return false;
	return Number.isInteger(Number(state.initialDie)) &&
		Number(state.initialDie) >= 1 && Number(state.initialDie) <= 6;
}

async function requestGmTrigger(message) {
	if (!game.socket) {
		throw new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		));
	}
	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to trigger Additional Damage.",
			"Do uruchomienia Obrażeń dodatkowych wymagany jest aktywny MG.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the Additional Damage trigger in time.",
				"MG nie rozstrzygnął uruchomienia Obrażeń dodatkowych w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message?.id ?? ""),
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
		response.result = await applyBaseDamageSixTriggerAsAuthority(
			message,
			requester,
		);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected Additional Damage trigger.", error);
		response.error = error?.message ?? "Unable to trigger Additional Damage.";
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
			payload.error ?? "Unable to trigger Additional Damage.",
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

function d6Strict(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > 6) {
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
