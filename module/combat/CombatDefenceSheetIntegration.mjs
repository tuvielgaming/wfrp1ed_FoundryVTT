import { TestResultChat } from "../tests/TestResultChat.mjs";
import { CombatDefenceOpportunity } from "./CombatDefenceOpportunity.mjs";
import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const DODGE_BLOW_RULES_ID = "dodgeBlow";
const pendingSheetRequests = new Set();

/**
 * Optional second entry point for an already-pending melee defence.
 *
 * The Chat card remains authoritative and always offers the explicit dropdown +
 * confirmation workflow. While one or more successful melee attacks are waiting
 * for this Actor's defence, the target Actor's open Classic sheet exposes the
 * currently legal response objects for the latest unresolved attack as rollable
 * controls:
 *
 * - Dodge Blow Skill -> Dodge response;
 * - each legal held parry Weapon -> Parry with that exact Item;
 * - each legal held Shield -> Parry with that exact Item.
 *
 * After the latest attack is resolved, the sheet refreshes and the same controls
 * automatically bind to the next-latest unresolved attack. Repeated clicks can
 * therefore resolve a backlog in reverse chronological order without selecting
 * individual Chat cards.
 *
 * These shortcuts call CombatDefenceTransaction.requestResponse(), so they do
 * not duplicate any resource, permission, socket, roll, or chat-state logic.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet") ||
		!canDefend(actor, game.user)
	) {
		return;
	}

	const pending = pendingDefencesFor(actor);
	if (pending.length === 0) return;

	decoratePendingDefence(element, actor, pending[0], pending.length);
});

/*
 * Attack/defence flags live on the attack ChatMessage. Refresh only the target
 * Actor's already-open sheet when those flags change so shortcuts appear when
 * defence becomes pending and move immediately to the next unresolved attack
 * after the current latest one is committed.
 */
Hooks.on("updateChatMessage", (message, changes) => {
	if (!combatAttackStateChanged(changes) && !testStateChanged(changes)) return;
	void refreshTargetSheet(message);
});

Hooks.on("deleteChatMessage", (message) => {
	void refreshTargetSheet(message);
});

function decoratePendingDefence(root, actor, pending, pendingCount) {
	const { message, attackState, opportunity } = pending;
	const backlogSuffix = pendingCount > 1
		? localize(
			` This is the latest of ${pendingCount} unresolved attacks; after it is resolved, the sheet will switch to the previous unresolved attack.`,
			` To najnowszy z ${pendingCount} nierozstrzygniętych ataków; po jego rozstrzygnięciu karta postaci przełączy się na poprzedni nierozstrzygnięty atak.`,
		)
		: "";
	const contextTitle = localize(
		`Defend against ${attackState.attacker?.name ?? "attacker"} — ${attackState.weapon?.name ?? "melee attack"}. Clicking this control immediately selects and confirms that defence on the latest pending attack card.${backlogSuffix}`,
		`Obrona przed ${attackState.attacker?.name ?? "atakującym"} — ${attackState.weapon?.name ?? "atak wręcz"}. Kliknięcie natychmiast wybiera i zatwierdza tę obronę na najnowszej oczekującej karcie ataku.${backlogSuffix}`,
	);

	const dodgeResponse = opportunity.responses.find(
		(entry) => entry.id === "dodge",
	);
	if (dodgeResponse?.available) {
		const dodgeSkill = [...(actor.items ?? [])].find((item) =>
			item?.type === "skill" &&
			String(item.system?.rulesId ?? "").trim() === DODGE_BLOW_RULES_ID,
		);
		const row = dodgeSkill
			? itemRow(root, ".skill-row", dodgeSkill.id)
			: null;
		const button = row?.querySelector?.(".skill-name--open");
		if (button) {
			makeDefenceAction(button, {
				message,
				actor,
				response: "dodge",
				itemUuid: "",
				title: `${responseLabel("dodge")}. ${contextTitle}`,
			});
			row.classList.add("combat-sheet-defence-rollable");
			row.dataset.wfrpDefenceResponse = "dodge";
			row.title = `${responseLabel("dodge")}. ${contextTitle}`;
		}
	}

	const parryResponse = opportunity.responses.find(
		(entry) => entry.id === "parry",
	);
	if (!parryResponse?.available) return;

	for (const choice of opportunity.parry.choices) {
		const item = [...(actor.items ?? [])].find(
			(entry) => String(entry.uuid ?? "") === String(choice.itemUuid ?? ""),
		);
		if (!item) continue;

		const selector = item.type === "armour" ? ".armour-row" : ".melee-row";
		const row = itemRow(root, selector, item.id);
		if (!row) continue;

		const title = localize(
			`Parry with ${choice.itemName}. ${contextTitle}`,
			`Parowanie: ${choice.itemName}. ${contextTitle}`,
		);
		makeDefenceAction(row, {
			message,
			actor,
			response: "parry",
			itemUuid: choice.itemUuid,
			title,
			ignoreItemControls: true,
		});
		row.classList.add("combat-sheet-defence-rollable");
		row.dataset.wfrpDefenceResponse = "parry";
		row.dataset.wfrpDefenceItemUuid = String(choice.itemUuid ?? "");
		row.title = title;
		row.tabIndex = 0;
	}
}

function makeDefenceAction(target, {
	message,
	actor,
	response,
	itemUuid,
	title,
	ignoreItemControls = false,
}) {
	if (target.dataset.wfrpDefenceAction === "true") return;
	target.dataset.wfrpDefenceAction = "true";
	target.classList.add("combat-sheet-defence-action");
	target.title = title;
	if (target instanceof HTMLButtonElement) {
		target.setAttribute("aria-label", title);
	}

	const execute = async (event) => {
		if (event.shiftKey) return;
		if (
			ignoreItemControls &&
			event.target?.closest?.(".combat-sheet-item-controls")
		) {
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		await commitSheetDefence(message, actor, response, itemUuid, target);
	};

	/*
	 * Capture phase intentionally wins over the ordinary sheet action:
	 * - Dodge Blow normally opens its Skill Item;
	 * - a held melee Weapon normally launches an attack.
	 * During a pending defence the exact same click instead answers that blow.
	 * Shift-click remains the existing "open Item" escape hatch.
	 */
	target.addEventListener("click", (event) => {
		void execute(event);
	}, { capture: true });

	if (!(target instanceof HTMLButtonElement)) {
		target.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			void execute(event);
		}, { capture: true });
	}
}

async function commitSheetDefence(message, actor, response, itemUuid, target) {
	const messageId = String(message?.id ?? "");
	if (!messageId || pendingSheetRequests.has(messageId)) return;
	pendingSheetRequests.add(messageId);
	target.setAttribute?.("aria-busy", "true");

	try {
		await CombatDefenceTransaction.requestResponse(
			message,
			response,
			itemUuid,
		);
	} catch (error) {
		console.error("WFRP1ED | Unable to commit sheet defence.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to commit the selected defence.",
				"Nie udało się zatwierdzić wybranej obrony.",
			),
		);
	} finally {
		pendingSheetRequests.delete(messageId);
		target.removeAttribute?.("aria-busy");
		await refreshActorSheet(actor);
	}
}

function pendingDefencesFor(actor) {
	const actorUuid = String(actor?.uuid ?? "");
	if (!actorUuid) return [];

	const pending = [];
	let sequence = 0;
	for (const message of game.messages ?? []) {
		sequence += 1;
		const attackState = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const testState = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
		if (!attackState || !testState) continue;
		if (attackState.family !== "melee" || attackState.targetMode !== "defender") {
			continue;
		}
		if (String(attackState.target?.uuid ?? "") !== actorUuid) continue;
		if (attackState.defence?.status) continue;
		if (!currentTestSuccess(testState)) continue;

		const resolved = opportunityFor(actor, attackState.seenComing !== false);
		pending.push({
			message,
			attackState,
			opportunity: resolved.opportunity,
			createdAt: finiteTimestamp(
				attackState.createdAt ?? message.timestamp ?? 0,
			),
			sequence,
		});
	}

	pending.sort((first, second) =>
		(second.createdAt - first.createdAt) ||
		(second.sequence - first.sequence),
	);
	return pending;
}

function opportunityFor(actor, seenComing) {
	const combatant = combatantForActor(actor);
	const opportunity = combatant
		? CombatDefenceOpportunity.melee(combatant, { seenComing })
		: CombatDefenceOpportunity.unmanagedMelee(actor, { seenComing });
	return { combatant, opportunity };
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

function itemRow(root, selector, itemId) {
	const requested = String(itemId ?? "");
	return [...root.querySelectorAll(selector)].find(
		(row) => String(row.dataset.itemId ?? "") === requested,
	) ?? null;
}

function currentTestSuccess(state) {
	try {
		return TestResultChat._templateContext(state).result.success === true;
	} catch (_error) {
		return false;
	}
}

async function refreshTargetSheet(message) {
	const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const uuid = String(attackState?.target?.uuid ?? "").trim();
	if (!uuid || typeof globalThis.fromUuid !== "function") return;

	try {
		const document = await globalThis.fromUuid(uuid);
		const actor = document?.documentName === "Actor"
			? document
			: document?.actor ?? null;
		await refreshActorSheet(actor);
	} catch (_error) {
		/* The target may have been deleted; there is no sheet left to refresh. */
	}
}

async function refreshActorSheet(actor) {
	if (!actor?.sheet?.rendered) return;
	try {
		await actor.sheet.render();
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to refresh sheet defence shortcuts.",
			error,
		);
	}
}

function combatAttackStateChanged(changes) {
	return flagChanged(changes, ATTACK_FLAG_KEY);
}

function testStateChanged(changes) {
	return flagChanged(changes, TEST_FLAG_KEY);
}

function flagChanged(changes, key) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${key}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

function canDefend(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function responseLabel(response) {
	switch (response) {
		case "dodge": return localize("Dodge Blow", "Uniki");
		case "parry": return localize("Parry", "Parowanie");
		default: return String(response ?? "");
	}
}

function finiteTimestamp(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
