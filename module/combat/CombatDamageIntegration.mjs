import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { DamageRuleEffects } from "../damage/DamageRuleEffects.mjs";
import {
	damageRuleEffectGroups,
	damageRuleSourceHeading,
} from "../damage/DamageRulePresentation.mjs";
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
const SOCKET_DAMAGE_REQUEST_TYPE = "combat-damage-roll-request";
const SOCKET_PARRY_REQUEST_TYPE = "combat-parry-damage-roll-request";
const SOCKET_OVERRIDE_REQUEST_TYPE = "combat-damage-total-override-request";
const SOCKET_RESPONSE_TYPE = "combat-damage-action-response";
const SOCKET_TIMEOUT_MS = 10000;

const activeActions = new Set();
const clearingMessages = new Set();
const pendingRequests = new Map();
const queuedAutomaticActions = new Set();

/**
 * Core melee damage bridge.
 *
 * Attack/Defence stay authoritative on the attack message. Damage is resolved
 * in stages so the Actor who owns a roll also owns the click that produces it:
 * the attacker rolls attack damage, while a defender who successfully parries
 * rolls the 1d6 reduction. GM-controlled Actors may automate both stages.
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
			"Przed zmianą wyniku tego obrony unieważnij zastosowane obrażenia.",
		));
		return false;
	}
});

/*
 * If an unapplied or partly-resolved damage result becomes stale because the
 * Attack/Defence changed, archive the snapshot and reopen the damage stage.
 *
 * updateChatMessage runs on every connected client. Only the primary active GM
 * (or, without a GM, a user who can update the source message) may mutate the
 * authoritative attack message. This prevents an owning defender from receiving
 * harmless-but-confusing permission errors when adjudicating their Parry Test.
 */
Hooks.on("updateChatMessage", (message, changes) => {
	if (clearingMessages.has(message?.id)) return;

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family === "melee") {
		const attackChanged = attackStateChanged(changes);
		const testChanged = testStateChanged(changes);
		if (attackChanged || testChanged) {
			if (!canMutateCombatDamageMessage(message)) return;
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
	if (attackMessage && canMutateCombatDamageMessage(attackMessage)) {
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

	if (rollState?.status === "awaiting-parry" && !damageState) {
		panel.append(buildPendingParryPanel(message, rollState, defender));
		attackPanel.append(panel);
		maybeQueueAutomaticParry(message, defender);
		return;
	}

	if (damageState?.packet && damageState?.resolution && rollState && !reverted) {
		panel.append(buildResolvedDamagePanel(
			message,
			damageState,
			rollState,
			defender,
		));
		attackPanel.append(panel);
		return;
	}

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
	maybeQueueAutomaticDamage(message, attacker);
}

function buildPendingParryPanel(message, rollState, defender) {
	const root = document.createElement("div");
	root.className = "combat-damage-context__pending-parry";

	const heading = document.createElement("div");
	heading.className = "combat-damage-context__heading";
	heading.textContent = localize(
		"Parry damage reduction",
		"Redukcja obrażeń przez parowanie",
	);
	root.append(heading);

	root.append(
		detailRow(
			localize("Damage before parry", "Obrażenia przed parowaniem"),
			String(nonNegativeInteger(rollState.generatedDamage)),
		),
		detailRow(
			localize("Parry", "Parowanie"),
			String(rollState.parry?.itemName || "—"),
		),
	);

	const status = statusText(localize(
		`${defender.name} rolls 1d6 to determine how much damage the successful parry stops.`,
		`${defender.name} rzuca 1k6, aby ustalić, ile obrażeń zatrzymuje udane parowanie.`,
	));
	root.append(status);

	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button";
	button.textContent = localize(
		"Roll parry reduction",
		"Rzuć redukcję parowania",
	);
	button.disabled = !canRequestParryRoll(message, game.user);
	button.title = button.disabled
		? localize(
			"Only the GM or an OWNER of the defender may roll this parry reduction.",
			"Tylko MG albo Właściciel broniącego się może rzucić redukcję parowania.",
		)
		: "";
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		button.disabled = true;
		void requestParryReductionRoll(message)
			.catch(reportDamageError)
			.finally(() => {
				if (button.isConnected) button.disabled = false;
			});
	});
	root.append(button);
	return root;
}

/**
 * The detailed damage data may remain on the Attack card for auditability, but
 * it is folded by default because the dedicated Damage card is the primary UI.
 */
function buildResolvedDamagePanel(message, damageState, rollState, defender) {
	const details = document.createElement("details");
	details.className = "combat-damage-context__resolved";
	const resolution = damageState.resolution ?? {};
	const toughness = resolution.breakdown?.toughness ?? {};
	const armour = resolution.breakdown?.armour ?? {};
	const parry = resolution.breakdown?.parry ?? {};
	const transaction = DamageApplication.transactionFor(
		defender,
		damageState.packet?.id,
	);

	const summary = document.createElement("summary");
	const title = document.createElement("strong");
	title.textContent = localize("Damage", "Obrażenia");
	const amount = document.createElement("span");
	amount.textContent = String(resolution.finalAmount ?? 0);
	summary.append(title, amount);
	details.append(summary);

	const body = document.createElement("div");
	body.className = "combat-damage-context__details-body";
	body.append(
		detailRow(localize("Hit location", "Lokacja trafienia"), hitLocationLabel(rollState.hitLocation)),
		detailRow(localize("Roll", "Rzut"), damageDiceLabel(rollState)),
		detailRow(localize("Strength", "Siła"), signedInteger(rollState.strength)),
	);

	if (Number(rollState.weaponDamageModifier) !== 0) {
		body.append(detailRow(
			localize("Weapon modifier", "Modyfikator broni"),
			signedInteger(rollState.weaponDamageModifier),
		));
	}

	const damageRuleGroups = appendDamageRuleDetails(
		body,
		rollState.damageRuleEffects,
	);
	if (damageRuleGroups === 0 && Number(rollState.ruleDamageModifier) !== 0) {
		body.append(detailRow(
			localize("Active Effect (damage)", "Aktywny Efekt (obrażenia)"),
			signedInteger(rollState.ruleDamageModifier),
		));
	}

	if (rollState.additionalDamage?.triggered) {
		const additional = rollState.additionalDamage;
		body.append(detailRow(
			localize("Additional Damage", "Dodatkowe obrażenia"),
			additional.testSucceeded
				? localize(
					`WS test succeeded${additional.extraDice?.length ? `; +${additional.extraDice.join(" + ")}` : ""}`,
					`Test WW udany${additional.extraDice?.length ? `; +${additional.extraDice.join(" + ")}` : ""}`,
				)
				: localize("WS test failed", "Test WW nieudany"),
		));
	}

	body.append(
		detailRow(localize("Before Toughness", "Przed Wytrzymałością"), String(damageState.packet?.rawAmount ?? 0)),
		detailRow(
			localize("Toughness", "Wytrzymałość"),
			mitigationLabel(toughness),
		),
		detailRow(localize("Armour", "Pancerz"), armourLabel(armour)),
	);

	if (parry.applied === true) {
		body.append(detailRow(
			localize("Parry", "Parowanie"),
			`${nonNegativeInteger(parry.absorbed)} (${parry.itemName || "—"})`,
		));
	}

	body.append(detailRow(
		localize("Final damage", "Końcowe obrażenia"),
		String(resolution.finalAmount ?? 0),
	));

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
	} else if (Number(resolution.finalAmount) <= 0) {
		status.classList.add("is-applied");
		status.textContent = localize(
			"No damage — resolved.",
			"Brak obrażeń — rozstrzygnięte.",
		);
	} else {
		status.textContent = localize(
			"Damage is shown on the separate Damage card.",
			"Obrażenia są pokazane na osobnej karcie Obrażeń.",
		);
	}
	body.append(status);
	details.append(body);
	return details;
}

async function requestDamageRoll(message) {
	/* A manual click and an already-queued automatic action may meet in one tick. */
	if (activeActions.has(actionId(message, "damage"))) return null;
	if (!canRequestDamageRoll(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to roll damage for this attack.",
			"Nie masz uprawnień do rzutu obrażeń dla tego ataku.",
		));
	}
	if (game.user?.isGM) return resolveDamageAsAuthority(message, game.user);
	return requestGmAction(SOCKET_DAMAGE_REQUEST_TYPE, message);
}

async function requestParryReductionRoll(message) {
	if (activeActions.has(actionId(message, "parry"))) return null;

	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (
		rollState?.status !== "awaiting-parry" ||
		rollState?.parry?.succeeded !== true ||
		message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY)
	) {
		throw new Error(localize(
			"Parry reduction is not ready. Resolve the attack damage first.",
			"Redukcja obrażeń przez parowanie nie jest jeszcze gotowa. Najpierw rozstrzygnij obrażenia ataku.",
		));
	}

	if (!canRequestParryRoll(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to roll this parry reduction.",
			"Nie masz uprawnień do rzutu redukcji tego parowania.",
		));
	}
	if (game.user?.isGM) return resolveParryAsAuthority(message, game.user);
	return requestGmAction(SOCKET_PARRY_REQUEST_TYPE, message);
}

/**
 * Request a manual replacement for the summed damage dice. Individual rolled
 * dice remain visible as audit data; only their total is overridden.
 */
export async function requestCombatDamageDiceTotalUpdate(message, total) {
	const normalized = nonNegativeIntegerStrict(total, "Damage dice total");
	if (!canEditCombatDamageDiceTotal(message, game.user)) {
		throw new Error(localize(
			"You are not allowed to edit this damage roll.",
			"Nie masz uprawnień do edycji tego rzutu obrażeń.",
		));
	}
	if (game.user?.isGM) {
		return applyDamageDiceTotalOverrideAsAuthority(
			message,
			normalized,
			game.user,
		);
	}
	return requestGmAction(
		SOCKET_OVERRIDE_REQUEST_TYPE,
		message,
		{ total: normalized },
	);
}

export function canEditCombatDamageDiceTotal(message, user = game.user) {
	if (!message?.id || !user) return false;
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (rollState?.status !== "resolved" || !damageState?.packet?.id) return false;
	if (damageTransactionFor(message, damageState)) return false;
	if (user.isGM) return true;
	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const attacker = actorFromUuidSync(attack?.attacker?.uuid);
	return hasOwnerPermission(attacker, user);
}

async function requestGmAction(type, message, extra = {}) {
	if (!game.socket) {
		throw new Error(localize(
			"The system socket is unavailable.",
			"Gniazdo systemu jest niedostępne.",
		));
	}
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
				"The GM did not resolve the damage action in time.",
				"MG nie rozstrzygnął akcji obrażeń w wymaganym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			messageId: String(message.id ?? ""),
			...extra,
		});
	});
}

async function resolveDamageAsAuthority(message, requestingUser) {
	const actionKey = actionId(message, "damage");
	if (!message?.id || activeActions.has(actionKey)) {
		throw new Error("This attack damage is already being resolved.");
	}
	if (!canRequestDamageRoll(message, requestingUser)) {
		throw new Error("The requesting user may not roll damage for this attack.");
	}

	/*
	 * Acquire the transaction lock before the first await. Previously Actor UUID
	 * resolution and rollback cleanup happened first, allowing a manual click and
	 * queued automation to both pass validation and each animate/commit a fresh
	 * initial d6 after damage invalidation.
	 */
	activeActions.add(actionKey);
	try {
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
		const existingRoll = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		if (existingRoll?.status === "awaiting-parry") {
			throw new Error("Attack damage has already been rolled; parry reduction is pending.");
		}
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
		const strength = characteristicValue(attacker, "s", "Strength");
		const optionalWeaponModifiers = WfrpRuleSettings.usesOptionalWeaponModifiers();
		const weaponDamageModifier = optionalWeaponModifiers
			? integer(CombatEquipment.optionalWeaponModifiers(weapon)?.damage)
			: 0;
		const weaponRuleSource = Array.isArray(attack.weapon?.effects)
			? attack.weapon
			: {
				uuid: String(weapon?.uuid ?? attack.weapon?.uuid ?? ""),
				name: String(weapon?.name ?? attack.weapon?.name ?? "Weapon"),
				effects: DamageRuleEffects.activeEffectSnapshots(weapon),
			};
		const damageRules = DamageRuleEffects.resolve(
			attacker,
			defender,
			[{ kind: "weapon", source: weaponRuleSource }],
		);
		const ruleDamageModifier = integer(damageRules.damageModifier);
		const generatedDamage = Math.max(
			0,
			diceTotal + strength + weaponDamageModifier + ruleDamageModifier,
		);
		const toughness = characteristicValue(defender, "t", "Toughness");
		const armour = CombatEquipment.armourAt(defender, hitLocation);
		const parry = {
			succeeded: outcome.parrySucceeded === true,
			reduction: null,
			itemName: outcome.parrySucceeded
				? String(attack.defence?.itemName ?? "")
				: "",
			itemUuid: outcome.parrySucceeded
				? String(attack.defence?.itemUuid ?? "")
				: "",
		};
		const baseState = {
			version: 5,
			status: parry.succeeded ? "awaiting-parry" : "resolved",
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
			weaponDamageModifier,
			ruleDamageModifier,
			damageRuleEffects: foundry.utils.deepClone(damageRules.entries),
			armourMitigation: damageRules.armourPolicy,
			toughnessMitigation: damageRules.toughnessPolicy,
			armourPenetration: nonNegativeInteger(damageRules.armourPenetration),
			optionalWeaponModifiersApplied: optionalWeaponModifiers,
			generatedDamage,
			parry,
			additionalDamage,
			rawAmount: generatedDamage,
			toughness,
			armour: foundry.utils.deepClone(armour),
			finalAmount: null,
			rolledBy: String(requestingUser?.id ?? game.user?.id ?? ""),
			resolvedBy: String(game.user?.id ?? ""),
			rolledAt: Date.now(),
		};

		if (parry.succeeded) {
			await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, baseState);
			void ui.chat?.render?.({ force: true });

			/* GM-controlled defenders may keep the whole damage sequence automatic. */
			if (
				!actorOwnedByPlayer(defender) &&
				WfrpRuleSettings.autoRollDamageForGmActors()
			) {
				return resolveParryAsAuthority(message, game.user);
			}
			return foundry.utils.deepFreeze(foundry.utils.deepClone(baseState));
		}

		return finalizeDamageResolution(message, baseState, attack, defender);
	} finally {
		activeActions.delete(actionKey);
	}
}

async function resolveParryAsAuthority(message, requestingUser) {
	const actionKey = actionId(message, "parry");
	if (!message?.id || activeActions.has(actionKey)) {
		throw new Error("This parry damage reduction is already being resolved.");
	}
	if (!canRequestParryRoll(message, requestingUser)) {
		throw new Error("The requesting user may not roll this parry reduction.");
	}

	/* Serialize before resolving the defender UUID for the same race-safe reason. */
	activeActions.add(actionKey);
	try {
		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		const defender = await actorFromUuid(attack?.target?.uuid);
		if (!attack || !defender || rollState?.status !== "awaiting-parry") {
			throw new Error("This attack is not waiting for a parry reduction roll.");
		}

		const parryRoll = await new Roll("1d6").evaluate({ allowInteractive: false });
		await showRollAnimation(parryRoll, requestingUser);
		const updated = foundry.utils.deepClone(rollState);
		updated.parry = {
			...(updated.parry ?? {}),
			succeeded: true,
			reduction: d6Result(parryRoll, "Parry reduction die"),
			rolledBy: String(requestingUser?.id ?? ""),
			rolledAt: Date.now(),
		};
		updated.status = "resolved";
		return finalizeDamageResolution(message, updated, attack, defender);
	} finally {
		activeActions.delete(actionKey);
	}
}

async function finalizeDamageResolution(message, rollState, attack, defender) {
	const packet = damagePacketForState(message, rollState, attack, defender);
	const resolution = DamageResolver.resolve(packet, {
		toughness: { value: nonNegativeInteger(rollState.toughness) },
		armour: foundry.utils.deepClone(rollState.armour ?? {}),
	});
	const finalized = {
		...foundry.utils.deepClone(rollState),
		version: 5,
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

function damagePacketForState(message, rollState, attack, defender, existingPacket = null) {
	const parry = rollState.parry ?? {};
	const specialMitigation = {};
	if (parry.succeeded === true && Number.isInteger(Number(parry.reduction))) {
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

	return new DamagePacket({
		id: existingPacket?.id ?? null,
		rawAmount: nonNegativeInteger(rollState.generatedDamage),
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
}

async function applyDamageDiceTotalOverrideAsAuthority(
	message,
	total,
	requestingUser,
) {
	const actionKey = actionId(message, "override");
	if (activeActions.has(actionKey)) {
		throw new Error("This damage roll is already being edited.");
	}
	if (!canEditCombatDamageDiceTotal(message, requestingUser)) {
		throw new Error("The requesting user may not edit this damage roll.");
	}

	const normalized = nonNegativeIntegerStrict(total, "Damage dice total");
	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? {},
	);
	const damageState = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const defender = await actorFromUuid(attack?.target?.uuid);
	if (!attack || !defender || !damageState?.packet) {
		throw new Error("This damage result is no longer available.");
	}

	activeActions.add(actionKey);
	try {
		rollState.diceTotal = normalized;
		rollState.diceTotalOverridden = normalized !== Number(rollState.diceTotalOriginal);
		rollState.diceTotalOverriddenBy = rollState.diceTotalOverridden
			? String(requestingUser?.id ?? "")
			: null;
		rollState.diceTotalOverriddenAt = rollState.diceTotalOverridden
			? Date.now()
			: null;
		rollState.generatedDamage = Math.max(
			0,
			normalized +
				integer(rollState.strength) +
				integer(rollState.weaponDamageModifier) +
				integer(rollState.ruleDamageModifier),
		);
		rollState.rawAmount = rollState.generatedDamage;

		const existingPacket = DamagePacket.fromJSON(damageState.packet);
		const packet = damagePacketForState(
			message,
			rollState,
			attack,
			defender,
			existingPacket,
		);
		const resolution = DamageResolver.resolve(packet, {
			toughness: { value: nonNegativeInteger(rollState.toughness) },
			armour: foundry.utils.deepClone(rollState.armour ?? {}),
		});
		rollState.packetId = packet.id;
		rollState.finalAmount = resolution.finalAmount;
		rollState.updatedBy = String(requestingUser?.id ?? "");
		rollState.updatedAt = Date.now();

		await DamageChat.attach(message, { packet, resolution });
		await message.setFlag(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY, rollState);
		void ui.chat?.render?.({ force: true });
		return foundry.utils.deepFreeze(foundry.utils.deepClone(rollState));
	} finally {
		activeActions.delete(actionKey);
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

function canRequestDamageRoll(message, user = game.user) {
	if (!message?.id || !user || activeActions.has(actionId(message, "damage"))) {
		return false;
	}
	const existingDamage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const existingRoll = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (existingRoll?.status === "awaiting-parry") return false;
	if (existingDamage && damageTransactionFor(message, existingDamage)?.state !== "reverted") {
		return false;
	}
	if (existingRoll && !existingDamage) return false;

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
	return hasOwnerPermission(attacker, user);
}

function canRequestParryRoll(message, user = game.user) {
	if (!message?.id || !user || activeActions.has(actionId(message, "parry"))) {
		return false;
	}
	if (message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY)) return false;
	const rollState = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (rollState?.status !== "awaiting-parry" || rollState.parry?.succeeded !== true) {
		return false;
	}
	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (!outcome?.parrySucceeded || !outcome.continueToDamage) return false;
	if (user.isGM) return true;
	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const defender = actorFromUuidSync(attack?.target?.uuid);
	return hasOwnerPermission(defender, user);
}

function maybeQueueAutomaticDamage(message, attacker) {
	if (!canRequestDamageRoll(message, game.user)) return;
	if (!shouldAutomaticallyRollForActor(attacker, game.user)) return;
	queueAutomaticAction(
		actionId(message, "auto-damage"),
		() => requestDamageRoll(message),
	);
}

function maybeQueueAutomaticParry(message, defender) {
	if (!canRequestParryRoll(message, game.user)) return;
	if (!shouldAutomaticallyRollForActor(defender, game.user)) return;
	queueAutomaticAction(
		actionId(message, "auto-parry"),
		() => requestParryReductionRoll(message),
	);
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

function queueAutomaticAction(key, action) {
	if (queuedAutomaticActions.has(key)) return;
	queuedAutomaticActions.add(key);
	queueMicrotask(() => {
		void action()
			.catch(reportDamageError)
			.finally(() => {
				setTimeout(() => queuedAutomaticActions.delete(key), 250);
			});
	});
}

async function reconcileAttackDamageAfterChange(message, reason) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState && !rollState) return;
	if (damageState && damageTransactionFor(message, damageState)?.state === "applied") {
		return;
	}

	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (
		reason === "attack-adjudication-changed" ||
		!outcome?.attackHit ||
		outcome.defenceStatus !== "resolved" ||
		!outcome.continueToDamage ||
		(rollState?.status === "awaiting-parry" && !outcome.parrySucceeded)
	) {
		await archiveAndClearCombatDamage(message, reason);
	}
}

async function clearCurrentDamageIfReversible(message, reason) {
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damageState && !rollState) return;
	if (damageState && damageTransactionFor(message, damageState)?.state === "applied") {
		return;
	}
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
		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const state = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		const roll = message.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		const relevant =
			String(state?.packet?.targetActorUuid ?? "") === String(actor.uuid ?? "") ||
			String(roll?.attackerUuid ?? "") === String(actor.uuid ?? "") ||
			String(roll?.defenderUuid ?? "") === String(actor.uuid ?? "") ||
			String(attack?.attacker?.uuid ?? "") === String(actor.uuid ?? "") ||
			String(attack?.target?.uuid ?? "") === String(actor.uuid ?? "");
		if (!relevant) continue;
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
	const requestTypes = new Set([
		SOCKET_DAMAGE_REQUEST_TYPE,
		SOCKET_PARRY_REQUEST_TYPE,
		SOCKET_OVERRIDE_REQUEST_TYPE,
	]);
	if (!requestTypes.has(payload.type) || !isPrimaryActiveGM()) return;

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

		switch (payload.type) {
			case SOCKET_DAMAGE_REQUEST_TYPE:
				response.result = await resolveDamageAsAuthority(message, requester);
				break;
			case SOCKET_PARRY_REQUEST_TYPE:
				response.result = await resolveParryAsAuthority(message, requester);
				break;
			case SOCKET_OVERRIDE_REQUEST_TYPE:
				response.result = await applyDamageDiceTotalOverrideAsAuthority(
					message,
					payload.total,
					requester,
				);
				break;
			default:
				throw new Error("Unsupported combat damage action.");
		}
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
	const dice = Array.isArray(state?.damageDice)
		? state.damageDice.map((value) => nonNegativeInteger(value))
		: [];
	if (!dice.length) return "—";
	const rolled = dice.join(" + ");
	const total = nonNegativeInteger(state?.diceTotal);
	return state?.diceTotalOverridden
		? `${rolled} → ${total}`
		: `${rolled} = ${total}`;
}

function armourLabel(armour) {
	if (armour?.policy === DAMAGE_MITIGATION_POLICY.IGNORE) {
		return localize("ignored", "pominięty");
	}
	const value = nonNegativeInteger(armour?.value);
	const penetration = nonNegativeInteger(armour?.penetration?.applied);
	if (penetration > 0) {
		return localize(
			`−${value} (penetration ${penetration})`,
			`−${value} (przebicie ${penetration})`,
		);
	}
	if (armour?.leather?.ignoredByHighDamage === true) {
		return localize(
			`−${value} (leather ignored: blow was 4+)`,
			`−${value} (skóra pominięta: cios zadał 4+)`,
		);
	}
	return `−${value}`;
}

function mitigationLabel(mitigation) {
	if (mitigation?.policy === DAMAGE_MITIGATION_POLICY.IGNORE) {
		return localize("ignored", "pominięta");
	}
	return `−${nonNegativeInteger(mitigation?.value)}`;
}

function mitigationPolicy(value) {
	return value === DAMAGE_MITIGATION_POLICY.IGNORE
		? DAMAGE_MITIGATION_POLICY.IGNORE
		: DAMAGE_MITIGATION_POLICY.APPLY;
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

function appendDamageRuleDetails(root, entries) {
	const groups = damageRuleEffectGroups(entries);
	for (const group of groups) {
		const heading = document.createElement("div");
		heading.className = "combat-damage-context__effect-source";
		heading.textContent = damageRuleSourceHeading(group.sourceName);
		root.append(heading);

		for (const effect of group.effects) {
			const effectHeading = document.createElement("div");
			effectHeading.className = "combat-damage-context__effect-heading";
			effectHeading.textContent = effect.effectName;
			root.append(effectHeading);

			for (const change of effect.changes) {
				const row = document.createElement("div");
				row.className = "combat-damage-context__row combat-damage-context__effect-row";
				const label = document.createElement("span");
				label.textContent = change.label;
				row.append(label);
				if (change.valueLabel) {
					const value = document.createElement("strong");
					value.textContent = change.valueLabel;
					row.append(value);
				}
				root.append(row);
			}
		}

		const end = document.createElement("div");
		end.className = "combat-damage-context__effect-end";
		end.setAttribute("aria-hidden", "true");
		root.append(end);
	}
	return groups.length;
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
	return [...(game.users ?? [])].some((user) =>
		!user?.isGM && hasOwnerPermission(actor, user),
	);
}

function canSeeDamage(attacker, defender, user) {
	if (!user) return false;
	if (user.isGM) return true;
	return hasOwnerPermission(attacker, user) || hasOwnerPermission(defender, user);
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

function actionId(message, phase) {
	return `${String(message?.id ?? "")}:${phase}`;
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function nonNegativeIntegerStrict(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return number;
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
