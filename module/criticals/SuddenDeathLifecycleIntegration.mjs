import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	spendFatePointForFatalCritical,
	synchronizeFatalStatus,
} from "./FatalCriticalIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";

/*
 * Sudden Death result lifecycle completion.
 *
 * Detailed Criticals already have CriticalTransactionRollback. Sudden Death
 * uses a different result shape (no persistent Critical Wound Item), so this
 * integration owns only the missing Sudden Death correction boundary and a
 * robust Fate presentation/context action. It deliberately reuses the existing
 * FatalCriticalIntegration for the actual Fate expenditure and defeated-state
 * reconciliation.
 *
 * WFRP 1e Core, Fate Points, printed p.72 (English and Polish): a Fate Point may
 * be permanently spent to neutralize a critical result which would otherwise
 * prove fatal. GM invalidation is not a game rule; it is an explicit correction
 * tool and therefore leaves the already-applied Wounds unchanged.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	decorateSuddenDeathFate(message, html);
});

Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize("Spend Fate Point", "Wydaj Punkt Przeznaczenia"),
		icon: '<i class="fa-solid fa-star"></i>',
		visible: (target) => canSpendFateFromMessage(messageFromContextTarget(target)),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (!message) return;
			void spendFatePointForFatalCritical(message).catch(reportFateError);
		},
	});

	menuItems.push({
		label: localize("Invalidate critical", "Unieważnij trafienie krytyczne"),
		icon: '<i class="fa-solid fa-rotate-left"></i>',
		visible: (target) => canInvalidateSuddenDeath(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (!message) return;
			void invalidateSuddenDeath(message).catch(reportRollbackError);
		},
	});
});

Hooks.on("updateActor", (actor) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	requestAnimationFrame(() => refreshActorSuddenDeathCards(actor));
});

function decorateSuddenDeathFate(message, html) {
	const context = suddenDeathContext(message);
	if (!context || context.resolution?.outcome !== KILLED_OUTCOME) return;
	if (context.transaction?.state !== "applied") return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-critical-card]");
	if (!isElement(card)) return;

	card.querySelector?.("[data-wfrp-sudden-death-fate-fallback]")?.remove();

	/* FatalCriticalIntegration is the normal UI owner. If it already rendered
	 * the actionable Fate button or saved status, do not duplicate it. */
	if (
		card.querySelector?.("[data-wfrp-spend-fate]") ||
		context.fateIntervention
	) {
		return;
	}

	if (context.fatalApplication?.state !== "applied") return;
	if (!canManageActor(context.actor, game.user)) return;

	const panel = card.ownerDocument.createElement("section");
	panel.className = "wfrp1e-fate-intervention";
	panel.dataset.wfrpSuddenDeathFateFallback = "";

	const fate = remainingFate(context.actor);
	const resource = card.ownerDocument.createElement("div");
	resource.className = "wfrp1e-fate-intervention__resource";
	resource.textContent = `${localize("Fate Points", "Punkty Przeznaczenia")}: ${fate}`;
	panel.append(resource);

	if (fate > 0) {
		const action = card.ownerDocument.createElement("button");
		action.type = "button";
		action.className = "wfrp1e-fate-intervention__action";
		action.dataset.wfrpSpendFate = "";
		const icon = card.ownerDocument.createElement("i");
		icon.className = "fa-solid fa-star";
		action.append(
			icon,
			card.ownerDocument.createTextNode(
				` ${localize("Spend Fate Point", "Wydaj Punkt Przeznaczenia")}`,
			),
		);
		action.addEventListener("click", () => {
			action.disabled = true;
			void spendFatePointForFatalCritical(message)
				.catch(reportFateError)
				.finally(() => { action.disabled = false; });
		});
		panel.append(action);
	} else {
		const empty = card.ownerDocument.createElement("div");
		empty.className = "wfrp1e-fate-intervention__spent";
		empty.textContent = localize(
			"No Fate Points remain — this death cannot be averted with Fate.",
			"Brak Punktów Przeznaczenia — tej śmierci nie można uniknąć za pomocą PP.",
		);
		panel.append(empty);
	}

	card.append(panel);
}

function canSpendFateFromMessage(message) {
	const context = suddenDeathContext(message);
	return Boolean(
		context &&
		context.resolution?.outcome === KILLED_OUTCOME &&
		context.transaction?.state === "applied" &&
		context.fatalApplication?.state === "applied" &&
		!context.fateIntervention &&
		remainingFate(context.actor) > 0 &&
		canManageActor(context.actor, game.user)
	);
}

function canInvalidateSuddenDeath(message) {
	if (!game.user?.isGM) return false;
	const context = suddenDeathContext(message);
	if (!context) return false;
	if (
		context.transaction?.state !== "applied" ||
		!context.transaction?.criticalResolution
	) return false;
	if (latestAppliedDamage(context.actor)?.packetId !== context.packetId) {
		return false;
	}
	/* Spending Fate is a newer permanent resource transaction. Never silently
	 * refund or erase it as a side effect of a GM result correction. */
	if (context.fateIntervention) return false;
	return true;
}

async function invalidateSuddenDeath(message) {
	const context = suddenDeathContext(message);
	if (!game.user?.isGM || !context) {
		throw new Error("Only a GM can invalidate a Sudden Death result.");
	}
	if (!canInvalidateSuddenDeath(message)) {
		throw new Error(localize(
			"This Sudden Death result can no longer be invalidated at the current transaction boundary.",
			"Tego wyniku Nagłej Śmierci nie można już unieważnić na obecnym etapie transakcji.",
		));
	}

	const confirmed = await foundry.applications.api.DialogV2.confirm({
		window: {
			title: localize("Invalidate Sudden Death", "Unieważnij Nagłą Śmierć"),
		},
		content: `<p>${escapeHtml(localize(
			"Invalidate this Sudden Death result? The already-applied Wounds remain unchanged. Any applied defeated/death consequence from this result will be reverted, and the source Damage returns to an unresolved Critical.",
			"Unieważnić ten wynik Nagłej Śmierci? Zastosowane obrażenia pozostaną bez zmian. Zastosowany skutek pokonania/śmierci z tego wyniku zostanie cofnięty, a źródłowe Obrażenia wrócą do nierozstrzygniętego trafienia krytycznego.",
		))}</p>`,
	});
	if (!confirmed) return;

	const applications = applicationMap(context.actor, DAMAGE_APPLICATIONS_FLAG_KEY);
	const transaction = foundry.utils.deepClone(applications[context.packetId]);
	if (!transaction?.criticalResolution) {
		throw new Error("The Sudden Death resolution is no longer active.");
	}

	const history = Array.isArray(transaction.criticalHistory)
		? foundry.utils.deepClone(transaction.criticalHistory)
		: [];
	history.push({
		resolution: foundry.utils.deepClone(transaction.criticalResolution),
		resultMessageId: String(message.id ?? ""),
		invalidatedAt: Date.now(),
		invalidatedBy: String(game.user?.id ?? ""),
	});
	transaction.criticalHistory = history;
	transaction.criticalResolution = null;
	transaction.criticalInvalidatedAt = Date.now();
	transaction.criticalInvalidatedBy = String(game.user?.id ?? "");
	applications[context.packetId] = transaction;

	const update = {
		[`flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`]: applications,
	};

	if (context.fatalApplication?.state === "applied") {
		const fatalApplications = applicationMap(
			context.actor,
			FATAL_APPLICATIONS_FLAG_KEY,
		);
		fatalApplications[context.packetId] = {
			...foundry.utils.deepClone(context.fatalApplication),
			state: "reverted",
			revertedAt: Date.now(),
			revertedBy: String(game.user?.id ?? ""),
		};
		update[`flags.${FLAG_SCOPE}.${FATAL_APPLICATIONS_FLAG_KEY}`] = fatalApplications;
	}

	await context.actor.update(update);
	if (context.fatalApplication?.state === "applied") {
		await synchronizeFatalStatus(context.actor);
	}

	if (message.canUserModify?.(game.user, "delete") === true) {
		await message.delete();
	}
	void ui.chat?.render?.({ force: true });
}

function suddenDeathContext(message) {
	const result = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!isRecord(result) || result.kind === "detailed" || !result.resolution) {
		return null;
	}

	const sourceMessage = game.messages?.get(String(result.sourceMessageId ?? ""));
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const actor = actorFromUuidSync(damage?.packet?.targetActorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return null;

	const packetId = String(result.packetId ?? damage?.packet?.id ?? "").trim();
	if (!packetId) return null;

	return {
		message,
		result,
		resolution: result.resolution,
		sourceMessage,
		damage,
		actor,
		packetId,
		transaction: DamageApplication.transactionFor(actor, packetId),
		fatalApplication: applicationMap(actor, FATAL_APPLICATIONS_FLAG_KEY)[packetId] ?? null,
		fateIntervention: applicationMap(actor, FATE_INTERVENTIONS_FLAG_KEY)[packetId] ?? null,
	};
}

function latestAppliedDamage(actor) {
	return Object.entries(applicationMap(actor, DAMAGE_APPLICATIONS_FLAG_KEY))
		.map(([packetId, transaction]) => ({
			...foundry.utils.deepClone(transaction),
			packetId: String(transaction?.packetId ?? packetId),
		}))
		.filter((transaction) => transaction.state === "applied")
		.sort((left, right) =>
			(Number(right.appliedAt ?? 0) - Number(left.appliedAt ?? 0)) ||
			String(right.id ?? "").localeCompare(String(left.id ?? "")),
		)[0] ?? null;
}

function refreshActorSuddenDeathCards(actor) {
	for (const message of game.messages ?? []) {
		const context = suddenDeathContext(message);
		if (context?.actor?.uuid !== actor.uuid) continue;
		for (const hostDocument of renderedHostDocuments()) {
			const entry = hostDocument.querySelector?.(
				`[data-message-id="${cssEscape(String(message.id ?? ""))}"]`,
			);
			if (entry) decorateSuddenDeathFate(message, entry);
		}
	}
}

function renderedHostDocuments() {
	const documents = new Set([document]);
	const instances = foundry.applications?.instances;
	if (instances?.values) {
		for (const application of instances.values()) {
			const hostDocument = application?.element?.ownerDocument;
			if (hostDocument?.querySelector) documents.add(hostDocument);
		}
	}
	return documents;
}

function remainingFate(actor) {
	const raw = actor?.system?.status?.fate;
	const value = isRecord(raw) ? raw.value : raw;
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function canManageActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function applicationMap(actor, key) {
	const existing = actor?.getFlag?.(FLAG_SCOPE, key);
	return isRecord(existing) ? foundry.utils.deepClone(existing) : {};
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
	const element = asElement(target);
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const id = String(
		entry?.dataset?.messageId ??
		target?.attr?.("data-message-id") ??
		target?.data?.("message-id") ??
		"",
	).trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function asElement(value) {
	if (isElement(value)) return value;
	if (isElement(value?.[0])) return value[0];
	return null;
}

function isElement(value) {
	return Boolean(
		value &&
		value.nodeType === 1 &&
		typeof value.querySelector === "function",
	);
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapeHtml(value) {
	const span = document.createElement("span");
	span.textContent = String(value ?? "");
	return span.innerHTML;
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape
		? CSS.escape(text)
		: text.replace(/["\\]/g, "\\$&");
}

function reportFateError(error) {
	console.error("WFRP1ED | Sudden Death Fate action failed.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to spend the Fate Point.",
		"Nie udało się wydać Punktu Przeznaczenia.",
	));
}

function reportRollbackError(error) {
	console.error("WFRP1ED | Unable to invalidate Sudden Death.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to invalidate the Sudden Death result.",
		"Nie udało się unieważnić wyniku Nagłej Śmierci.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
