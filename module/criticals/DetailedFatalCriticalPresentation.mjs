import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	applyFatalCriticalResult,
	spendFatePointForFatalCritical,
} from "./FatalCriticalIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";

Hooks.on("renderChatMessageHTML", (message, html) => {
	decorateDetailedFatalCritical(message, html);
});

Hooks.on("updateActor", (actor) => {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const state = criticalResultState(message);
		if (state?.resolution?.outcome !== KILLED_OUTCOME) continue;
		const target = actorForCriticalResult(state);
		if (target?.uuid !== actor.uuid) continue;

		const entry = document.querySelector(
			`[data-message-id="${message.id}"]`,
		);
		if (entry) decorateDetailedFatalCritical(message, entry);
	}
});

/**
 * Fatal detailed Critical Hits use the same explicit consequence/Fate lifecycle
 * as Sudden Death, but their result template has a different DOM root. Keep the
 * mechanics in FatalCriticalIntegration and adapt only this presentation.
 */
function decorateDetailedFatalCritical(message, html) {
	const state = criticalResultState(message);
	if (state?.resolution?.outcome !== KILLED_OUTCOME) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	card.querySelector?.("[data-wfrp-detailed-fatal-lifecycle]")?.remove();

	const actor = actorForCriticalResult(state);
	if (!(actor instanceof foundry.documents.Actor)) return;

	const packetId = String(state.packetId ?? "").trim();
	const transaction = DamageApplication.transactionFor(actor, packetId);
	if (
		transaction?.state !== "applied" ||
		transaction?.criticalResolution?.outcome !== KILLED_OUTCOME
	) {
		return;
	}

	const panel = document.createElement("section");
	panel.className = "wfrp1e-fate-intervention";
	panel.dataset.wfrpDetailedFatalLifecycle = "";

	const fatal = actor.getFlag?.(
		FLAG_SCOPE,
		FATAL_APPLICATIONS_FLAG_KEY,
	)?.[packetId];
	const fateIntervention = actor.getFlag?.(
		FLAG_SCOPE,
		FATE_INTERVENTIONS_FLAG_KEY,
	)?.[packetId];

	if (fatal?.state !== "applied") {
		if (!canManageActor(actor, game.user)) {
			panel.append(statusText(localize(
				"Awaiting the GM or target owner to apply this fatal result.",
				"Oczekuje na MG lub właściciela celu, który zastosuje ten śmiertelny wynik.",
			)));
			card.append(panel);
			return;
		}

		const apply = actionButton(
			"fa-solid fa-skull",
			localize(
				"Apply Fatal Critical",
				"Zastosuj śmiertelne trafienie krytyczne",
			),
			() => applyFatalCriticalResult(message),
		);
		panel.append(apply);
		card.append(panel);
		return;
	}

	if (fateIntervention) {
		card.classList.add("is-fate-saved");
		panel.append(statusText(localize(
			"✓ Fate Point spent — death averted",
			"✓ Wydano Punkt Przeznaczenia — uniknięto śmierci",
		)));
		card.append(panel);
		return;
	}

	panel.append(statusText(localize(
		"✓ Fatal critical applied — character is defeated",
		"✓ Zastosowano śmiertelne trafienie krytyczne — postać jest pokonana",
	)));

	if (canManageActor(actor, game.user)) {
		const fate = remainingFate(actor);
		if (fate > 0) {
			const resource = document.createElement("div");
			resource.className = "wfrp1e-fate-intervention__resource";
			resource.textContent = `${localize(
				"Fate Points",
				"Punkty Przeznaczenia",
			)}: ${fate}`;
			panel.append(resource);
			panel.append(actionButton(
				"fa-solid fa-star",
				localize("Spend Fate Point", "Wydaj Punkt Przeznaczenia"),
				() => spendFatePointForFatalCritical(message),
			));
		}
	}

	card.append(panel);
}

function actionButton(icon, label, action) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1e-fate-intervention__action";
	button.innerHTML = `<i class="${icon}"></i> ${label}`;
	button.addEventListener("click", () => {
		button.disabled = true;
		void action().catch((error) => {
			button.disabled = false;
			console.error("WFRP1ED | Detailed fatal critical action failed.", error);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to update the fatal critical result.",
					"Nie udało się zaktualizować śmiertelnego trafienia krytycznego.",
				),
			);
		});
	});
	return button;
}

function statusText(text) {
	const element = document.createElement("div");
	element.className = "wfrp1e-fate-intervention__spent";
	element.textContent = text;
	return element;
}

function criticalResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function actorForCriticalResult(state) {
	if (!state) return null;
	const source = game.messages?.get(String(state.sourceMessageId ?? ""));
	const damage = source?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const uuid = String(damage?.packet?.targetActorUuid ?? "").trim();
	if (!uuid) return null;

	try {
		const actor = foundry.utils.fromUuidSync(uuid);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function canManageActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function remainingFate(actor) {
	const raw = actor?.system?.status?.fate;
	const value = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw.value
		: raw;
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
