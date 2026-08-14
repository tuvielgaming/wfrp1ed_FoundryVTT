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
 * One mutually-exclusive response transaction bound to a successful real melee
 * attack card.
 *
 * Managed mode uses Combatant round resources for Parry and Dodge Blow.
 * Unmanaged mode is available outside Combat Tracker: the same defence tests
 * and equipment/Skill requirements apply, but round counters, Attack loss and
 * parry debt are intentionally not mutated because no authoritative round
 * lifecycle exists there.
 */
export class CombatDefenceTransaction {
	static activateListeners(message, html) {
		void this.#decorate(message, html);
	}

	/**
	 * Derive the current mechanical outcome from the persisted Test snapshots.
	 * Manual edits of the attack or linked defence d100 therefore remain
	 * authoritative for later damage resolution.
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

		const selectedParry = responseId === "parry"
			? selectedParryFor(context, itemUuid)
			: null;
		const resolving = {
			status: COMBAT_DEFENCE_STATUS.RESOLVING,
			response: responseId,
			managedByCombat: context.managed,
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
			return frozenResult(message, resolved);
		}

		let resourceCommitted = false;
		try {
			if (responseId === "parry") {
				let resource = unmanagedParryResource(selectedParry);
				if (context.managed) {
					resource = await CombatParrySelection.commitSelectedParry(
						context.combatant,
						selectedParry.itemUuid,
						requestingUser,
					);
					resourceCommitted = true;
				}

				const result = await context.defender.rollTest("ws", {
					modifier: resource.selected.totalBonus,
				});
				if (!result?.chatMessage) {
					throw new Error("Parry Test did not produce a ChatMessage.");
				}

				await CombatDefenceResultChat.attach(result.chatMessage, {
					version: 2,
					response: "parry",
					managedByCombat: context.managed,
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
				return frozenResult(message, resolved);
			}

			let dodgeRound = null;
			if (context.managed) {
				const dodge = await CombatDodgeEconomy.commitAttempt(
					context.combatant,
					requestingUser,
				);
				resourceCommitted = true;
				dodgeRound = dodge.round;
			}

			const result = await context.defender.rollTest("i", {
				modifier: 0,
			});
			if (!result?.chatMessage) {
				throw new Error("Dodge Blow Test did not produce a ChatMessage.");
			}

			await CombatDefenceResultChat.attach(result.chatMessage, {
				version: 2,
				response: "dodge",
				managedByCombat: context.managed,
				attackMessageId: String(message.id ?? ""),
				attackerName: context.attackState.attacker?.name ?? "",
				weaponName: context.attackState.weapon?.name ?? "",
				defenderUuid: context.defender.uuid,
				round: dodgeRound,
			});

			const resolved = {
				...resolving,
				status: COMBAT_DEFENCE_STATUS.RESOLVED,
				testMessageId: String(result.chatMessage.id ?? ""),
				resolvedAt: Date.now(),
			};
			await writeDefenceState(message, context.attackState, resolved);
			return frozenResult(message, resolved);
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
		if (!defender || !attackPanel.isConnected) return;

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

		const { opportunity } = opportunityFor(
			defender,
			attackState.seenComing !== false,
		);
		panel.append(this.#pendingControls(message, defender, opportunity));
	}

	/**
	 * Compact response selector. Unavailable options are omitted rather than
	 * rendered as dead controls. Parry Items are individual choices so the
	 * tactical weapon/shield decision remains explicit in one dropdown.
	 */
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
				"Waiting for the defender or GM to choose a defence.",
				"Oczekiwanie na obrońcę lub MG, który wybierze obronę.",
			)));
			return root;
		}

		const chooser = document.createElement("label");
		chooser.classList.add("combat-defence-pending__chooser");
		const label = document.createElement("span");
		label.textContent = localize("Response", "Reakcja");
		const select = document.createElement("select");
		select.dataset.defenceChoice = "";

		appendDefenceOption(select, {
			value: "none",
			response: "none",
			label: responseLabel("none"),
		});

		const dodge = opportunity.responses.find((entry) => entry.id === "dodge");
		if (dodge?.available) {
			appendDefenceOption(select, {
				value: "dodge",
				response: "dodge",
				label: responseLabel("dodge"),
			});
		}

		const parry = opportunity.responses.find((entry) => entry.id === "parry");
		if (parry?.available) {
			opportunity.parry.choices.forEach((choice, index) => {
				appendDefenceOption(select, {
					value: `parry-${index}`,
					response: "parry",
					itemUuid: choice.itemUuid,
					label: `${responseLabel("parry")} — ${parryChoiceLabel(
						choice,
						opportunity.mode === "managed",
					)}`,
				});
			});
		}

		chooser.append(label, select);
		root.append(chooser);

		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.classList.add("combat-defence-pending__confirm");
		confirm.textContent = localize("Confirm defence", "Zatwierdź obronę");
		root.append(confirm);

		confirm.addEventListener("click", async (event) => {
			event.preventDefault();
			const option = select.selectedOptions?.[0];
			if (!option) return;

			const response = String(option.dataset.response ?? "none");
			const itemUuid = String(option.dataset.itemUuid ?? "");
			select.disabled = true;
			confirm.disabled = true;

			try {
				await CombatDefenceTransaction.requestResponse(
					message,
					response,
					itemUuid,
				);
			} catch (error) {
				console.error("WFRP1ED | Unable to commit combat defence.", error);
				ui.notifications.error(error?.message ?? String(error));
				select.disabled = false;
				confirm.disabled = false;
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

		const resolved = opportunityFor(
			defender,
			attackState.seenComing !== false,
		);
		return {
			attackState,
			testState,
			defender,
			combatant: resolved.combatant,
			managed: Boolean(resolved.combatant),
			opportunity: resolved.opportunity,
		};
	}
}

function opportunityFor(defender, seenComing) {
	const combatant = combatantForActor(defender);
	const opportunity = combatant
		? CombatDefenceOpportunity.melee(combatant, { seenComing })
		: CombatDefenceOpportunity.unmanagedMelee(defender, { seenComing });
	return { combatant, opportunity };
}

function selectedParryFor(context, itemUuid) {
	if (context.managed) {
		return CombatParrySelection.choice(context.combatant, itemUuid);
	}

	const requested = String(itemUuid ?? "");
	const selected = context.opportunity.parry.choices.find(
		(choice) => choice.itemUuid === requested,
	);
	if (!selected) {
		throw new Error(
			"The selected Item is not currently available for parrying.",
		);
	}
	return selected;
}

function unmanagedParryResource(selected) {
	return {
		selected,
		parryAttackCost: 0,
		parryImmediateAttackCost: 0,
		parryDebtAdded: 0,
	};
}

function appendDefenceOption(select, {
	value,
	response,
	itemUuid = "",
	label,
}) {
	const option = document.createElement("option");
	option.value = String(value);
	option.dataset.response = String(response);
	option.dataset.itemUuid = String(itemUuid);
	option.textContent = String(label);
	select.append(option);
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
	updated.version = Math.max(4, Number(updated.version) || 0);
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

function frozenResult(message, defence) {
	return Object.freeze({
		attackMessageId: String(message.id ?? ""),
		defence: foundry.utils.deepFreeze(foundry.utils.deepClone(defence)),
	});
}

function responseLabel(response) {
	switch (response) {
		case "parry": return localize("Parry", "Parowanie");
		case "dodge": return localize("Dodge Blow", "Uniki");
		case "none": return localize("No defence", "Brak obrony");
		default: return String(response ?? "—");
	}
}

function parryChoiceLabel(choice, managed) {
	const bonus = Number(choice.totalBonus ?? 0);
	const signed = bonus >= 0 ? `+${bonus}` : String(bonus);
	const parts = [`${choice.itemName} (${signed})`];
	if (managed) {
		const cost = Number(choice.attackCost ?? 0);
		const debt = Number(choice.parryDebtAdded ?? 0);
		if (cost > 0) parts.push(localize(`cost ${cost} A`, `koszt ${cost} A`));
		if (debt > 0) parts.push(localize(`debt +${debt}`, `dług +${debt}`));
	}
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
			response.error = error instanceof Error
				? error.message
				: String(error);
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
