import { TestResultChat } from "../tests/TestResultChat.mjs";
import { CombatDefenceOpportunity } from "./CombatDefenceOpportunity.mjs";
import { CombatDodgeEconomy } from "./CombatDodgeEconomy.mjs";
import { CombatParrySelection } from "./CombatParrySelection.mjs";
import { CombatDefenceResultChat } from "./CombatDefenceResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-defence-response-request";
const SOCKET_RESPONSE_TYPE = "combat-defence-response-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

export const COMBAT_DEFENCE_STATUS = Object.freeze({
	RESOLVING: "resolving",
	RESOLVED: "resolved",
	ERROR: "error",
});

/**
 * One response transaction bound to one successful real melee attack card.
 *
 * The generic attack Test remains authoritative for hit/miss. Until a response
 * is committed this class only derives and renders the currently legal defence
 * choices. A GM modifier/manual-roll edit which changes the attack to a miss
 * therefore removes the pending defence without spending any resource.
 *
 * Once committed, exactly one response is stored on the attack:
 *   Parry OR Dodge Blow OR None.
 *
 * Parry and Dodge resource mutations are GM-authoritative and their d100 tests
 * reuse the existing generic Test pipeline. Parry damage reduction is NOT
 * rolled here; that belongs to the later damage transaction, where the exact
 * incoming damage and mitigation order are known.
 */
export class CombatDefenceTransaction {
	static activateListeners(message, html) {
		void this.#decorate(message, html);
	}

	/**
	 * Derive the current mechanical outcome without trusting cached success.
	 * The later damage transaction should use this method so manual edits of the
	 * attack or defence d100 remain authoritative.
	 */
	static outcomeForAttack(message) {
		const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const attackTest = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!attackState || !attackTest) return null;

		const attackHit = currentTestOutcome(attackTest).success;
		const defence = attackState.defence ?? null;
		if (!attackHit) {
			return Object.freeze({
				attackHit: false,
				defenceStatus: defence?.status ?? null,
				response: defence?.response ?? null,
				continueToDamage: false,
				dodgeSucceeded: false,
				parrySucceeded: false,
			});
		}

		if (defence?.status !== COMBAT_DEFENCE_STATUS.RESOLVED) {
			return Object.freeze({
				attackHit: true,
				defenceStatus: defence?.status ?? "pending",
				response: defence?.response ?? null,
				continueToDamage: false,
				dodgeSucceeded: false,
				parrySucceeded: false,
			});
		}

		if (defence.response === "none") {
			return Object.freeze({
				attackHit: true,
				defenceStatus: COMBAT_DEFENCE_STATUS.RESOLVED,
				response: "none",
				continueToDamage: true,
				dodgeSucceeded: false,
				parrySucceeded: false,
			});
		}

		const defenceMessage = game.messages?.get(
			String(defence.testMessageId ?? ""),
		);
		const defenceTest = defenceMessage?.getFlag?.(
			FLAG_SCOPE,
			TEST_FLAG_KEY,
		);
		const defenceSuccess = defenceTest
			? currentTestOutcome(defenceTest).success
			: false;

		if (defence.response === "dodge") {
			return Object.freeze({
				attackHit: true,
				defenceStatus: COMBAT_DEFENCE_STATUS.RESOLVED,
				response: "dodge",
				continueToDamage: !defenceSuccess,
				dodgeSucceeded: defenceSuccess,
				parrySucceeded: false,
			});
		}

		return Object.freeze({
			attackHit: true,
			defenceStatus: COMBAT_DEFENCE_STATUS.RESOLVED,
			response: "parry",
			continueToDamage: true,
			dodgeSucceeded: false,
			parrySucceeded: defenceSuccess,
		});
	}

	/** GM-authoritative response commit used directly or by the owner socket. */
	static async commitResponse(
		message,
		response,
		itemUuid,
		requestingUser,
	) {
		if (!game.user?.isGM) {
			throw new Error("Combat defence commitment requires GM authority.");
		}

		const context = await this.#currentContext(message);
		assertCanDefend(context.defender, requestingUser);
		assertPendingAttack(context);

		const responseId = String(response ?? "");
		const responseView = context.opportunity.responses.find(
			(entry) => entry.id === responseId,
		);
		if (!responseView?.available) {
			throw new Error(
				`The selected defence '${responseId}' is not currently available.`,
			);
		}

		let selectedParry = null;
		if (responseId === "parry") {
			selectedParry = CombatParrySelection.choice(
				context.combatant,
				itemUuid,
			);
		}

		const resolving = {
			status: COMBAT_DEFENCE_STATUS.RESOLVING,
			response: responseId,
			requestedBy: String(requestingUser?.id ?? ""),
			startedAt: Date.now(),
		};
		if (selectedParry) {
			resolving.itemUuid = selectedParry.itemUuid;
			resolving.itemName = selectedParry.itemName;
		}
		await writeDefenceState(message, context.attackState, resolving);

		if (responseId === "none") {
			const resolved = {
				...resolving,
				status: COMBAT_DEFENCE_STATUS.RESOLVED,
				resolvedAt: Date.now(),
			};
			await writeDefenceState(message, context.attackState, resolved);
			return Object.freeze({
				attackMessageId: String(message.id ?? ""),
				defence: foundry.utils.deepFreeze(foundry.utils.deepClone(resolved)),
			});
		}

		let resourceCommitted = false;
		try {
			if (responseId === "parry") {
				const resource = await CombatParrySelection.commitSelectedParry(
					context.combatant,
					selectedParry.itemUuid,
					requestingUser,
				);
				resourceCommitted = true;

				const result = await context.defender.rollTest("ws", {
					modifier: resource.selected.totalBonus,
				});
				if (!result?.chatMessage) {
					throw new Error("Parry Test did not produce a ChatMessage.");
				}

				await CombatDefenceResultChat.attach(result.chatMessage, {
					version: 1,
					response: "parry",
					attackMessageId: String(message.id ?? ""),
					attackerName: context.attackState.attacker?.name ?? "",
					weaponName: context.attackState.weapon?.name ?? "",
					defenderUuid: context.defender.uuid,
					itemUuid: resource.selected.itemUuid,
					itemName: resource.selected.itemName,
					parryBonus: resource.selected.totalBonus,
					attackCost: resource.parryAttackCost,
					immediateAttackCost: resource.parryImmediateAttackCost,
					parryDebtAdded: resource.parryDebtAdded,
				});

				const resolved = {
					...resolving,
					status: COMBAT_DEFENCE_STATUS.RESOLVED,
					itemUuid: resource.selected.itemUuid,
					itemName: resource.selected.itemName,
					parryBonus: resource.selected.totalBonus,
					attackCost: resource.parryAttackCost,
					immediateAttackCost: resource.parryImmediateAttackCost,
					parryDebtAdded: resource.parryDebtAdded,
					testMessageId: String(result.chatMessage.id ?? ""),
					resolvedAt: Date.now(),
				};
				await writeDefenceState(message, context.attackState, resolved);
				return Object.freeze({
					attackMessageId: String(message.id ?? ""),
					defence: foundry.utils.deepFreeze(foundry.utils.deepClone(resolved)),
				});
			}

			const dodge = await CombatDodgeEconomy.commitAttempt(
				context.combatant,
				requestingUser,
			);
			resourceCommitted = true;

			const result = await context.defender.rollTest("i", {
				modifier: 0,
			});
			if (!result?.chatMessage) {
				throw new Error("Dodge Blow Test did not produce a ChatMessage.");
			}

			await CombatDefenceResultChat.attach(result.chatMessage, {
				version: 1,
				response: "dodge",
				attackMessageId: String(message.id ?? ""),
				attackerName: context.attackState.attacker?.name ?? "",
				weaponName: context.attackState.weapon?.name ?? "",
				defenderUuid: context.defender.uuid,
				round: dodge.round,
			});

			const resolved = {
				...resolving,
				status: COMBAT_DEFENCE_STATUS.RESOLVED,
				testMessageId: String(result.chatMessage.id ?? ""),
				resolvedAt: Date.now(),
			};
			await writeDefenceState(message, context.attackState, resolved);
			return Object.freeze({
				attackMessageId: String(message.id ?? ""),
				defence: foundry.utils.deepFreeze(foundry.utils.deepClone(resolved)),
			});
		} catch (error) {
			if (resourceCommitted) {
				await writeDefenceState(message, context.attackState, {
					...resolving,
					status: COMBAT_DEFENCE_STATUS.ERROR,
					error: error instanceof Error ? error.message : String(error),
					failedAt: Date.now(),
				});
			} else {
				await clearDefenceState(message, context.attackState);
			}
			throw error;
		}
	}

	static async requestResponse(message, response, itemUuid = "") {
		const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (!attackState) {
			throw new Error("This ChatMessage is not a combat attack.");
		}

		const defender = await actorFromAttackState(attackState);
		assertCanDefend(defender, game.user);

		if (game.user?.isGM) {
			return this.commitResponse(
				message,
				response,
				itemUuid,
				game.user,
			);
		}

		const gm = primaryActiveGM();
		if (!gm) {
			throw new Error(localize(
				"A GM must be connected to commit a combat defence.",
				"MG musi być połączony, aby zatwierdzić obronę w walce.",
			));
		}

		const requestId = foundry.utils.randomID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(requestId);
				reject(new Error("Combat defence request timed out."));
			}, SOCKET_TIMEOUT_MS);

			pendingRequests.set(requestId, { resolve, reject, timeout });
			game.socket.emit(SOCKET_CHANNEL, {
				type: SOCKET_REQUEST_TYPE,
				requestId,
				requestUserId: String(game.user?.id ?? ""),
				messageId: String(message.id ?? ""),
				response: String(response ?? ""),
				itemUuid: String(itemUuid ?? ""),
			});
		});
	}

	/** Re-render chat when a linked defence Test is manually adjudicated. */
	static onChatMessageUpdate(message, changes) {
		if (!testStateChanged(changes)) return;
		const messageId = String(message?.id ?? "");
		if (!messageId) return;

		const linked = [...(game.messages ?? [])].some((entry) => {
			const defence = entry.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)?.defence;
			return String(defence?.testMessageId ?? "") === messageId;
		});
		if (!linked) return;

		void ui.chat?.render?.({ force: true });
	}

	static async #decorate(message, html) {
		const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const testState = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!attackState || !testState) return;
		if (attackState.family !== "melee" || attackState.targetMode !== "defender") {
			return;
		}

		const rendered = TestResultChat._asElement(html);
		const attackPanel = rendered?.querySelector?.(
			"[data-wfrp-combat-attack-context]",
		);
		if (!attackPanel || attackPanel.querySelector("[data-wfrp-combat-defence]")) {
			return;
		}

		const attackHit = currentTestOutcome(testState).success;
		const defence = attackState.defence ?? null;

		if (!attackHit && !defence) return;

		const defender = await actorFromAttackState(attackState);
		if (!defender) return;
		if (!attackPanel.isConnected) return;

		const panel = document.createElement("section");
		panel.classList.add("combat-defence-transaction");
		panel.dataset.wfrpCombatDefence = "";
		attackPanel.append(panel);

		if (!attackHit) {
			panel.append(statusText(localize(
				"The attack currently misses after adjudication. The recorded defence has no further mechanical effect.",
				"Po rozstrzygnięciu atak obecnie nie trafia. Zapisana obrona nie ma dalszego skutku mechanicznego.",
			)));
			return;
		}

		if (defence?.status === COMBAT_DEFENCE_STATUS.RESOLVED) {
			panel.append(this.#resolvedSummary(defence));
			return;
		}

		if (defence?.status === COMBAT_DEFENCE_STATUS.RESOLVING) {
			panel.append(statusText(localize(
				"Resolving defence…",
				"Rozstrzyganie obrony…",
			)));
			return;
		}

		if (defence?.status === COMBAT_DEFENCE_STATUS.ERROR) {
			panel.append(statusText(localize(
				`Defence encountered an error after spending its resource: ${defence.error ?? "unknown error"}`,
				`Podczas obrony wystąpił błąd po zużyciu zasobu: ${defence.error ?? "nieznany błąd"}`,
			)));
			return;
		}

		const combatant = combatantForActor(defender);
		if (!combatant) {
			panel.append(statusText(localize(
				"Automated Parry/Dodge is available when the defender participates in the active Combat Tracker. Resolve this defence manually for an unmanaged attack.",
				"Automatyczne Parowanie/Uniki są dostępne, gdy obrońca uczestniczy w aktywnym Monitorze Walki. Przy ataku poza automatyką rozstrzygnij obronę ręcznie.",
			)));
			return;
		}

		const opportunity = CombatDefenceOpportunity.melee(combatant, {
			seenComing: attackState.seenComing !== false,
		});
		panel.append(
			this.#pendingControls(message, defender, opportunity),
		);
	}

	static #pendingControls(message, defender, opportunity) {
		const root = document.createElement("div");
		root.classList.add("combat-defence-pending");

		const heading = document.createElement("div");
		heading.classList.add("combat-defence-pending__heading");
		const strong = document.createElement("strong");
		strong.textContent = localize("Defence", "Obrona");
		const actor = document.createElement("span");
		actor.textContent = String(defender.name ?? "");
		heading.append(strong, actor);
		root.append(heading);

		if (!canDefend(defender, game.user)) {
			root.append(statusText(localize(
				"Waiting for the defender or GM to choose Parry, Dodge Blow, or no defence.",
				"Oczekiwanie na obrońcę lub MG: Parowanie, Uniki albo brak obrony.",
			)));
			return root;
		}

		let selectedResponse = "";
		const responseButtons = new Map();
		const actions = document.createElement("div");
		actions.classList.add("combat-defence-pending__responses");

		for (const response of opportunity.responses) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.defenceResponse = response.id;
			button.textContent = responseLabel(response.id);
			button.disabled = response.available !== true;
			button.title = response.available
				? responseLabel(response.id)
				: unavailableReason(response.reason);
			button.addEventListener("click", (event) => {
				event.preventDefault();
				selectedResponse = response.id;
				for (const [id, candidate] of responseButtons) {
					candidate.classList.toggle("is-selected", id === selectedResponse);
				}
				parryGroup.hidden = selectedResponse !== "parry";
				refreshConfirm();
			});
			responseButtons.set(response.id, button);
			actions.append(button);
		}
		root.append(actions);

		const parryGroup = document.createElement("label");
		parryGroup.classList.add("combat-defence-pending__parry-item");
		parryGroup.hidden = true;
		const parryLabel = document.createElement("span");
		parryLabel.textContent = localize("Parry with", "Paruj za pomocą");
		const parrySelect = document.createElement("select");
		parrySelect.dataset.defenceParryItem = "";
		for (const choice of opportunity.parry.choices) {
			const option = document.createElement("option");
			option.value = choice.itemUuid;
			option.textContent = parryChoiceLabel(choice);
			parrySelect.append(option);
		}
		parrySelect.addEventListener("change", () => refreshConfirm());
		parryGroup.append(parryLabel, parrySelect);
		root.append(parryGroup);

		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.classList.add("combat-defence-pending__confirm");
		confirm.textContent = localize("Confirm defence", "Zatwierdź obronę");
		confirm.disabled = true;
		root.append(confirm);

		function refreshConfirm() {
			confirm.disabled = !selectedResponse ||
				(selectedResponse === "parry" && !parrySelect.value);
		}

		confirm.addEventListener("click", async (event) => {
			event.preventDefault();
			if (confirm.disabled) return;

			for (const button of responseButtons.values()) button.disabled = true;
			parrySelect.disabled = true;
			confirm.disabled = true;

			try {
				await CombatDefenceTransaction.requestResponse(
					message,
					selectedResponse,
					selectedResponse === "parry" ? parrySelect.value : "",
				);
			} catch (error) {
				console.error("WFRP1ED | Unable to commit combat defence.", error);
				ui.notifications.error(error?.message ?? String(error));
				for (const response of opportunity.responses) {
					const button = responseButtons.get(response.id);
					if (button) button.disabled = response.available !== true;
				}
				parrySelect.disabled = false;
				refreshConfirm();
			}
		});

		return root;
	}

	static #resolvedSummary(defence) {
		const root = document.createElement("div");
		root.classList.add("combat-defence-resolved");
		const heading = document.createElement("div");
		heading.classList.add("combat-defence-resolved__heading");
		const strong = document.createElement("strong");
		strong.textContent = localize("Defence", "Obrona");
		const response = document.createElement("span");
		response.textContent = responseLabel(defence.response);
		heading.append(strong, response);
		root.append(heading);

		if (defence.response === "none") {
			root.append(statusText(localize(
				"No defence — the blow continues to damage resolution.",
				"Brak obrony — cios przechodzi do rozstrzygania obrażeń.",
			)));
			return root;
		}

		const testMessage = game.messages?.get(
			String(defence.testMessageId ?? ""),
		);
		const testState = testMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!testState) {
			root.append(statusText(localize(
				"The defence Test result is unavailable.",
				"Wynik testu obrony jest niedostępny.",
			)));
			return root;
		}

		const success = currentTestOutcome(testState).success;
		if (defence.response === "dodge") {
			root.append(statusText(success
				? localize(
					"Dodge Blow succeeded — this blow will cause no damage.",
					"Unik udany — ten cios nie zada obrażeń.",
				)
				: localize(
					"Dodge Blow failed — the blow continues to damage resolution.",
					"Unik nieudany — cios przechodzi do rozstrzygania obrażeń.",
				)));
			return root;
		}

		root.append(statusText(success
			? localize(
				`Parry with ${defence.itemName ?? "weapon"} succeeded. Its Core damage reduction will be applied during damage resolution.`,
				`Parowanie za pomocą ${defence.itemName ?? "broni"} udało się. Redukcja obrażeń z zasad podstawowych zostanie zastosowana podczas rozstrzygania obrażeń.`,
			)
			: localize(
				`Parry with ${defence.itemName ?? "weapon"} failed — the blow continues to damage resolution.`,
				`Parowanie za pomocą ${defence.itemName ?? "broni"} nie udało się — cios przechodzi do rozstrzygania obrażeń.`,
			)));
		return root;
	}

	static async #currentContext(message) {
		const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const testState = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!attackState || !testState) {
			throw new Error("This ChatMessage has no complete combat attack state.");
		}
		if (attackState.family !== "melee" || attackState.targetMode !== "defender") {
			throw new Error("Only a defended melee attack can enter this defence transaction.");
		}

		const defender = await actorFromAttackState(attackState);
		if (!defender) {
			throw new Error("The defending Actor is no longer available.");
		}
		const combatant = combatantForActor(defender);
		if (!combatant) {
			throw new Error(localize(
				"Automated Parry/Dodge requires the defender to participate in the active Combat Tracker.",
				"Automatyczne Parowanie/Uniki wymagają udziału obrońcy w aktywnym Monitorze Walki.",
			));
		}

		return {
			attackState,
			testState,
			defender,
			combatant,
			opportunity: CombatDefenceOpportunity.melee(combatant, {
				seenComing: attackState.seenComing !== false,
			}),
		};
	}
}

function assertPendingAttack(context) {
	if (!currentTestOutcome(context.testState).success) {
		throw new Error(localize(
			"The attack no longer hits after adjudication, so it cannot consume a defence response.",
			"Po rozstrzygnięciu atak już nie trafia, więc nie może zużyć reakcji obronnej.",
		));
	}

	const status = context.attackState.defence?.status;
	if (status) {
		throw new Error(localize(
			"A defence response has already been committed or is being resolved for this attack.",
			"Dla tego ataku obrona została już zatwierdzona albo jest właśnie rozstrzygana.",
		));
	}
}

function currentTestOutcome(state) {
	return TestResultChat._templateContext(state).result;
}

async function actorFromAttackState(attackState) {
	const uuid = String(attackState?.target?.uuid ?? "").trim();
	if (!uuid || typeof globalThis.fromUuid !== "function") return null;
	const document = await globalThis.fromUuid(uuid);
	if (document?.documentName === "Actor") return document;
	if (document?.actor?.documentName === "Actor") return document.actor;
	return null;
}

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started || !actor) return null;
	const combatants = [...(combat.combatants ?? [])];
	const exact = combatants.filter(
		(entry) => entry.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];

	const sameId = combatants.filter(
		(entry) => entry.actor?.id && actor.id && entry.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function canDefend(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function assertCanDefend(actor, user) {
	if (canDefend(actor, user)) return;
	throw new Error(localize(
		"Only the GM or an OWNER of the defending Actor may choose this defence.",
		"Tylko MG albo Właściciel broniącego się Aktora może wybrać tę obronę.",
	));
}

async function writeDefenceState(message, attackState, defence) {
	const updated = foundry.utils.deepClone(attackState ?? {});
	updated.version = Math.max(3, Number(updated.version) || 0);
	updated.defence = foundry.utils.deepClone(defence);
	updated.updatedBy = game.user?.id ?? "";
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, ATTACK_FLAG_KEY, updated);
}

async function clearDefenceState(message, attackState) {
	const updated = foundry.utils.deepClone(attackState ?? {});
	delete updated.defence;
	updated.updatedBy = game.user?.id ?? "";
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, ATTACK_FLAG_KEY, updated);
}

function responseLabel(response) {
	switch (response) {
		case "parry": return localize("Parry", "Parowanie");
		case "dodge": return localize("Dodge Blow", "Uniki");
		case "none": return localize("No defence", "Brak obrony");
		default: return String(response ?? "—");
	}
}

function unavailableReason(reason) {
	switch (reason) {
		case "parry-limit":
			return localize("Parry attempt limit reached this round.", "Limit prób parowania w tej rundzie został wyczerpany.");
		case "no-parry-item":
			return localize("No currently held Item can parry.", "Brak aktualnie trzymanego przedmiotu, którym można parować.");
		case "not-seen-coming":
			return localize("The blow was not seen coming.", "Postać nie widziała nadchodzącego ciosu.");
		case "missing-dodge-blow-skill":
			return localize("The defender does not have Dodge Blow.", "Obrońca nie posiada umiejętności Uniki.");
		case "already-used-this-round":
			return localize("Dodge Blow was already attempted this round.", "Uniki zostały już użyte w tej rundzie.");
		default:
			return localize("This defence is not currently available.", "Ta obrona nie jest obecnie dostępna.");
	}
}

function parryChoiceLabel(choice) {
	const bonus = Number(choice.totalBonus ?? 0);
	const signed = bonus >= 0 ? `+${bonus}` : String(bonus);
	const cost = Number(choice.attackCost ?? 0);
	const debt = Number(choice.parryDebtAdded ?? 0);
	const parts = [`${choice.itemName} (${signed})`];
	if (cost > 0) parts.push(localize(`cost ${cost} A`, `koszt ${cost} A`));
	if (debt > 0) parts.push(localize(`debt +${debt}`, `dług +${debt}`));
	return parts.join(" — ");
}

function statusText(text) {
	const element = document.createElement("div");
	element.classList.add("combat-defence-status");
	element.textContent = text;
	return element;
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (payload) => {
		if (!payload || typeof payload !== "object") return;

		if (payload.type === SOCKET_RESPONSE_TYPE) {
			handleSocketResponse(payload);
			return;
		}

		if (payload.type !== SOCKET_REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: SOCKET_RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			requestUserId: String(payload.requestUserId ?? ""),
		};

		try {
			const message = game.messages?.get(String(payload.messageId ?? ""));
			const user = game.users?.get(String(payload.requestUserId ?? ""));
			if (!message) throw new Error("Requested combat attack message is unavailable.");
			if (!user?.active) throw new Error("Requesting user is not active.");

			response.result = await CombatDefenceTransaction.commitResponse(
				message,
				payload.response,
				payload.itemUuid,
				user,
			);
		} catch (error) {
			response.error = error instanceof Error ? error.message : String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleSocketResponse(payload) {
	if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) {
		return;
	}
	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;

	clearTimeout(pending.timeout);
	pendingRequests.delete(requestId);
	if (payload.error) {
		pending.reject(new Error(String(payload.error)));
		return;
	}
	pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

Hooks.once("ready", () => registerSocket());
