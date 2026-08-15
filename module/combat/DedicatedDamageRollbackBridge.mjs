import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";

/**
 * The dedicated Damage ChatMessage is a presentation view; the authoritative
 * damageState remains on its source Attack message. Expose the existing rollback
 * action on both cards without duplicating rollback mechanics: this adapter
 * delegates the click to CombatTransactionRollback's registered source-message
 * context action.
 */
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize("Invalidate damage", "Unieważnij obrażenia"),
		icon: '<i class="fa-solid fa-heart-circle-plus"></i>',
		visible: (target) => canBridgeDamageInvalidation(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const viewMessage = messageFromContextTarget(target);
			if (viewMessage) void delegateDamageInvalidation(viewMessage);
		},
	});
});

function canBridgeDamageInvalidation(viewMessage) {
	if (!game.user?.isGM || !viewMessage?.id) return false;
	const view = viewMessage.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.sourceAttackMessageId) return false;

	const source = game.messages?.get(String(view.sourceAttackMessageId));
	const state = source?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const actor = actorFromUuidSync(state?.packet?.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor) || !state?.packet?.id) return false;

	return DamageApplication.transactionFor(actor, state.packet.id)?.state === "applied";
}

async function delegateDamageInvalidation(viewMessage) {
	const view = viewMessage.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	const source = game.messages?.get(String(view?.sourceAttackMessageId ?? ""));
	if (!source) {
		ui.notifications.error(localize(
			"The source Attack message for this Damage card is unavailable.",
			"Wiadomość Ataku źródłowa dla tej karty Obrażeń jest niedostępna.",
		));
		return;
	}

	const menuItems = [];
	Hooks.callAll("getChatMessageContextOptions", null, menuItems);
	const label = localize("Invalidate damage", "Unieważnij obrażenia");
	const action = menuItems.find((entry) =>
		entry !== undefined &&
		entry !== null &&
		entry.label === label &&
		typeof entry.onClick === "function" &&
		entry.visible !== undefined,
	);
	if (!action) {
		ui.notifications.error(localize(
			"The authoritative damage rollback action is unavailable.",
			"Autorytatywna akcja cofania obrażeń jest niedostępna.",
		));
		return;
	}

	const sourceTarget = document.createElement("div");
	sourceTarget.dataset.messageId = String(source.id);
	if (typeof action.visible === "function" && !action.visible(sourceTarget)) {
		ui.notifications.warn(localize(
			"This damage can no longer be invalidated safely. Invalidate newer dependent damage first.",
			"Tych obrażeń nie można już bezpiecznie unieważnić. Najpierw unieważnij nowsze zależne obrażenia.",
		));
		return;
	}

	action.onClick(null, sourceTarget);
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const id = String(
		entry?.dataset?.messageId ??
			target?.attr?.("data-message-id") ??
			target?.data?.("message-id") ??
			"",
	).trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function actorFromUuidSync(uuid) {
	try {
		const actor = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
