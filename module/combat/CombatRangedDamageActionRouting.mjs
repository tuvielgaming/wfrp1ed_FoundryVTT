import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";
import {
	resolveDamageMessageCritical,
} from "../criticals/CriticalDamageIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";

/**
 * Presentation bridge for ranged damage after CombatLifecyclePresentation.
 *
 * CombatLifecyclePresentation predates the ranged Critical policy and therefore
 * assumes every applied combat Critical is Detailed. This module is deliberately
 * loaded immediately after that shared presentation layer and corrects only the
 * ranged-specific action routing while preserving the shared melee workflow.
 *
 * The dedicated Damage card is the single action surface once it exists:
 * - before application it keeps the normal shared Apply Damage button;
 * - after application it exposes the resolver selected by the persisted packet;
 * - the source Attack card keeps history only and loses duplicate Apply/Critical
 *   actions.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		routeRangedDamageActions(message, html);
	});

	Hooks.on("updateActor", (actor) => {
		refreshRangedDamageActionsForActor(actor);
	});
});

function routeRangedDamageActions(message, html) {
	const root = asElement(html);
	if (!root) return;

	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (view?.sourceAttackMessageId) {
		routeDedicatedDamageCard(message, root, view);
		return;
	}

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damage = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (attack?.family !== "ranged" || !damage?.packet?.id) return;
	if (!findDamageResultView(message.id, damage.packet.id)) return;

	cleanupSourceAttackCard(root);
}

function routeDedicatedDamageCard(_message, root, view) {
	const sourceMessage = game.messages?.get(
		String(view.sourceAttackMessageId ?? ""),
	);
	const attack = sourceMessage?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (attack?.family !== "ranged" || !damage?.packet?.id) return;
	if (String(damage.packet.id) !== String(view.packetId ?? "")) return;

	/* Once the dedicated result exists, remove duplicate actions from the source
	 * card immediately, even if that source card is not re-rendered by Foundry. */
	cleanupVisibleSourceAttackCard(sourceMessage);

	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!(card instanceof HTMLElement)) return;

	const actions = card.querySelector?.("[data-wfrp-damage-result-actions]");
	if (!(actions instanceof HTMLElement)) return;

	const actor = actorFromUuidSync(
		view.targetActorUuid ?? damage.packet.targetActorUuid,
	);
	const authoritative = actor
		? DamageApplication.transactionFor(actor, view.packetId)
		: null;
	const transaction = authoritative ?? damage.application ?? null;

	/* Before damage is applied, CombatLifecyclePresentation owns the action area
	 * and its normal Apply Damage button must remain untouched. */
	if (String(transaction?.state ?? "") !== "applied") return;

	const criticalValue = Number(transaction?.criticalValue ?? 0);
	const criticalResolution = transaction?.criticalResolution ?? null;
	const criticalMode = String(
		damage.packet?.critical?.mode ?? transaction?.criticalMode ?? "",
	);

	/* Detailed mode is already handled by the shared lifecycle. */
	if (criticalMode === DAMAGE_CRITICAL_MODE.DETAILED) return;

	/* A ranged Sudden Death packet must never expose the legacy Detailed button. */
	if (criticalMode !== DAMAGE_CRITICAL_MODE.SUDDEN_DEATH) return;
	if (criticalValue <= 0) return;

	actions.replaceChildren();
	if (criticalResolution) return;
	if (!canResolveSourceCritical(sourceMessage, damage, game.user)) return;

	actions.append(buildSuddenDeathButton(sourceMessage));
}

function buildSuddenDeathButton(sourceMessage) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1e-critical-result__action";
	button.dataset.wfrpResolveCritical = "";
	button.innerHTML = `<i class="fa-solid fa-skull"></i> ${localize(
		"Resolve Critical",
		"Rozstrzygnij trafienie krytyczne",
	)}`;
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		button.disabled = true;
		void resolveDamageMessageCritical(sourceMessage)
			.catch((error) => {
				console.error(
					"WFRP1ED | Unable to resolve ranged Sudden Death critical.",
					error,
				);
				ui.notifications.error(
					error?.message ?? localize(
						"Unable to resolve the critical hit.",
						"Nie udało się rozstrzygnąć trafienia krytycznego.",
					),
				);
			})
			.finally(() => {
				if (button.isConnected) button.disabled = false;
			});
	});
	return button;
}

function refreshRangedDamageActionsForActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		if (
			view?.sourceAttackMessageId &&
			String(view.targetActorUuid ?? "") === String(actor.uuid ?? "")
		) {
			const entry = visibleMessageEntry(message.id);
			if (entry) routeRangedDamageActions(message, entry);
			continue;
		}

		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		const damage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		if (
			attack?.family !== "ranged" ||
			String(damage?.packet?.targetActorUuid ?? "") !== String(actor.uuid ?? "")
		) {
			continue;
		}
		const entry = visibleMessageEntry(message.id);
		if (entry) routeRangedDamageActions(message, entry);
	}
}

function cleanupVisibleSourceAttackCard(sourceMessage) {
	const entry = visibleMessageEntry(sourceMessage?.id);
	if (entry) cleanupSourceAttackCard(entry);
}

function cleanupSourceAttackCard(root) {
	root.querySelectorAll?.(
		"[data-wfrp-inline-apply-damage], " +
		"[data-wfrp-critical-result], " +
		"[data-wfrp-detailed-critical-panel]",
	)?.forEach?.((element) => element.remove());
}

function findDamageResultView(sourceMessageId, packetId) {
	const sourceId = String(sourceMessageId ?? "");
	const id = String(packetId ?? "");
	if (!sourceId || !id) return null;

	return [...(game.messages ?? [])].find((message) => {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		return Boolean(
			String(view?.sourceAttackMessageId ?? "") === sourceId &&
			String(view?.packetId ?? "") === id
		);
	}) ?? null;
}

function canResolveSourceCritical(sourceMessage, damageState, user) {
	if (!sourceMessage || !damageState || !user) return false;
	if (user.isGM) return true;

	const sourceUserId = String(
		damageState.createdBy ??
		sourceMessage.user?.id ??
		sourceMessage.author?.id ??
		"",
	).trim();
	return Boolean(sourceUserId && sourceUserId === String(user.id ?? ""));
}

function actorFromUuidSync(uuid) {
	const value = String(uuid ?? "").trim();
	if (!value) return null;
	try {
		const document = foundry.utils.fromUuidSync(value);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function visibleMessageEntry(messageId) {
	const id = String(messageId ?? "");
	return id
		? document.querySelector(`[data-message-id="${cssEscape(id)}"]`)
		: null;
}

function cssEscape(value) {
	return globalThis.CSS?.escape
		? CSS.escape(String(value ?? ""))
		: String(value ?? "").replaceAll('"', '\\"');
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
