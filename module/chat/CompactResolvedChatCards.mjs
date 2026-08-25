import { DamageApplication } from "../damage/DamageApplication.mjs";
import { CriticalWoundApplication } from "../criticals/CriticalWoundApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const DAMAGE_REVERTED_STATE = "reverted";
const DAMAGE_APPLIED_STATE = "applied";
const KILLED_OUTCOME = "killed";

/*
 * Actionable chat cards keep their original full presentation. Only completed
 * transactions become compact historical disclosures.
 *
 * The normal combat/Critical presentation hooks decorate the rendered DOM with
 * live action buttons during renderChatMessageHTML. This module can be imported
 * before some of those hooks are registered during init, so running synchronously
 * here may fold the card before its actions exist. Defer one animation frame and
 * compact the final decorated DOM instead.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		applyDamageHistoryDisclosure(message, html);
		applyCriticalHistoryDisclosure(message, html);
	});
});

/* A normal detailed Critical becomes historical when its persistent Critical
 * Wound Item is created on the Actor. That embedded-document transition does not
 * necessarily rerender the source ChatMessage, so refresh only the linked visible
 * Critical result card using the stored resultMessageId. */
Hooks.on("createItem", (item) => {
	if (!(item instanceof foundry.documents.Item)) return;
	if (item.type !== "criticalWound") return;

	const resultMessageId = String(
		item.system?.resolution?.resultMessageId ?? "",
	).trim();
	if (!resultMessageId) return;

	requestAnimationFrame(() => refreshVisibleCriticalResult(resultMessageId));
});

/* Fatal Critical application mutates the Actor and its presentation is refreshed
 * directly on the existing chat DOM. Catch that authoritative Actor-side state
 * transition as well so a just-applied fatal result folds without requiring a
 * full chat rerender. */
Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!fatalApplicationsChanged(changes)) return;

	requestAnimationFrame(() => refreshVisibleFatalCriticalCards(actor));
});

function applyDamageHistoryDisclosure(message, html) {
	const root = asElement(html);
	if (!root) return;

	const standalone = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (standalone?.packet?.id) {
		const actor = actorFromUuidSync(standalone.packet.targetActorUuid);
		const transaction = actor
			? DamageApplication.transactionFor(actor, standalone.packet.id)
			: standalone.application ?? null;
		const card = findCard(root, "[data-wfrp-damage-card]");
		applyDamageCardState(card, transaction);
		return;
	}

	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.packetId) return;

	const sourceMessage = game.messages?.get(
		String(view.sourceAttackMessageId ?? ""),
	);
	const sourceState = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const actor = actorFromUuidSync(
		view.targetActorUuid ?? sourceState?.packet?.targetActorUuid,
	);
	const transaction = actor
		? DamageApplication.transactionFor(actor, view.packetId)
		: sourceState?.application ?? null;
	const card = findCard(root, "[data-wfrp-combat-damage-result-card]");
	applyDamageCardState(card, transaction);
}

function applyDamageCardState(card, transaction) {
	if (!(card instanceof HTMLElement)) return;

	if (!isSettledDamage(transaction)) {
		restoreActionableDamageCard(card);
		return;
	}

	const details = compactDamageCard(card);
	if (!(details instanceof HTMLDetailsElement)) return;

	const state = String(transaction?.state ?? "");
	const compactStatus = details.querySelector(
		"[data-wfrp-damage-compact-status]",
	);
	if (compactStatus) {
		compactStatus.textContent = compactDamageStatus(transaction);
		compactStatus.hidden = false;
	}

	details.classList.add("is-settled");
	details.classList.toggle("is-applied", state === DAMAGE_APPLIED_STATE);
	details.classList.toggle(
		"is-wfrp-transaction-reverted",
		state === DAMAGE_REVERTED_STATE,
	);
	details.open = false;
	syncVisibleCriticalAction(details, transaction);
}

function applyCriticalHistoryDisclosure(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!isDetailedCriticalState(state)) return;

	const root = asElement(html);
	if (!root) return;
	const card = findCard(root, "[data-wfrp-detailed-critical-card]");
	if (!(card instanceof HTMLElement)) return;

	if (!isSettledCriticalResult(message, state)) {
		restoreActionableCriticalCard(card);
		return;
	}

	const details = compactCriticalCard(card);
	if (details instanceof HTMLDetailsElement) {
		details.open = false;
		details.classList.add("is-settled");
	}
}

function isSettledCriticalResult(message, state) {
	if (existingCriticalWound(message, state)) return true;
	return fatalCriticalApplied(state);
}

function existingCriticalWound(message, state) {
	const actor = actorForCriticalState(state);
	if (!(actor instanceof foundry.documents.Actor)) return null;

	try {
		return CriticalWoundApplication.existingForResolution(
			actor,
			{ resultMessageId: String(message?.id ?? "") },
		) ?? null;
	} catch (_error) {
		return null;
	}
}

function fatalCriticalApplied(state) {
	if (state?.resolution?.outcome !== KILLED_OUTCOME) return false;

	const actor = actorForCriticalState(state);
	if (!(actor instanceof foundry.documents.Actor)) return false;

	const packetId = String(state?.packetId ?? "").trim();
	if (!packetId) return false;

	const application = actor.getFlag?.(
		FLAG_SCOPE,
		FATAL_APPLICATIONS_FLAG_KEY,
	)?.[packetId];
	return application?.state === DAMAGE_APPLIED_STATE;
}

function actorForCriticalState(state) {
	const sourceMessage = game.messages?.get(
		String(state?.sourceMessageId ?? ""),
	);
	const damageState = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	return actorFromUuidSync(damageState?.packet?.targetActorUuid);
}

function refreshVisibleCriticalResult(messageId) {
	const message = game.messages?.get(String(messageId ?? ""));
	if (!message) return;

	const entry = document.querySelector(
		`[data-message-id="${String(message.id ?? "")}"]`,
	);
	if (entry) applyCriticalHistoryDisclosure(message, entry);
}

function refreshVisibleFatalCriticalCards(actor) {
	for (const message of game.messages ?? []) {
		const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
		if (!isDetailedCriticalState(state)) continue;
		if (state?.resolution?.outcome !== KILLED_OUTCOME) continue;

		const target = actorForCriticalState(state);
		if (target?.uuid !== actor.uuid) continue;

		const entry = document.querySelector(
			`[data-message-id="${String(message.id ?? "")}"]`,
		);
		if (entry) applyCriticalHistoryDisclosure(message, entry);
	}
}

function fatalApplicationsChanged(changes) {
	if (!changes || typeof changes !== "object") return false;

	const scoped = changes?.flags?.[FLAG_SCOPE];
	if (
		scoped &&
		typeof scoped === "object" &&
		(
			Object.hasOwn(scoped, FATAL_APPLICATIONS_FLAG_KEY) ||
			Object.hasOwn(scoped, `-=${FATAL_APPLICATIONS_FLAG_KEY}`)
		)
	) {
		return true;
	}

	return Object.keys(changes).some((key) =>
		String(key).includes(FATAL_APPLICATIONS_FLAG_KEY),
	);
}

function compactDamageCard(card) {
	if (card instanceof HTMLDetailsElement) {
		ensureDamageCompactStatus(card);
		return card;
	}

	const header = directChildWithClass(card, "wfrp1e-damage-card__header");
	if (!(header instanceof HTMLElement)) return null;

	const details = document.createElement("details");
	copyAttributes(card, details);

	const summary = document.createElement("summary");
	summary.className = header.className;
	const headline = document.createElement("span");
	headline.className = "wfrp1e-damage-card__headline";
	while (header.firstChild) headline.append(header.firstChild);

	const compactStatus = createCompactDamageStatus();
	summary.append(headline, compactStatus);

	const body = document.createElement("div");
	body.className = "wfrp1e-damage-card__details";
	for (const child of [...card.childNodes]) {
		if (child === header) continue;
		body.append(child);
	}

	details.append(summary, body);
	card.replaceWith(details);
	return details;
}

/* Applied damage is historical, but an unresolved Detailed or Sudden Death
 * Critical is still an actionable continuation of that damage. Keep only that
 * action visible below the compact header while the full audit remains folded. */
function syncVisibleCriticalAction(details, transaction) {
	const existing = persistentCriticalActionHost(details);
	const unresolved = Boolean(
		String(transaction?.state ?? "") === DAMAGE_APPLIED_STATE &&
		Number(transaction?.criticalValue) > 0 &&
		!transaction?.criticalResolution,
	);

	if (!unresolved) {
		existing?.remove();
		return;
	}

	const button =
		details.querySelector?.("[data-wfrp-resolve-detailed-critical]") ??
		details.querySelector?.("[data-wfrp-resolve-critical]") ??
		details.querySelector?.(
			"[data-wfrp-damage-result-actions] .wfrp1e-critical-result__action",
		);

	/* If this DOM was already compacted, the live action is already outside the
	 * details element. Keep it there until the transaction records a resolution. */
	if (!(button instanceof HTMLButtonElement)) return;

	existing?.remove();
	const host = document.createElement("div");
	host.className = "wfrp1e-damage-card__persistent-actions";
	host.dataset.wfrpDamagePersistentActions = "";
	host.append(button);
	details.after(host);
}

function persistentCriticalActionHost(details) {
	const sibling = details?.nextElementSibling;
	return sibling instanceof HTMLElement &&
		sibling.hasAttribute("data-wfrp-damage-persistent-actions")
		? sibling
		: null;
}

function restoreActionableDamageCard(card) {
	if (!(card instanceof HTMLDetailsElement)) return card;

	persistentCriticalActionHost(card)?.remove();

	const summary = directChildTag(card, "SUMMARY");
	const body = directChildWithClass(card, "wfrp1e-damage-card__details");
	if (!(summary instanceof HTMLElement) || !(body instanceof HTMLElement)) {
		card.open = true;
		return card;
	}

	const replacement = document.createElement(
		card.hasAttribute("data-wfrp-combat-damage-result-card")
			? "section"
			: "article",
	);
	copyAttributes(card, replacement, { omit: new Set(["open"]) });
	replacement.classList.remove("is-settled");

	const header = document.createElement(
		card.hasAttribute("data-wfrp-combat-damage-result-card")
			? "div"
			: "header",
	);
	header.className = summary.className;
	const headline = summary.querySelector(".wfrp1e-damage-card__headline");
	if (headline) {
		while (headline.firstChild) header.append(headline.firstChild);
	} else {
		for (const child of [...summary.childNodes]) {
			if (child instanceof HTMLElement && child.hasAttribute("data-wfrp-damage-compact-status")) continue;
			header.append(child);
		}
	}
	replacement.append(header);

	while (body.firstChild) replacement.append(body.firstChild);
	for (const child of [...card.childNodes]) {
		if (child === summary || child === body) continue;
		replacement.append(child);
	}

	card.replaceWith(replacement);
	return replacement;
}

function compactCriticalCard(card) {
	if (card instanceof HTMLDetailsElement) return card;

	const header = directChildWithClass(card, "wfrp1e-critical-result__header");
	if (!(header instanceof HTMLElement)) return null;

	const details = document.createElement("details");
	copyAttributes(card, details);

	const summary = document.createElement("summary");
	summary.className = header.className;
	while (header.firstChild) summary.append(header.firstChild);

	const body = document.createElement("div");
	body.className = "wfrp1e-critical-result__details";
	for (const child of [...card.childNodes]) {
		if (child === header) continue;
		body.append(child);
	}

	details.append(summary, body);
	card.replaceWith(details);
	return details;
}

function restoreActionableCriticalCard(card) {
	if (!(card instanceof HTMLDetailsElement)) return card;

	const summary = directChildTag(card, "SUMMARY");
	const body = directChildWithClass(card, "wfrp1e-critical-result__details");
	if (!(summary instanceof HTMLElement) || !(body instanceof HTMLElement)) {
		card.open = true;
		return card;
	}

	const section = document.createElement("section");
	copyAttributes(card, section, { omit: new Set(["open"]) });
	section.classList.remove("is-settled");

	const header = document.createElement("div");
	header.className = summary.className;
	while (summary.firstChild) header.append(summary.firstChild);
	section.append(header);

	while (body.firstChild) section.append(body.firstChild);
	for (const child of [...card.childNodes]) {
		if (child === summary || child === body) continue;
		section.append(child);
	}

	card.replaceWith(section);
	return section;
}

function ensureDamageCompactStatus(details) {
	const summary = directChildTag(details, "SUMMARY");
	if (!(summary instanceof HTMLElement)) return;
	if (summary.querySelector("[data-wfrp-damage-compact-status]")) return;
	const status = createCompactDamageStatus();
	status.hidden = true;
	summary.append(status);
}

function createCompactDamageStatus() {
	const status = document.createElement("span");
	status.className = "wfrp1e-damage-card__compact-status";
	status.dataset.wfrpDamageCompactStatus = "";
	return status;
}

function directChildWithClass(parent, className) {
	return [...(parent?.children ?? [])].find((element) =>
		element.classList?.contains(className),
	) ?? null;
}

function directChildTag(parent, tagName) {
	return [...(parent?.children ?? [])].find((element) =>
		String(element.tagName ?? "").toUpperCase() === tagName,
	) ?? null;
}

function findCard(root, selector) {
	return root.matches?.(selector)
		? root
		: root.querySelector?.(selector) ?? null;
}

function copyAttributes(source, target, { omit = new Set() } = {}) {
	for (const attribute of source.attributes ?? []) {
		if (omit.has(attribute.name)) continue;
		target.setAttribute(attribute.name, attribute.value);
	}
}

function isDetailedCriticalState(state) {
	return Boolean(
		state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		state.kind === "detailed" &&
		state.resolution,
	);
}

function isSettledDamage(transaction) {
	return new Set([
		DAMAGE_APPLIED_STATE,
		DAMAGE_REVERTED_STATE,
	]).has(String(transaction?.state ?? ""));
}

function compactDamageStatus(transaction) {
	switch (String(transaction?.state ?? "")) {
		case DAMAGE_APPLIED_STATE:
			return localize("Applied", "Zastosowano");
		case DAMAGE_REVERTED_STATE:
			return localize("Reverted", "Cofnięto");
		default:
			return "";
	}
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return document?.documentName === "Actor"
			? document
			: document?.actor ?? null;
	} catch (_error) {
		return null;
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
