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
import { CombatEquipment } from "./CombatEquipment.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const COMBAT_DAMAGE_HISTORY_FLAG_KEY = "combatDamageHistory";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-damage-roll-request";
const SOCKET_RESPONSE_TYPE = "combat-damage-roll-response";
const SOCKET_TIMEOUT_MS = 10000;

const rollingMessages = new Set();
const clearingMessages = new Set();
const pendingRequests = new Map();

/**
 * Core melee damage bridge.
 *
 * Attack and defence remain authoritative in their existing transactions. Once
 * a successful blow is allowed to continue to damage, this module derives the
 * hit location from the persisted attack d100, rolls Core damage, snapshots the
 * defender's Toughness/armour, and attaches a normal DamagePacket to the same
 * attack ChatMessage. The existing Apply Damage, detailed Critical Hit, and
 * rollback systems therefore continue the lifecycle without a second damage
 * implementation.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => void decorateCombatDamage(message, html));
});

Hooks.on("updateActor", (actor) => refreshDamageCardsForActor(actor));
Hooks.once("ready", () => registerSocket());

/* Applied damage must be rolled back before its source Test is adjudicated. */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	if (!testStateChanged(changes)) return;

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack) {
		if (hasAppliedDamage(message)) {
			ui.notifications.warn(localize(
				"Invalidate the applied damage before changing this attack result.",
				"Przed zmianą wyniku tego ataku unieważnij zastosowane obrażenia.",
			));
			return false;
		}
		return;
	}

	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	const attackMessage = defence?.attackMessageId
		? game.messages?.get(String(defence.attackMessageId))
		: null;
	if (attackMessage && hasAppliedDamage(attackMessage)) {
		ui.notifications.warn(localize(
			"Invalidate the applied damage before changing this defence result.",
			"Przed zmianą wyniku tej obrony unieważnij zastosowane obrażenia.",
		));
		return false;
	}
});

/*
 * If an unapplied damage result becomes stale because the attack/defence was
 * changed or reopened, archive the roll snapshot and remove the actionable
 * DamagePacket. A later valid defence may then roll a fresh damage transaction.
 */
Hooks.on("updateChatMessage", (message, changes) => {
	if (clearingMessages.has(message?.id)) return;

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family === "melee") {
		const attackChanged = attackStateChanged(changes);
		const testChanged = testStateChanged(changes);
		if (attackChanged || testChanged) {
			void reconcileAttackDamageAfterChange(
				message,
				testChanged
					? "attack-adjudication-changed"
					: "defence-state-changed",
			);
		}
		return;
	}

	if (!testStateChanged(changes)) return;
	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	const attackMessage = defence?.attackMessageId
		? game.messages?.get(String(defence.attackMessageId))
		: null;
	if (attackMessage) {
		void clearCurrentDamageIfReversible(
			attackMessage,
			"defence-adjudication-changed",
		);
	}
});

async function decorateCombatDamage(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const test = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (
		!attack ||
		!test ||
		attack.family !== "melee" ||
		attack.targetMode !== "defender"
	) return;

	const root = asElement(html);
	const attackPanel = root?.querySelector?.("[data-wfrp-combat-attack-context]");
	if (!attackPanel) return;
	attackPanel.querySelector?.("[data-wfrp-combat-damage]")?.remove();

	const attacker = actorFromUuidSync(attack.attacker?.uuid);
	const defender = actorFromUuidSync(attack.target?.uuid);
	if (!attacker || !defender || !canSeeDamage(attacker, defender, game.user)) {
		return;
	}

	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (!outcome) return;

	const panel = document.createElement("section");
	panel.className = "combat-damage-context";
	panel.dataset.wfrpCombatDamage = "";

	if (!outcome.attackHit) {
		panel.append(statusText(localize(
			"Attack misses — no damage.",
			"Atak chybia — brak obrażeń.",
		)));
		attackPanel.append(panel);
		return;
	}
	if (outcome.defenceStatus !== "resolved") return;
	if (outcome.dodgeSucceeded) {
		panel.append(statusText(localize(
			"Dodge Blow succeeded — no damage.",
			"Unik udany — brak obrażeń.",
		)));
		attackPanel.append(panel);
		return;
	}
	if (!outcome.continueToDamage) return;

	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const transaction = damageTransactionFor(message, damageState);
	const reverted = transaction?.state === "reverted";

	if (!damageState?.packet || !damageState?.resolution || !rollState || reverted) {
		const heading = document.createElement("div");
		heading.className = "combat-damage-context__heading";
		heading.textContent = localize("Damage resolution", "Rozstrzyganie obrażeń");
		panel.append(heading);

		if (reverted && damageState?.resolution && rollState) {
			panel.append(buildResolvedDamagePanel(
				message,
				damageState,
				rollState,
				defender,
			));
		}

		const button = document.createElement("button");
		button.type = "button";
		button.className = "combat-damage-roll-button";
		button.textContent = reverted
			? localize("Roll damage again", "Rzuć obrażenia ponownie")
			: localize("Roll damage", "Rzuć obrażenia");
		button.disabled = !canRequestDamageRoll(message, game.user);
		button.title = button.disabled
			? localize(
				"Only the GM or an OWNER of the attacker may roll this damage.",
				"Tylko MG albo Właściciel atakującego może rzucić obrażenia.",
			)
			: localize(
				"Resolve Core melee damage for this blow.",
				"Rozstrzygnij obrażenia tego ciosu według zasad podstawowych.",
			);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			button.disabled = true;
			void requestDamageRoll(message)
				.catch(reportDamageError)
				.finally(() => {
					if (button.isConnected) button.disabled = false;
				});
		});
		panel.append(button);
		attackPanel.append(panel);
		return;
	}

	panel.append(buildResolvedDamagePanel(message, damageState, rollState, defender));
	attackPanel.append(panel);
}

function buildResolvedDamagePanel(message, damageState, rollState, defender) {
	const root = document.createElement("div");
	root.className = "combat-damage-context__resolved";
	const resolution = damageState.resolution ?? {};
	const toughness = resolution.breakdown?.toughness ?? {};
	const armour = resolution.breakdown?.armour ?? {};
	const parry = resolution.breakdown?.parry ?? {};
	const transaction = DamageApplication.transactionFor(
		defender,
		damageState.packet?.id,
	);

	const heading = document.createElement("div");
	heading.className = "combat-damage-context__heading";
	const title = document.createElement("strong");
	title.textContent = localize("Damage", "Obrażenia");
	const amount = document.createElement("span");
	amount.textContent = String(resolution.finalAmount ?? 0);
	heading.append(title, amount);
	root.append(heading);

	root.append(
		detailRow(localize("Hit location", "Lokacja trafienia"), hitLocationLabel(rollState.hitLocation)),
		detailRow(localize("Damage dice", "Kości obrażeń"), damageDiceLabel(rollState)),
		detailRow(localize("Strength", "Siła"), signedInteger(rollState.strength)),
	);

	if (Number(rollState.weaponDamageModifier) !== 0) {
		root.append(detailRow(
			localize("Weapon modifier", "Modyfikator broni"),
			signedInteger(rollState.weaponDamageModifier),
		));
	}

	if (rollState.additionalDamage?.triggered) {
		const additional = rollState.additionalDamage;
		root.append(detailRow(
			localize("Additional Damage", "Dodatkowe obrażenia"),
			additional.testSucceeded
				? localize(
					`WS test succeeded${additional.extraDice?.length ? `; +${additional.extraDice.join(" + ")}` : ""}`,
					`Test WW udany${additional.extraDice?.length ? `; +${additional.extraDice.join(" + ")}` : ""}`,
				)
				: localize("WS test failed", "Test WW nieudany"),
		));
	}

	root.append(
		detailRow(localize("Before Toughness", "Przed Wytrzymałością"), String(damageState.packet?.rawAmount ?? 0)),
		detailRow(localize("Toughness", "Wytrzymałość"), `−${nonNegativeInteger(toughness.value)}`),
		detailRow(localize("Armour", "Pancerz"), armourLabel(armour)),
	);

	if (parry.applied === true) {
		root.append(detailRow(
			localize("Successful Parry", "Udane Parowanie"),
			localize(
				`−${nonNegativeInteger(parry.rolledReduction)} rolled; ${nonNegativeInteger(parry.absorbed)} stopped (${parry.itemName || "—"})`,
				`−${nonNegativeInteger(parry.rolledReduction)} na kości; zatrzymano ${nonNegativeInteger(parry.absorbed)} (${parry.itemName || "—"})`,
			),
		));
	}

	root.append(
		detailRow(localize("Final Wounds", "Końcowe obrażenia"), String(resolution.finalAmount ?? 0)),
	);

	const status = document.createElement("div");
	status.className = "combat-damage-context__status";
	if (transaction?.state === "applied") {
		status.classList.add("is-applied");
		status.textContent = localize(
			`Applied · Wounds ${transaction.woundsBefore} → ${transaction.woundsAfter}` +
				(Number(transaction.criticalValue) > 0 ? ` · Critical +${transaction.criticalValue}` : ""),
			`Zastosowano · Żywotność ${transaction.woundsBefore} → ${transaction.woundsAfter}` +
				(Number(transaction.criticalValue) > 0 ? ` · Krytyk +${transaction.criticalValue}` : ""),
		);
	} else if (transaction?.state === "reverted") {
		status.classList.add("is-reverted");
		status.textContent = localize(
			`REVERTED · Wounds restored ${transaction.woundsAfter} → ${transaction.woundsBefore}`,
			`COFNIĘTO · przywrócono Żywotność ${transaction.woundsAfter} → ${transaction.woundsBefore}`,
		);
	} else {
		status.textContent = DamageChat.canApplyMessage(message)
			? localize(
				"Ready — right-click this attack card and choose Apply Damage.",
				"Gotowe — kliknij kartę ataku prawym przyciskiem i wybierz Zastosuj obrażenia.",
			)
			: localize(
				"Damage resolved — awaiting an authorized user to apply it.",
				"Obrażenia rozstrzygnięte — oczekują na zastosowanie przez uprawnionego użytkownika.",
			);
	}
	root.append(status);
	return root;
}

async function requestDamageRoll(message) {
	if (!canRequestDamageRoll(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to roll damage for this attack.",
			"Nie masz uprawnień do rzutu obrażeń dla tego ataku.",
		));
	}
	if (game.user?.isGM) return resolveDamageAsAuthority(message, game.user);

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to resolve combat damage.",
			"Do rozstrzygnięcia obrażeń w walce wymagany jest aktywny MG.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve combat damage in time.",
				"MG nie rozstrzygnął obrażeń w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
		});
	});
}

async function resolveDamageAsAuthority(message, requestingUser) {
	if (!message?.id || rollingMessages.has(message.id)) {
		throw new Error("This attack damage is already being resolved.");
	}
	if (!canRequestDamageRoll(message, requestingUser)) {
		throw new Error("The requesting user may not roll damage for this attack.");
	}

	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const test = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (!attack || !test || !outcome) {
		throw new Error("This ChatMessage has no complete melee attack transaction.");
	}
	if (!outcome.attackHit || outcome.defenceStatus !== "resolved" || !outcome.continueToDamage) {
		throw new Error("This attack is not currently eligible for damage resolution.");
	}

	const existingDamage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (existingDamage) {
		if (damageTransactionFor(message, existingDamage)?.state !== "reverted") {
			throw new Error("Damage has already been resolved for this attack.");
		}
		await archiveAndClearCombatDamage(message, "damage-rerolled");
	}

	const attacker = await actorFromUuid(attack.attacker?.uuid);
	const defender = await actorFromUuid(attack.target?.uuid);
	if (!attacker || !defender) {
		throw new Error("The attacker or defender Actor is no longer available.");
	}
	const weapon = weaponFromAttack(attacker, attack);

	rollingMessages.add(message.id);
	try {
		const attackOutcome = TestResultChat._templateContext(test).result;
		const hitLocation = hitLocationFromAttackRoll(attackOutcome.roll);
		const initialRoll = await new Roll("1d6").evaluate({ allowInteractive: false });
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

		let parry = {
			succeeded: false,
			reduction: 0,
			itemName: "",
			itemUuid: "",
		};
		if (outcome.parrySucceeded) {
			const parryRoll = await new Roll("1d6").evaluate({ allowInteractive: false });
			await showRollAnimation(parryRoll, requestingUser);
			parry = {
				succeeded: true,
				reduction: d6Result(parryRoll, "Parry reduction die"),
				itemName: String(attack.defence?.itemName ?? ""),
				itemUuid: String(attack.defence?.itemUuid ?? ""),
			};
		}

		const strength = characteristicValue(attacker, "s", "Strength");
		const optionalWeaponModifiers =
			WfrpRuleSettings.usesOptionalWeaponModifiers();
		const weaponDamageModifier = optionalWeaponModifiers
			? integer(CombatEquipment.optionalWeaponModifiers(weapon)?.damage)
			: 0;
		const generatedDamage = Math.max(
			0,
			diceTotal + strength + weaponDamageModifier,
		);
		const toughness = characteristicValue(defender, "t", "Toughness");
		const armour = CombatEquipment.armourAt(defender, hitLocation);
		const specialMitigation = parry.succeeded
			? {
				parry: {
					reduction: parry.reduction,
					itemName: parry.itemName,
					itemUuid: parry.itemUuid,
				},
			}
			: {};

		const packet = new DamagePacket({
			rawAmount: generatedDamage,
			targetActorUuid: defender.uuid,
			source: {
				kind: "combat-attack",
				id: String(message.id),
				uuid: String(message.uuid ?? `ChatMessage.${message.id}`),
				label: String(attack.weapon?.name ?? "Melee attack"),
			},
			armour: DAMAGE_MITIGATION_POLICY.APPLY,
			toughness: DAMAGE_MITIGATION_POLICY.APPLY,
			hitLocation,
			specialMitigation,
			criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
		});
		const resolution = DamageResolver.resolve(packet, {
			toughness: { value: toughness },
			armour,
		});

		const rollState = {
			version: 3,
			status: "resolved",
			packetId: packet.id,
			attackMessageId: String(message.id),
			attackerUuid: String(attacker.uuid ?? ""),
			defenderUuid: String(defender.uuid ?? ""),
			hitLocation,
			attackRoll: Number(attackOutcome.roll),
			initialDie,
			damageDice,
			diceTotal,
			strength,
			weaponDamageModifier,
			optionalWeaponModifiersApplied: optionalWeaponModifiers,
			generatedDamage,
			parry,
			additionalDamage,
			rawAmount: generatedDamage,
			toughness,
			armour: foundry.utils.deepClone(armour),
			finalAmount: resolution.finalAmount,
			rolledBy: String(requestingUser?.id ?? game.user?.id ?? ""),
			resolvedBy: String(game.user?.id ?? ""),
			rolledAt: Date.now(),
		};

		await DamageChat.attach(message, { packet, resolution });
		try {
			await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, rollState);
		} catch (error) {
			await message.unsetFlag(FLAG_SCOPE, DAMAGE_FLAG_KEY).catch(() => {});
			throw error;
		}

		void ui.chat?.render?.({ force: true });
		return foundry.utils.deepFreeze(foundry.utils.deepClone(rollState));
	} finally {
		rollingMessages.delete(message.id);
	}
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

	/* Core p.122: one unmodified WS check, then exploding extra d6s. */
	const result = await attacker.rollTest("ws", {
		modifier: 0,
		ruleEffects: [],
		resultVisibility: attackTestState?.resultVisibility,
	});
	if (!result?.chatMessage) {
		throw new Error("The Additional Damage WS test did not produce its expected result.");
	}
	state.testMessageId = String(result.chatMessage.id ?? "");
	state.testRoll = Number(result.roll);
	state.testTarget = Number(result.target);
	state.testSucceeded = result.success === true;
	await markAdditionalDamageTest(result.chatMessage, attackMessage);

	if (!state.testSucceeded) return state;
	do {
		const roll = await new Roll("1d6").evaluate({ allowInteractive: false });
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
	if (!state || typeof state !== "object") return;
	state.testName = localize("Additional Damage", "Dodatkowe obrażenia");
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

function canRequestDamageRoll(message, user = game.user) {
	if (!message?.id || !user || rollingMessages.has(message.id)) return false;
	const existingDamage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (existingDamage && damageTransactionFor(message, existingDamage)?.state !== "reverted") {
		return false;
	}

	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const test = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!attack || !test || attack.family !== "melee" || attack.targetMode !== "defender") {
		return false;
	}
	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (!outcome?.attackHit || outcome.defenceStatus !== "resolved" || !outcome.continueToDamage) {
		return false;
	}
	if (user.isGM) return true;
	const attacker = actorFromUuidSync(attack.attacker?.uuid);
	return attacker?.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

async function reconcileAttackDamageAfterChange(message, reason) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState || !rollState) return;
	if (damageTransactionFor(message, damageState)?.state === "applied") return;

	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (
		reason === "attack-adjudication-changed" ||
		!outcome?.attackHit ||
		outcome.defenceStatus !== "resolved" ||
		!outcome.continueToDamage
	) {
		await archiveAndClearCombatDamage(message, reason);
	}
}

async function clearCurrentDamageIfReversible(message, reason) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState || !rollState) return;
	if (damageTransactionFor(message, damageState)?.state === "applied") return;
	await archiveAndClearCombatDamage(message, reason);
}

async function archiveAndClearCombatDamage(message, reason) {
	if (!message?.id || clearingMessages.has(message.id)) return;
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState && !rollState) return;

	clearingMessages.add(message.id);
	try {
		const existing = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_HISTORY_FLAG_KEY);
		const history = Array.isArray(existing)
			? foundry.utils.deepClone(existing)
			: [];
		history.push({
			version: 1,
			reason: String(reason ?? "superseded"),
			invalidatedAt: Date.now(),
			damage: damageState ? foundry.utils.deepClone(damageState) : null,
			roll: rollState ? foundry.utils.deepClone(rollState) : null,
		});
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_HISTORY_FLAG_KEY, history);
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

function hasAppliedDamage(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	return damageTransactionFor(message, state)?.state === "applied";
}

function damageTransactionFor(message, damageState = null) {
	const state = damageState ?? message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return null;
	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	if (!actor) return null;
	return DamageApplication.transactionFor(actor, state.packet.id);
}

function refreshDamageCardsForActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		if (String(state?.packet?.targetActorUuid ?? "") !== String(actor.uuid ?? "")) {
			continue;
		}
		const entry = document.querySelector(`[data-message-id="${message.id}"]`);
		if (entry) requestAnimationFrame(() => void decorateCombatDamage(message, entry));
	}
}

function registerSocket() {
	if (!game.socket) return;
	game.socket.on(SOCKET_CHANNEL, (payload) => void handleSocketPayload(payload));
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
		response.result = await resolveDamageAsAuthority(message, requester);
		response.ok = true;
	} catch (error) {
		console.error("WFRP1ED | GM rejected combat damage request.", error);
		response.error = error?.message ?? "Unable to resolve combat damage.";
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
		pending.reject(new Error(String(payload.error ?? "Unable to resolve combat damage.")));
		return;
	}
	pending.resolve(payload.result ?? null);
}

function hitLocationFromAttackRoll(value) {
	const roll = Number(value);
	if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
		throw new Error(`Attack d100 must be an integer from 1 to 100; received '${value}'.`);
	}
	const digits = roll === 100 ? "00" : String(roll).padStart(2, "0");
	const reversedDigits = `${digits[1]}${digits[0]}`;
	const reversed = Number(reversedDigits) === 0 ? 100 : Number(reversedDigits);
	if (reversed <= 15) return "head";
	if (reversed <= 35) return "rightArm";
	if (reversed <= 55) return "leftArm";
	if (reversed <= 80) return "body";
	if (reversed <= 90) return "rightLeg";
	return "leftLeg";
}

function hitLocationLabel(location) {
	switch (String(location ?? "")) {
		case "head": return localize("Head", "Głowa");
		case "rightArm": return localize("Right Arm", "Prawe ramię");
		case "leftArm": return localize("Left Arm", "Lewe ramię");
		case "body": return localize("Body", "Korpus");
		case "rightLeg": return localize("Right Leg", "Prawa noga");
		case "leftLeg": return localize("Left Leg", "Lewa noga");
		default: return String(location ?? "—");
	}
}

function damageDiceLabel(state) {
	const dice = Array.isArray(state.damageDice)
		? state.damageDice.map((value) => nonNegativeInteger(value))
		: [];
	return dice.length
		? `${dice.join(" + ")} = ${dice.reduce((sum, value) => sum + value, 0)}`
		: "—";
}

function armourLabel(armour) {
	const value = nonNegativeInteger(armour?.value);
	if (armour?.leather?.ignoredByHighDamage === true) {
		return localize(
			`−${value} (leather ignored: blow was 4+)`,
			`−${value} (skóra pominięta: cios zadał 4+)`,
		);
	}
	return `−${value}`;
}

function detailRow(labelText, valueText) {
	const row = document.createElement("div");
	row.className = "combat-damage-context__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = String(valueText ?? "—");
	row.append(label, value);
	return row;
}

function statusText(text) {
	const element = document.createElement("div");
	element.className = "combat-damage-context__status";
	element.textContent = text;
	return element;
}

function characteristicValue(actor, id, label) {
	const value = Number(actor.getCharacteristicValue?.(id));
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return value;
}

function weaponFromAttack(attacker, attack) {
	const uuid = String(attack?.weapon?.uuid ?? "").trim();
	const weapon = actorDocumentFromUuidSync(uuid);
	if (
		weapon?.documentName !== "Item" ||
		weapon.type !== "weapon" ||
		weapon.parent?.uuid !== attacker.uuid
	) {
		throw new Error(
			"The melee attack Weapon is no longer available on the attacker.",
		);
	}
	return weapon;
}

function actorDocumentFromUuidSync(uuid) {
	try {
		return foundry.utils.fromUuidSync(String(uuid ?? "").trim()) ?? null;
	} catch (_error) {
		return null;
	}
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
			"WFRP1ED | Dice So Nice could not animate a combat damage roll.",
			error,
		);
	}
}

function d6Result(roll, label) {
	const value = Number(roll?.total);
	if (!Number.isInteger(value) || value < 1 || value > 6) {
		throw new Error(`${label} must resolve to an integer from 1 to 6.`);
	}
	return value;
}

async function actorFromUuid(uuid) {
	const value = String(uuid ?? "").trim();
	if (!value || typeof globalThis.fromUuid !== "function") return null;
	try {
		const document = await globalThis.fromUuid(value);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
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

function canSeeDamage(attacker, defender, user) {
	if (!user) return false;
	if (user.isGM) return true;
	const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	return attacker.testUserPermission?.(user, owner) === true ||
		defender.testUserPermission?.(user, owner) === true;
}

function attackStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${ATTACK_FLAG_KEY}`;
	return Object.hasOwn(changes, path) || foundry.utils.getProperty(changes, path) !== undefined;
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) || foundry.utils.getProperty(changes, path) !== undefined;
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(game.user?.isGM && primaryActiveGM()?.id === game.user.id);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function signedInteger(value) {
	const number = integer(value);
	return number >= 0 ? `+${number}` : String(number);
}

function reportDamageError(error) {
	console.error("WFRP1ED | Unable to resolve combat damage.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to resolve combat damage.",
		"Nie udało się rozstrzygnąć obrażeń w walce.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
