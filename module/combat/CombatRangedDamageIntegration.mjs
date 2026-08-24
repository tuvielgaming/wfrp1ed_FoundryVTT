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
import { CombatEquipment } from "./CombatEquipment.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const COMBAT_DAMAGE_HISTORY_FLAG_KEY = "combatDamageHistory";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const DAMAGE_DETAILS_PUBLIC_FLAG_KEY = "combatDamageDetailsPublic";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-ranged-damage-roll-request";
const SOCKET_RESPONSE_TYPE = "combat-ranged-damage-roll-response";
const SOCKET_TIMEOUT_MS = 10000;

const activeActions = new Set();
const clearingMessages = new Set();
const pendingRequests = new Map();
const queuedAutomaticActions = new Set();

/**
 * Core WFRP 1e missile-damage bridge.
 *
 * The ranged attack already owns the authoritative BS Test, target, weapon
 * Effective Strength and range snapshot. This layer adds the damage procedure
 * without creating a second damage application model:
 *
 *   d6 + weapon Effective Strength + range damage modifier
 *   -> Toughness -> armour -> Wounds
 *
 * Core p.126 states that hit location and Additional Damage use the same
 * procedure as hand-to-hand combat. Missile fire has no melee Parry damage
 * reduction transaction.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		void decorateRangedDamage(message, html);
		decorateRangedDamageResultView(message, html);
		setTimeout(() => decorateRangedDamageResultView(message, html), 0);
	});
});

Hooks.on("updateActor", (actor) => refreshRangedDamageCardsForActor(actor));

Hooks.on("updateChatMessage", (message, changes) => {
	if (clearingMessages.has(message?.id)) return;

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family !== "ranged") return;

	const attackChanged = attackStateChanged(changes);
	const testChanged = testStateChanged(changes);
	if (!attackChanged && !testChanged) return;
	if (!canMutateCombatDamageMessage(message)) return;

	void reconcileRangedDamageAfterChange(
		message,
		testChanged
			? "attack-adjudication-changed"
			: "range-adjudication-changed",
	);
});

Hooks.once("ready", () => registerSocket());

async function decorateRangedDamage(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const test = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (
		attack?.family !== "ranged" ||
		attack.targetMode !== "defender" ||
		!test
	) {
		return;
	}

	const root = asElement(html);
	const attackPanel = root?.querySelector?.("[data-wfrp-combat-attack-context]");
	if (!attackPanel) return;

	attackPanel.querySelector?.("[data-wfrp-ranged-damage]")?.remove();

	const attacker = actorFromUuidSync(attack.attacker?.uuid);
	const defender = actorFromUuidSync(attack.target?.uuid);
	if (!attacker || !defender || !canSeeDamage(attacker, defender, game.user)) {
		return;
	}

	const outcome = TestResultChat._templateContext(test).result;
	const panel = document.createElement("section");
	panel.className = "combat-damage-context";
	panel.dataset.wfrpCombatDamage = "";
	panel.dataset.wfrpRangedDamage = "";

	if (!outcome.success) {
		panel.append(statusText(localize(
			"Attack misses — no damage.",
			"Atak chybia — brak obrażeń.",
		)));
		attackPanel.append(panel);
		return;
	}

	if (attack.range?.automatic === true && attack.range?.legal === false) {
		panel.append(statusText(localize(
			"Attack is outside the weapon's maximum range — no damage.",
			"Atak jest poza maksymalnym zasięgiem broni — brak obrażeń.",
		)));
		attackPanel.append(panel);
		return;
	}

	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const transaction = damageTransactionFor(message, damageState);
	const reverted = transaction?.state === "reverted";

	if (
		damageState?.packet &&
		damageState?.resolution &&
		rollState?.status === "resolved" &&
		!reverted
	) {
		panel.append(statusText(localize(
			"Damage is shown on the separate Damage card.",
			"Obrażenia są pokazane na osobnej karcie Obrażeń.",
		)));
		attackPanel.append(panel);
		return;
	}

	const heading = document.createElement("div");
	heading.className = "combat-damage-context__heading";
	heading.textContent = localize(
		"Ranged damage resolution",
		"Rozstrzyganie obrażeń dystansowych",
	);
	panel.append(heading);

	if (reverted) {
		panel.append(statusText(localize(
			"Previous damage was reverted. Roll damage again from the preserved ranged attack.",
			"Poprzednie obrażenia cofnięto. Rzuć obrażenia ponownie dla zachowanego ataku dystansowego.",
		)));
	}

	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button";
	button.textContent = reverted
		? localize("Roll damage again", "Rzuć obrażenia ponownie")
		: localize("Roll damage", "Rzuć obrażenia");
	button.disabled = !canRequestRangedDamageRoll(message, game.user);
	button.title = button.disabled
		? localize(
			"Only the GM or an OWNER of the attacker may roll this damage.",
			"Tylko MG albo Właściciel atakującego może rzucić obrażenia.",
		)
		: localize(
			"Resolve Core missile damage: d6 + Effective Strength + range modifier.",
			"Rozstrzygnij obrażenia strzeleckie: K6 + Siła efektywna + modyfikator zasięgu.",
		);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		button.disabled = true;
		void requestRangedDamageRoll(message)
			.catch(reportDamageError)
			.finally(() => {
				if (button.isConnected) {
					button.disabled = !canRequestRangedDamageRoll(
						message,
						game.user,
					);
				}
			});
	});
	panel.append(button);
	attackPanel.append(panel);

	maybeQueueAutomaticDamage(message, attacker);
}

async function requestRangedDamageRoll(message) {
	if (activeActions.has(actionId(message, "damage"))) return null;
	if (!canRequestRangedDamageRoll(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to roll damage for this ranged attack.",
			"Nie masz uprawnień do rzutu obrażeń dla tego ataku dystansowego.",
		));
	}

	if (game.user?.isGM) {
		return resolveRangedDamageAsAuthority(message, game.user);
	}
	return requestGmDamageRoll(message);
}

async function resolveRangedDamageAsAuthority(message, requestingUser) {
	const actionKey = actionId(message, "damage");
	if (!message?.id || activeActions.has(actionKey)) {
		throw new Error("This ranged attack damage is already being resolved.");
	}
	if (!canRequestRangedDamageRoll(message, requestingUser)) {
		throw new Error(
			"The requesting user may not roll damage for this ranged attack.",
		);
	}

	activeActions.add(actionKey);
	try {
		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const test = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (
			attack?.family !== "ranged" ||
			attack.targetMode !== "defender" ||
			!test
		) {
			throw new Error(
				"This ChatMessage has no complete ranged attack transaction.",
			);
		}

		const attackOutcome = TestResultChat._templateContext(test).result;
		if (!attackOutcome.success) {
			throw new Error(
				"This ranged attack currently misses and cannot cause damage.",
			);
		}
		if (attack.range?.automatic === true && attack.range?.legal === false) {
			throw new Error(
				"This ranged attack is outside the weapon's maximum range.",
			);
		}

		const existingDamage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		const existingRoll = message.getFlag?.(
			FLAG_SCOPE,
			COMBAT_DAMAGE_FLAG_KEY,
		);
		if (existingRoll && !existingDamage) {
			throw new Error(
				"This ranged damage roll already has unresolved state.",
			);
		}
		if (existingDamage) {
			if (damageTransactionFor(message, existingDamage)?.state !== "reverted") {
				throw new Error(
					"Damage has already been resolved for this ranged attack.",
				);
			}
			await archiveAndClearRangedDamage(message, "damage-rerolled");
		}

		const attacker = await actorFromUuid(attack.attacker?.uuid);
		const defender = await actorFromUuid(attack.target?.uuid);
		if (!attacker || !defender) {
			throw new Error(
				"The attacker or defender Actor is no longer available.",
			);
		}

		const hitLocation = hitLocationFromAttackRoll(attackOutcome.roll);
		const initialRoll = await new Roll("1d6").evaluate({
			allowInteractive: false,
		});
		await showRollAnimation(initialRoll, requestingUser);
		const initialDie = d6Result(initialRoll, "Initial damage die");
		const additionalDamage = await resolveAdditionalDamage(
			attacker,
			message,
			test,
			initialDie,
			requestingUser,
		);
		const damageDice = [initialDie, ...additionalDamage.extraDice];
		const diceTotal = damageDice.reduce((sum, value) => sum + value, 0);

		/*
		 * Ranged attacks persist Effective Strength and the resolved range damage
		 * modifier on the attack transaction. Damage therefore never substitutes
		 * the attacker's Strength or optional melee Weapon Modifiers.
		 */
		const strength = nonNegativeInteger(attack.weapon?.effectiveStrength);
		const weaponDamageModifier = integer(attack.range?.damageModifier);
		const generatedDamage = Math.max(
			0,
			diceTotal + strength + weaponDamageModifier,
		);
		const toughness = characteristicValue(defender, "t", "Toughness");
		const armour = CombatEquipment.armourAt(defender, hitLocation);
		const baseState = {
			version: 4,
			family: "ranged",
			status: "resolved",
			packetId: null,
			attackMessageId: String(message.id),
			attackerUuid: String(attacker.uuid ?? ""),
			defenderUuid: String(defender.uuid ?? ""),
			hitLocation,
			attackRoll: Number(attackOutcome.roll),
			initialDie,
			damageDice,
			diceTotal,
			diceTotalOriginal: diceTotal,
			diceTotalOverridden: false,
			strength,
			strengthSource: "weapon-effective-strength",
			weaponDamageModifier,
			modifierSource: "range",
			optionalWeaponModifiersApplied: false,
			generatedDamage,
			parry: {
				succeeded: false,
				reduction: null,
				itemName: "",
				itemUuid: "",
			},
			additionalDamage,
			rawAmount: generatedDamage,
			toughness,
			armour: foundry.utils.deepClone(armour),
			finalAmount: null,
			rolledBy: String(requestingUser?.id ?? game.user?.id ?? ""),
			resolvedBy: String(game.user?.id ?? ""),
			rolledAt: Date.now(),
		};

		return finalizeRangedDamage(message, baseState, attack, defender);
	} finally {
		activeActions.delete(actionKey);
	}
}

async function finalizeRangedDamage(message, rollState, attack, defender) {
	const packet = new DamagePacket({
		rawAmount: nonNegativeInteger(rollState.generatedDamage),
		targetActorUuid: defender.uuid,
		source: {
			kind: "combat-attack",
			id: String(message.id),
			uuid: String(message.uuid ?? `ChatMessage.${message.id}`),
			label: String(
				attack.weapon?.name ??
				localize("Ranged attack", "Atak dystansowy"),
			),
		},
		armour: DAMAGE_MITIGATION_POLICY.APPLY,
		toughness: DAMAGE_MITIGATION_POLICY.APPLY,
		hitLocation: rollState.hitLocation,
		specialMitigation: {},
		criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
	});
	const resolution = DamageResolver.resolve(packet, {
		toughness: { value: nonNegativeInteger(rollState.toughness) },
		armour: foundry.utils.deepClone(rollState.armour ?? {}),
	});
	const finalized = {
		...foundry.utils.deepClone(rollState),
		status: "resolved",
		packetId: packet.id,
		rawAmount: packet.rawAmount,
		finalAmount: resolution.finalAmount,
		resolvedBy: String(game.user?.id ?? ""),
		resolvedAt: Date.now(),
	};

	await DamageChat.attach(message, { packet, resolution });
	try {
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, finalized);
	} catch (error) {
		await message.unsetFlag(FLAG_SCOPE, DAMAGE_FLAG_KEY).catch(() => {});
		throw error;
	}

	void ui.chat?.render?.({ force: true });
	return foundry.utils.deepFreeze(foundry.utils.deepClone(finalized));
}

async function resolveAdditionalDamage(
	attacker,
	attackMessage,
	attackTestState,
	initialDie,
	requestingUser,
) {
	const state = {
		triggered: initialDie === 6,
		testMessageId: null,
		testRoll: null,
		testTarget: null,
		testSucceeded: false,
		extraDice: [],
	};
	if (initialDie !== 6) return state;

	/*
	 * Core pp.122 and 126: missile Additional Damage is resolved exactly as
	 * hand-to-hand Additional Damage — an unmodified WS Test followed by
	 * exploding d6s when that Test succeeds.
	 */
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

	state.testMessageId = String(result.chatMessage.id ?? "");
	state.testRoll = Number(result.roll);
	state.testTarget = Number(result.target);
	state.testSucceeded = result.success === true;
	await markAdditionalDamageTest(result.chatMessage, attackMessage);

	if (!state.testSucceeded) return state;

	do {
		const roll = await new Roll("1d6").evaluate({
			allowInteractive: false,
		});
		await showRollAnimation(roll, requestingUser);
		const die = d6Result(roll, "Additional damage die");
		state.extraDice.push(die);
		if (die !== 6) break;
	} while (true);

	return state;
}

async function markAdditionalDamageTest(testMessage, attackMessage) {
	const state = foundry.utils.deepClone(
		testMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY) ?? {},
	);
	if (!state || typeof state !== "object") {
		throw new Error(
			"The Additional Damage WS Test has no result state.",
		);
	}

	state.testName = localize("Additional Damage", "Obrażenia dodatkowe");
	state.updatedBy = game.user?.id ?? "";
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

function canRequestRangedDamageRoll(message, user = game.user) {
	if (
		!message?.id ||
		!user ||
		activeActions.has(actionId(message, "damage"))
	) {
		return false;
	}

	const existingDamage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const existingRoll = message.getFlag?.(
		FLAG_SCOPE,
		COMBAT_DAMAGE_FLAG_KEY,
	);
	if (
		existingDamage &&
		damageTransactionFor(message, existingDamage)?.state !== "reverted"
	) {
		return false;
	}
	if (existingRoll && !existingDamage) return false;

	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const test = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (
		attack?.family !== "ranged" ||
		attack.targetMode !== "defender" ||
		!test
	) {
		return false;
	}
	if (attack.range?.automatic === true && attack.range?.legal === false) {
		return false;
	}

	const outcome = TestResultChat._templateContext(test).result;
	if (!outcome.success) return false;

	if (user.isGM) return true;
	const attacker = actorFromUuidSync(attack.attacker?.uuid);
	return hasOwnerPermission(attacker, user);
}

function maybeQueueAutomaticDamage(message, attacker) {
	if (!canRequestRangedDamageRoll(message, game.user)) return;
	if (!shouldAutomaticallyRollForActor(attacker, game.user)) return;

	const key = actionId(message, "auto-damage");
	if (queuedAutomaticActions.has(key)) return;
	queuedAutomaticActions.add(key);

	queueMicrotask(() => {
		void requestRangedDamageRoll(message)
			.catch(reportDamageError)
			.finally(() => {
				setTimeout(() => queuedAutomaticActions.delete(key), 250);
			});
	});
}

function shouldAutomaticallyRollForActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (actorOwnedByPlayer(actor)) {
		return !user.isGM &&
			hasOwnerPermission(actor, user) &&
			WfrpRuleSettings.autoRollDamageForOwnedActors();
	}
	return user.isGM &&
		isPrimaryActiveGM() &&
		WfrpRuleSettings.autoRollDamageForGmActors();
}

async function reconcileRangedDamageAfterChange(message, reason) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState && !rollState) return;

	if (
		damageState &&
		damageTransactionFor(message, damageState)?.state === "applied"
	) {
		return;
	}

	await archiveAndClearRangedDamage(message, reason);
}

async function archiveAndClearRangedDamage(message, reason) {
	if (!message?.id || clearingMessages.has(message.id)) return;

	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState && !rollState) return;

	clearingMessages.add(message.id);
	try {
		const existing = message.getFlag?.(
			FLAG_SCOPE,
			COMBAT_DAMAGE_HISTORY_FLAG_KEY,
		);
		const history = Array.isArray(existing)
			? foundry.utils.deepClone(existing)
			: [];
		history.push({
			version: 1,
			reason: String(reason ?? "superseded"),
			invalidatedAt: Date.now(),
			damage: damageState
				? foundry.utils.deepClone(damageState)
				: null,
			roll: rollState
				? foundry.utils.deepClone(rollState)
				: null,
		});

		await message.setFlag(
			FLAG_SCOPE,
			COMBAT_DAMAGE_HISTORY_FLAG_KEY,
			history,
		);
		if (message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY)) {
			await message.unsetFlag(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		}
		if (message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY)) {
			await message.unsetFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		}
	} finally {
		clearingMessages.delete(message.id);
	}
}

async function requestGmDamageRoll(message) {
	if (!game.socket) {
		throw new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		));
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to resolve ranged damage.",
			"Do rozstrzygnięcia obrażeń dystansowych wymagany jest aktywny MG.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the ranged damage action in time.",
				"MG nie rozstrzygnął obrażeń dystansowych w wymaganym czasie.",
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

function registerSocket() {
	game.socket?.on?.(SOCKET_CHANNEL, (payload) => {
		void handleSocketPayload(payload);
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
		result: false,
		error: null,
	};

	try {
		const requester = game.users?.get(String(payload.requestUserId ?? ""));
		const message = game.messages?.get(String(payload.messageId ?? ""));
		if (!requester?.active) {
			throw new Error("The requesting user is not active.");
		}
		if (!message) {
			throw new Error("The requested ranged attack message is unavailable.");
		}

		await resolveRangedDamageAsAuthority(message, requester);
		response.ok = true;
		response.result = true;
	} catch (error) {
		console.error(
			"WFRP1ED | GM rejected ranged damage request.",
			error,
		);
		response.error =
			error?.message ?? "Unable to resolve ranged damage.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleSocketResponse(payload) {
	if (
		String(payload.requestUserId ?? "") !==
		String(game.user?.id ?? "")
	) {
		return;
	}

	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;

	pendingRequests.delete(requestId);
	clearTimeout(pending.timeout);

	if (!payload.ok) {
		pending.reject(new Error(String(
			payload.error ?? "Unable to resolve ranged damage.",
		)));
		return;
	}

	pending.resolve(true);
}

/*
 * CombatLifecyclePresentation creates the shared dedicated Damage card for any
 * attack carrying damageState + combatDamageRoll. Its legacy labels are melee
 * wording, so normalize only the ranged card here and apply the same private
 * diagnostic policy until the common presentation module is generalized.
 */
function decorateRangedDamageResultView(message, html) {
	const view = message?.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_RESULT_VIEW_FLAG_KEY,
	);
	if (!view?.sourceAttackMessageId) return;

	const sourceMessage = game.messages?.get(
		String(view.sourceAttackMessageId),
	);
	const attack = sourceMessage?.getFlag?.(
		FLAG_SCOPE,
		ATTACK_FLAG_KEY,
	);
	if (attack?.family !== "ranged") return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!(card instanceof HTMLElement)) return;

	relabelDamageRow(
		card,
		new Set(["Strength", "Siła"]),
		localize("Effective Strength", "Siła efektywna"),
	);
	relabelDamageRow(
		card,
		new Set(["Weapon modifier", "Modyfikator broni"]),
		localize("Range modifier", "Modyfikator zasięgu"),
	);

	applyRangedDamageAudiencePolicy(message, card, attack);
}

function relabelDamageRow(card, currentLabels, nextLabel) {
	for (const row of card.querySelectorAll?.(
		".wfrp1e-damage-card__row",
	) ?? []) {
		const label = row.querySelector?.(":scope > span");
		if (!label || !currentLabels.has(String(label.textContent ?? "").trim())) {
			continue;
		}
		label.textContent = nextLabel;
	}
}

function applyRangedDamageAudiencePolicy(message, card, attack) {
	const rows = [
		...(card.querySelectorAll?.(".wfrp1e-damage-card__row") ?? []),
	];
	for (const row of rows) row.hidden = false;

	if (
		game.user?.isGM ||
		message.getFlag?.(
			FLAG_SCOPE,
			DAMAGE_DETAILS_PUBLIC_FLAG_KEY,
		) === true
	) {
		return;
	}

	const attacker = actorFromUuidSync(attack?.attacker?.uuid);
	const defender = actorFromUuidSync(attack?.target?.uuid);
	const ownsAttacker = hasOwnerPermission(attacker, game.user);
	const ownsDefender = hasOwnerPermission(defender, game.user);

	const attackerLabels = new Set([
		"Effective Strength",
		"Siła efektywna",
		"Range modifier",
		"Modyfikator zasięgu",
		"Additional Damage",
		"Obrażenia dodatkowe",
		"Before Toughness",
		"Przed Wytrzymałością",
	]);
	const defenderLabels = new Set([
		"Toughness",
		"Wytrzymałość",
		"Armour",
		"Pancerz",
	]);
	const duplicateFinalLabels = new Set([
		"Final damage",
		"Końcowe obrażenia",
	]);

	for (const row of rows) {
		const label = String(
			row.querySelector?.(":scope > span")?.textContent ?? "",
		).trim();

		if (attackerLabels.has(label)) {
			row.hidden = !ownsAttacker;
		} else if (defenderLabels.has(label)) {
			row.hidden = !ownsDefender;
		} else if (duplicateFinalLabels.has(label)) {
			row.hidden = true;
		}
	}
}

function damageTransactionFor(message, damageState = null) {
	const state =
		damageState ??
		message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return null;

	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	if (!actor) return null;

	return DamageApplication.transactionFor(actor, state.packet.id);
}

function refreshRangedDamageCardsForActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (attack?.family !== "ranged") continue;

		const state = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		const roll = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		const relevant =
			String(state?.packet?.targetActorUuid ?? "") ===
				String(actor.uuid ?? "") ||
			String(roll?.attackerUuid ?? "") === String(actor.uuid ?? "") ||
			String(roll?.defenderUuid ?? "") === String(actor.uuid ?? "") ||
			String(attack?.attacker?.uuid ?? "") === String(actor.uuid ?? "") ||
			String(attack?.target?.uuid ?? "") === String(actor.uuid ?? "");

		if (!relevant) continue;

		const entry = document.querySelector(
			`[data-message-id="${cssEscape(message.id)}"]`,
		);
		if (entry) {
			requestAnimationFrame(() => {
				void decorateRangedDamage(message, entry);
			});
		}
	}
}

function hitLocationFromAttackRoll(value) {
	const roll = Number(value);
	if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
		throw new Error(
			`Attack d100 must be an integer from 1 to 100; received '${value}'.`,
		);
	}

	const digits =
		roll === 100 ? "00" : String(roll).padStart(2, "0");
	const reversedDigits = `${digits[1]}${digits[0]}`;
	const reversed =
		Number(reversedDigits) === 0 ? 100 : Number(reversedDigits);

	if (reversed <= 15) return "head";
	if (reversed <= 35) return "rightArm";
	if (reversed <= 55) return "leftArm";
	if (reversed <= 80) return "body";
	if (reversed <= 90) return "rightLeg";
	return "leftLeg";
}

function characteristicValue(actor, id, label) {
	const value = Number(actor.getCharacteristicValue?.(id));
	if (
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < 0
	) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return value;
}

async function showRollAnimation(roll, requestingUser) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;

	try {
		await game.dice3d.showForRoll(
			roll,
			requestingUser ?? game.user,
			true,
		);
	} catch (error) {
		console.warn(
			"WFRP1ED | Dice So Nice could not animate a ranged damage roll.",
			error,
		);
	}
}

function d6Result(roll, label) {
	const value = Number(roll?.total);
	if (!Number.isInteger(value) || value < 1 || value > 6) {
		throw new Error(
			`${label} must resolve to an integer from 1 to 6.`,
		);
	}
	return value;
}

async function actorFromUuid(uuid) {
	const value = String(uuid ?? "").trim();
	if (!value || typeof globalThis.fromUuid !== "function") return null;

	try {
		const document = await globalThis.fromUuid(value);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) {
			return document.actor;
		}
	} catch (_error) {
		return null;
	}
	return null;
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(
			String(uuid ?? "").trim(),
		);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) {
			return document.actor;
		}
	} catch (_error) {
		return null;
	}
	return null;
}

function hasOwnerPermission(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;

	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function actorOwnedByPlayer(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return [...(game.users ?? [])].some(
		(user) => !user?.isGM && hasOwnerPermission(actor, user),
	);
}

function canSeeDamage(attacker, defender, user) {
	if (!user) return false;
	if (user.isGM) return true;

	return (
		hasOwnerPermission(attacker, user) ||
		hasOwnerPermission(defender, user)
	);
}

function canMutateCombatDamageMessage(message) {
	if (!message?.id || !game.user) return false;

	const primary = primaryActiveGM();
	if (primary) {
		return Boolean(
			game.user.isGM &&
			String(game.user.id) === String(primary.id),
		);
	}
	return message.canUserModify?.(game.user, "update") === true;
}

function attackStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${ATTACK_FLAG_KEY}`;
	return (
		Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined
	);
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return (
		Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined
	);
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort(
			(first, second) =>
				String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(
		game.user?.isGM &&
		primaryActiveGM()?.id === game.user.id,
	);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function statusText(text) {
	const element = document.createElement("div");
	element.className = "combat-damage-context__status";
	element.textContent = text;
	return element;
}

function actionId(message, phase) {
	return `${String(message?.id ?? "")}:${phase}`;
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.max(0, Math.trunc(number))
		: 0;
}

function cssEscape(value) {
	if (globalThis.CSS?.escape) return CSS.escape(String(value ?? ""));
	return String(value ?? "").replace(/["\\]/g, "\\$&");
}

function reportDamageError(error) {
	console.error(
		"WFRP1ED | Unable to resolve ranged combat damage.",
		error,
	);
	ui.notifications.error(
		error?.message ??
		localize(
			"Unable to resolve ranged combat damage.",
			"Nie udało się rozstrzygnąć obrażeń dystansowych.",
		),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
