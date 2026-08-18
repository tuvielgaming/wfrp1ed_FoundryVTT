import { DamageApplication } from "../damage/DamageApplication.mjs";
import { CriticalWoundApplication } from "../criticals/CriticalWoundApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const DAMAGE_REVERTED_STATE = "reverted";
const DAMAGE_APPLIED_STATE = "applied";

/*
 * Actionable chat cards keep their original full presentation. Only completed
 * transactions become compact historical disclosures. This module is loaded
 * after the normal combat/Critical presentation layers, so it folds the final
 * rendered card without taking ownership of any rule or action lifecycle.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	applyDamageHistoryDisclosure(message, html);
	applyCriticalHistoryDisclosure(message, html);
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
}

function applyCriticalHistoryDisclosure(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!isDetailedCriticalState(state)) return;

	const root = asElement(html);
	if (!root) return;
	const card = findCard(root, "[data-wfrp-detailed-critical-card]");
	if (!(card instanceof HTMLElement)) return;

	const wound = existingCriticalWound(message, state);
	if (!wound) {
		restoreActionableCriticalCard(card);
		return;
	}

	const details = compactCriticalCard(card);
	if (details instanceof HTMLDetailsElement) {
		details.open = false;
		details.classList.add("is-settled");
	}
}

function existingCriticalWound(message, state) {
	const sourceMessage = game.messages?.get(
		String(state?.sourceMessageId ?? ""),
	);
	const damageState = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const actor = actorFromUuidSync(damageState?.packet?.targetActorUuid);
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

function restoreActionableDamageCard(card) {
	if (!(card instanceof HTMLDetailsElement)) return card;

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
