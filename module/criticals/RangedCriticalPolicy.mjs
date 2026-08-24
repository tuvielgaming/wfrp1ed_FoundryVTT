import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import {
	resolveDamageMessageCritical,
} from "./CriticalDamageIntegration.mjs";

const SETTING_KEY = "detailedCriticalsForRangedAttacks";
const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";

/**
 * Core WFRP 1e recommends Sudden Death Critical Hit tables for missile fire,
 * because many ordinary detailed melee descriptions are inappropriate for
 * arrows, bolts and bullets. This optional World rule deliberately reverses
 * only that routing choice; the ranged damage calculation itself is unchanged.
 *
 * IMPORTANT LOCALIZATION CONTRACT: visible Foundry settings are registered on
 * i18nInit, after translations are loaded and before Settings initialization.
 */
export class RangedCriticalPolicy {
	static settingKey = SETTING_KEY;

	static registerSetting() {
		game.settings.register(game.system.id, SETTING_KEY, {
			name: game.i18n.localize(
				"WFRP1ED.Settings.RangedDetailedCriticals.Name",
			),
			hint: game.i18n.localize(
				"WFRP1ED.Settings.RangedDetailedCriticals.Hint",
			),
			scope: "world",
			config: true,
			type: Boolean,
			default: false,
		});
	}

	static usesDetailedCriticals() {
		try {
			return game.settings.get(game.system.id, SETTING_KEY) === true;
		} catch (_error) {
			return false;
		}
	}

	static criticalMode() {
		return this.usesDetailedCriticals()
			? DAMAGE_CRITICAL_MODE.DETAILED
			: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH;
	}
}

Hooks.once("i18nInit", () => RangedCriticalPolicy.registerSetting());

/*
 * Ranged damage used to create a DamagePacket with DETAILED hard-coded and then
 * tried to rewrite the nested ChatMessage update in preUpdateChatMessage. That
 * is too late and is not a reliable mutation boundary in Foundry v14: the
 * canonical DamagePacket has already been constructed and DamageChat may clone
 * the update data before persistence.
 *
 * DamageChat.attach is the explicit boundary where a combat attack becomes the
 * shared damage transaction. Rebuild only ranged packets here, preserving the
 * same packet id and every damage/mitigation field while replacing the critical
 * routing from the World rule. This makes the packet persisted in damageState
 * authoritative for subsequent DamageApplication and critical resolution.
 */
const originalAttach = DamageChat.attach;
DamageChat.attach = async function rangedCriticalPolicyAttach(
	message,
	{ packet, resolution } = {},
) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family !== "ranged" || !packet) {
		return originalAttach.call(this, message, { packet, resolution });
	}

	const source = packet instanceof DamagePacket
		? packet.toJSON()
		: foundry.utils.deepClone(packet);
	const rewritten = DamagePacket.fromJSON({
		...source,
		critical: {
			...(source?.critical ?? {}),
			mode: RangedCriticalPolicy.criticalMode(),
		},
	});

	return originalAttach.call(this, message, {
		packet: rewritten,
		resolution,
	});
};

/*
 * CombatLifecyclePresentation predates ranged Sudden Death routing. Its linked
 * Damage card therefore still creates a Detailed Critical button for every
 * applied combat critical, while CriticalDamageIntegration correctly creates a
 * Sudden Death launcher on the source Attack card. The result is two conflicting
 * controls for one authoritative damage transaction.
 *
 * Register this presentation repair at ready so its render hook runs after the
 * older lifecycle hooks registered during init. The dedicated Damage card owns
 * the critical action once it exists; the source Attack card keeps only attack
 * history. We do not change the transaction here -- only the UI is normalized
 * to the packet/Actor state already selected above.
 */
Hooks.once("ready", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		scheduleRepair(() => repairRangedCriticalPresentation(message, html));
	});

	Hooks.on("updateActor", (actor) => {
		scheduleRepair(() => refreshVisibleRangedCriticalPresentation(actor));
	});

	scheduleRepair(() => refreshAllVisibleRangedCriticalPresentation());
});

function scheduleRepair(callback) {
	requestAnimationFrame(() => {
		setTimeout(() => callback(), 0);
	});
}

function repairRangedCriticalPresentation(message, html) {
	const root = asElement(html);
	if (!root) return;

	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (view?.sourceAttackMessageId) {
		repairDedicatedDamageCritical(message, root, view);
		return;
	}

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damage = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (attack?.family !== "ranged" || !damage?.packet?.id) return;
	if (!findDamageResultView(message.id, damage.packet.id)) return;

	/* The linked Damage card is the single critical-action surface. */
	root.querySelector?.("[data-wfrp-critical-result]")?.remove();
	root.querySelector?.("[data-wfrp-detailed-critical-panel]")?.remove();
}

function repairDedicatedDamageCritical(message, root, view) {
	const sourceMessage = game.messages?.get(String(view.sourceAttackMessageId ?? ""));
	const attack = sourceMessage?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (attack?.family !== "ranged" || !damage?.packet?.id) return;
	if (String(damage.packet.id) !== String(view.packetId ?? "")) return;

	const actions = root.querySelector?.("[data-wfrp-damage-result-actions]");
	if (!(actions instanceof HTMLElement)) return;

	const actor = actorFromUuidSync(
		view.targetActorUuid ?? damage.packet.targetActorUuid,
	);
	const authoritative = actor
		? DamageApplication.transactionFor(actor, view.packetId)
		: null;
	const transaction = authoritative ?? damage.application ?? null;

	/* The packet is the immutable rules-routing snapshot. Do not infer the UI
	 * mode from whether this client can currently resolve the target Actor. */
	const criticalMode = String(
		damage.packet?.critical?.mode ?? transaction?.criticalMode ?? "",
	);

	/* Detailed mode is already rendered correctly by the shared lifecycle. */
	if (criticalMode === DAMAGE_CRITICAL_MODE.DETAILED) return;

	/* Any non-Detailed ranged packet must never expose the legacy Detailed
	 * launcher, even on a client which cannot read the target Actor transaction. */
	actions.replaceChildren();
	if (criticalMode !== DAMAGE_CRITICAL_MODE.SUDDEN_DEATH) return;

	const state = String(transaction?.state ?? damage.application?.state ?? "");
	const criticalValue = Number(
		transaction?.criticalValue ?? damage.application?.criticalValue ?? 0,
	);
	const criticalResolution =
		transaction?.criticalResolution ?? damage.application?.criticalResolution ?? null;

	if (
		state !== "applied" ||
		criticalValue <= 0 ||
		criticalResolution ||
		!canResolveSourceCritical(sourceMessage, damage, game.user)
	) {
		return;
	}

	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1e-critical-result__action";
	button.dataset.wfrpResolveCritical = "";
	button.innerHTML = `<i class="fa-solid fa-skull"></i> ${localize(
		"Resolve Critical",
		"Rozstrzygnij trafienie krytyczne",
	)}`;
	button.addEventListener("click", () => {
		button.disabled = true;
		void resolveDamageMessageCritical(sourceMessage)
			.catch((error) => {
				console.error("WFRP1ED | Unable to resolve ranged Sudden Death critical.", error);
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
	actions.append(button);
}

function refreshVisibleRangedCriticalPresentation(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		if (
			view?.sourceAttackMessageId &&
			String(view.targetActorUuid ?? "") === String(actor.uuid ?? "")
		) {
			const entry = visibleMessageEntry(message.id);
			if (entry) repairRangedCriticalPresentation(message, entry);
			continue;
		}

		const damage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		if (String(damage?.packet?.targetActorUuid ?? "") !== String(actor.uuid ?? "")) {
			continue;
		}
		const entry = visibleMessageEntry(message.id);
		if (entry) repairRangedCriticalPresentation(message, entry);
	}
}

function refreshAllVisibleRangedCriticalPresentation() {
	for (const message of game.messages ?? []) {
		const entry = visibleMessageEntry(message.id);
		if (entry) repairRangedCriticalPresentation(message, entry);
	}
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
		? document.querySelector(`[data-message-id="${id}"]`)
		: null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
