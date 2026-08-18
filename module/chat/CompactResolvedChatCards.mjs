import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";

const DAMAGE_REVERTED_STATE = "reverted";
const DAMAGE_APPLIED_STATE = "applied";

installDamageDisclosurePresentation();

/* Existing ChatMessages store rendered HTML. Retrofit historical detailed
 * Critical cards at render time so the compact presentation is not limited to
 * messages created after this update. New messages already use <details> in the
 * Handlebars template and pass through unchanged. */
Hooks.on("renderChatMessageHTML", (_message, html) => {
	retrofitDetailedCriticalDisclosure(html);
});

function installDamageDisclosurePresentation() {
	if (DamageChat.__wfrpCompactDisclosureInstalled === true) return;

	const originalContext = DamageChat._templateContext;
	DamageChat._templateContext = function compactDamageTemplateContext(
		state,
		actor,
		transaction,
	) {
		const context = originalContext.call(this, state, actor, transaction);
		context.compactStatusLabel = compactDamageStatus(transaction);
		context.collapsed = isSettledDamage(transaction);
		return context;
	};

	const originalApplyClientState = DamageChat.applyClientState;
	DamageChat.applyClientState = function compactDamageClientState(message, html) {
		originalApplyClientState.call(this, message, html);

		const state = this._stateFromMessage(message);
		if (!state || state.presentation !== "standalone") return;

		const root = asElement(html);
		let card = root?.matches?.("[data-wfrp-damage-card]")
			? root
			: root?.querySelector?.("[data-wfrp-damage-card]");
		if (!card) return;

		card = retrofitDamageDisclosure(card);

		const actor = this._targetActorSync(state);
		const transaction = actor instanceof foundry.documents.Actor
			? DamageApplication.transactionFor(actor, state.packet.id)
			: state.application ?? null;
		const transactionState = String(transaction?.state ?? "pending");
		const settled = isSettledDamage(transaction);
		const compactStatus = card.querySelector?.(
			"[data-wfrp-damage-compact-status]",
		);

		if (compactStatus) {
			const label = compactDamageStatus(transaction);
			compactStatus.textContent = label;
			compactStatus.hidden = !label;
		}

		card.classList.toggle("is-settled", settled);
		card.classList.toggle(
			"is-applied",
			transactionState === DAMAGE_APPLIED_STATE,
		);
		card.classList.toggle(
			"is-wfrp-transaction-reverted",
			transactionState === DAMAGE_REVERTED_STATE,
		);

		/* Fold exactly once when the transaction crosses into a new state. The
		 * user may expand the card afterwards and ordinary client refreshes do not
		 * immediately force it closed again. A full chat rerender naturally starts
		 * from the requested default-collapsed state. */
		if (
			card instanceof HTMLDetailsElement &&
			card.dataset.wfrpDisclosureState !== transactionState
		) {
			card.dataset.wfrpDisclosureState = transactionState;
			if (settled) card.open = false;
		}
	};

	Object.defineProperty(
		DamageChat,
		"__wfrpCompactDisclosureInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function retrofitDamageDisclosure(card) {
	if (card instanceof HTMLDetailsElement) return card;

	const header = [...card.children].find((element) =>
		element.classList?.contains("wfrp1e-damage-card__header"),
	);
	if (!(header instanceof HTMLElement)) return card;

	const details = document.createElement("details");
	copyAttributes(card, details);

	const summary = document.createElement("summary");
	summary.className = header.className;
	const headline = document.createElement("span");
	headline.className = "wfrp1e-damage-card__headline";
	while (header.firstChild) headline.append(header.firstChild);

	const compactStatus = document.createElement("span");
	compactStatus.className = "wfrp1e-damage-card__compact-status";
	compactStatus.dataset.wfrpDamageCompactStatus = "";
	compactStatus.hidden = true;
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

function retrofitDetailedCriticalDisclosure(html) {
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card || card instanceof HTMLDetailsElement) return;

	const header = [...card.children].find((element) =>
		element.classList?.contains("wfrp1e-critical-result__header"),
	);
	if (!(header instanceof HTMLElement)) return;

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
}

function copyAttributes(source, target) {
	for (const attribute of source.attributes ?? []) {
		target.setAttribute(attribute.name, attribute.value);
	}
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

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
