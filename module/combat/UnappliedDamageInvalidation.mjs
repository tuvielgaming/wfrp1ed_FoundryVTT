import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const DAMAGE_REVERTED_STATE = "reverted";
const REVERT_REASON = "gm-invalidated-unapplied";
const { DialogV2 } = foundry.applications.api;

/**
 * A resolved 0-damage result is terminal and therefore never crosses the normal
 * DamageApplication boundary. Positive damage may likewise still be waiting for
 * Apply Damage. Both nevertheless need the same GM correction path as applied
 * damage. Record an explicit non-mutating reverted transaction so the existing
 * combat lifecycle can offer Roll Damage Again without changing Actor Wounds.
 */
Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize("Invalidate damage", "Unieważnij obrażenia"),
		icon: '<i class="fa-solid fa-heart-circle-plus"></i>',
		visible: (target) => canInvalidateUnappliedDamage(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (message) void invalidateUnappliedDamage(message);
		},
	});
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateUnappliedInvalidation(message, html));
});

function canInvalidateUnappliedDamage(message) {
	if (!game.user?.isGM || !message?.id) return false;
	const source = sourceDamageMessage(message);
	if (!source) return false;

	const damage = source.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const roll = source.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!damage?.packet?.id || roll?.status !== "resolved") return false;

	const actor = actorFromUuidSync(damage.packet.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return false;

	/* Applied/reverted damage belongs to the normal authoritative rollback path. */
	return DamageApplication.transactionFor(actor, damage.packet.id) === null;
}

async function invalidateUnappliedDamage(message) {
	try {
		if (!game.user?.isGM) {
			throw new Error("Only a GM can invalidate a resolved damage result.");
		}

		const source = sourceDamageMessage(message);
		const damage = source?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		const roll = source?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		if (!source || !damage?.packet?.id || roll?.status !== "resolved") {
			throw new Error("This ChatMessage no longer contains a resolved damage result.");
		}

		const actor = actorFromUuidSync(damage.packet.targetActorUuid);
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error("The damage target Actor is unavailable.");
		}
		if (DamageApplication.transactionFor(actor, damage.packet.id)) {
			throw new Error("This damage result is already owned by the applied-damage rollback lifecycle.");
		}

		const finalAmount = Math.max(0, Math.trunc(Number(damage.resolution?.finalAmount) || 0));
		const confirmed = await DialogV2.confirm({
			window: {
				title: localize("Invalidate damage", "Unieważnij obrażenia"),
			},
			content: `<p>${escapeHtml(localize(
				`Invalidate this resolved ${finalAmount}-damage result? No Wounds were applied; the original roll will be kept only as invalidated history and the attack will return to Roll Damage.`,
				`Unieważnić rozstrzygnięty wynik ${finalAmount} obrażeń? Nie zastosowano Żywotności; pierwotny rzut pozostanie jedynie jako unieważniona historia, a atak wróci do etapu Rzuć obrażenia.`,
			))}</p>`,
		});
		if (!confirmed) return;

		const applications = applicationMap(actor);
		const currentWounds = readWounds(actor);
		const transaction = {
			version: 3,
			id: foundry.utils.randomID(),
			packetId: String(damage.packet.id),
			targetActorUuid: actor.uuid,
			amountApplied: 0,
			woundsBefore: currentWounds,
			woundsAfter: currentWounds,
			criticalValue: 0,
			criticalMode: String(damage.packet?.critical?.mode ?? "detailed"),
			criticalResolution: null,
			userId: String(game.user?.id ?? ""),
			appliedAt: null,
			state: DAMAGE_REVERTED_STATE,
			revertedAt: Date.now(),
			revertedBy: String(game.user?.id ?? ""),
			revertReason: REVERT_REASON,
		};
		applications[transaction.packetId] = foundry.utils.deepClone(transaction);

		await actor.setFlag(
			FLAG_SCOPE,
			DAMAGE_APPLICATIONS_FLAG_KEY,
			applications,
		);

		const updatedDamage = foundry.utils.deepClone(damage);
		updatedDamage.application = foundry.utils.deepClone(transaction);
		updatedDamage.updatedBy = String(game.user?.id ?? "");
		updatedDamage.updatedAt = Date.now();
		await source.setFlag(FLAG_SCOPE, DAMAGE_FLAG_KEY, updatedDamage);

		void ui.chat?.render?.({ force: true });
	} catch (error) {
		console.error("WFRP1ED | Unable to invalidate unapplied damage.", error);
		ui.notifications.error(error?.message ?? localize(
			"Unable to invalidate this damage result.",
			"Nie udało się unieważnić tego wyniku obrażeń.",
		));
	}
}

function decorateUnappliedInvalidation(message, html) {
	const source = sourceDamageMessage(message);
	if (!source) return;
	const damage = source.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const actor = actorFromUuidSync(damage?.packet?.targetActorUuid);
	const transaction = actor && damage?.packet?.id
		? DamageApplication.transactionFor(actor, damage.packet.id)
		: null;
	if (transaction?.state !== DAMAGE_REVERTED_STATE || transaction?.revertReason !== REVERT_REASON) {
		return;
	}

	const root = asElement(html);
	if (!root) return;
	const label = localize(
		"INVALIDATED · damage result was not applied",
		"UNIEWAŻNIONO · wynik obrażeń nie został zastosowany",
	);

	const dedicated = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (dedicated) {
		const status = root.querySelector?.("[data-wfrp-damage-result-status]");
		if (status) status.textContent = label;
	}

	if (message.id === source.id) {
		for (const status of root.querySelectorAll?.(".combat-damage-context__status") ?? []) {
			status.textContent = label;
			status.classList.add("is-reverted");
		}
	}
}

function sourceDamageMessage(message) {
	if (!message?.id) return null;
	if (message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return message;
	const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	return view?.sourceAttackMessageId
		? game.messages?.get(String(view.sourceAttackMessageId)) ?? null
		: null;
}

function applicationMap(actor) {
	const existing = actor.getFlag?.(FLAG_SCOPE, DAMAGE_APPLICATIONS_FLAG_KEY);
	return existing && typeof existing === "object" && !Array.isArray(existing)
		? foundry.utils.deepClone(existing)
		: {};
}

function readWounds(actor) {
	const value = Number(actor?.system?.status?.wounds?.value);
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
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

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function escapeHtml(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span.innerHTML;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
