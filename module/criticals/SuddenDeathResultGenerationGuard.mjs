import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const DAMAGE_STATE_FLAG_KEY = "damageState";

const GUARDED_CONTEXT_LABELS = new Set([
	"Invalidate critical",
	"Unieważnij trafienie krytyczne",
	"Spend Fate Point",
	"Wydaj Punkt Przeznaczenia",
]);

/*
 * One DamagePacket may be resolved against Sudden Death more than once across
 * an explicit invalidate -> resolve-again correction cycle. Each resolution is
 * intentionally kept as a roll-bearing ChatMessage for audit, but only the
 * newest active generation may remain interactive.
 *
 * Older cards used to become active again because their packetId still matched
 * the same applied Damage transaction. Once a new criticalResolution existed,
 * FatalCriticalIntegration and the manual-roll editor saw only "same packet +
 * active resolution" and therefore decorated every historical card with a live
 * K100 input and Apply Fatal button.
 *
 * The Actor-side damage transaction already contains everything required to
 * distinguish generations:
 * - invalidation appends the old resultMessageId to criticalHistory;
 * - every Sudden Death resolution carries resolvedAt, including manual edits.
 *
 * This module is deliberately loaded after all ordinary critical decorators. It
 * is the final UI/action guard: historical cards stay visible as audit records,
 * but their inputs/listeners and consequence buttons are removed permanently.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateHistoricalSuddenDeath(message, html));
});

Hooks.on("updateActor", (actor) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	requestAnimationFrame(() => refreshActorCards(actor));
});

Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	if (!Array.isArray(menuItems)) return;

	for (const item of menuItems) {
		if (!GUARDED_CONTEXT_LABELS.has(String(item?.label ?? ""))) continue;
		const previousVisible = item.visible;
		item.visible = (target) => {
			const message = messageFromContextTarget(target);
			const context = suddenDeathContext(message);
			if (context && !isCurrentGeneration(context)) return false;
			return typeof previousVisible === "function"
				? previousVisible(target)
				: previousVisible !== false;
		};
	}
});

function decorateHistoricalSuddenDeath(message, html) {
	const context = suddenDeathContext(message);
	if (!context) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-critical-card]");
	if (!(card instanceof HTMLElement)) return;
	if (card.hasAttribute("data-wfrp-detailed-critical-card")) return;

	card.querySelector?.("[data-wfrp-critical-history-status]")?.remove();
	card.classList.remove("is-invalidated", "is-superseded");

	const reason = historicalReason(context);
	if (!reason) return;

	card.classList.add(reason === "superseded" ? "is-superseded" : "is-invalidated");

	/* Remove every consequence control which earlier decorators may have attached
	 * to the same packet. A historical roll can never apply death or spend Fate. */
	for (const selector of [
		"[data-wfrp-fatal-application]",
		"[data-wfrp-fate-intervention]",
		"[data-wfrp-sudden-death-fate-fallback]",
	]) {
		for (const element of card.querySelectorAll(selector)) element.remove();
	}

	/* Clone the old input before making it read-only. cloneNode intentionally
	 * drops JavaScript listeners, so a stale change listener from the manual-roll
	 * integration cannot mutate the newest critical generation. */
	const input = card.querySelector("[data-wfrp-sudden-death-roll-input]");
	if (input instanceof HTMLInputElement) {
		const historical = input.cloneNode(true);
		historical.readOnly = true;
		historical.disabled = false;
		historical.tabIndex = -1;
		historical.classList.remove("is-editable");
		historical.classList.add("is-readonly");
		historical.title = localize(
			"This Sudden Death roll is historical and cannot be edited.",
			"Ten rzut Nagłej Śmierci jest historyczny i nie można go edytować.",
		);
		input.replaceWith(historical);
	}

	const status = card.ownerDocument.createElement("div");
	status.dataset.wfrpCriticalHistoryStatus = "";
	status.className = "wfrp1e-critical-result__pending";
	status.textContent = reason === "superseded"
		? localize(
			"Superseded by a newer Sudden Death resolution — historical result.",
			"Zastąpiono nowszym rozstrzygnięciem Nagłej Śmierci — wynik historyczny.",
		)
		: localize(
			"Critical invalidated — historical result.",
			"Trafienie krytyczne unieważnione — wynik historyczny.",
		);
	card.append(status);
}

function historicalReason(context) {
	if (!context?.transaction) return "invalidated";

	const messageId = String(context.message?.id ?? "");
	const history = Array.isArray(context.transaction.criticalHistory)
		? context.transaction.criticalHistory
		: [];
	if (
		messageId &&
		history.some((entry) => String(entry?.resultMessageId ?? "") === messageId)
	) {
		return "invalidated";
	}

	const current = context.transaction.criticalResolution;
	if (!current) return "invalidated";

	const resultAt = Number(context.result?.resolution?.resolvedAt);
	const currentAt = Number(current?.resolvedAt);
	if (
		Number.isFinite(resultAt) &&
		Number.isFinite(currentAt) &&
		resultAt !== currentAt
	) {
		return "superseded";
	}

	/* Compatibility fallback for old result snapshots missing resolvedAt. The
	 * current and historical table snapshots normally differ in at least one of
	 * these persisted adjudication fields. */
	if (!Number.isFinite(resultAt) || !Number.isFinite(currentAt)) {
		const resultSignature = resolutionSignature(context.result?.resolution);
		const currentSignature = resolutionSignature(current);
		if (resultSignature !== currentSignature) return "superseded";
	}

	return null;
}

function isCurrentGeneration(context) {
	return historicalReason(context) === null;
}

function resolutionSignature(resolution) {
	return JSON.stringify({
		criticalValue: Number(resolution?.criticalValue ?? 0),
		variant: String(resolution?.variant ?? ""),
		tableUuid: String(resolution?.tableUuid ?? ""),
		roll: Number(resolution?.roll?.total ?? NaN),
		outcome: String(resolution?.outcome ?? ""),
		resolvedBy: String(resolution?.resolvedBy ?? ""),
	});
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
		actor,
		packetId,
		transaction: DamageApplication.transactionFor(actor, packetId),
	};
}

function refreshActorCards(actor) {
	for (const message of game.messages ?? []) {
		const context = suddenDeathContext(message);
		if (context?.actor?.uuid !== actor.uuid) continue;

		for (const hostDocument of renderedHostDocuments()) {
			const entry = hostDocument.querySelector?.(
				`[data-message-id="${cssEscape(String(message.id ?? ""))}"]`,
			);
			if (entry) decorateHistoricalSuddenDeath(message, entry);
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
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape
		? CSS.escape(text)
		: text.replace(/["\\]/g, "\\$&");
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
