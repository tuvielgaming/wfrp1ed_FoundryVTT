import { DamageApplication } from "../damage/DamageApplication.mjs";
import { SUDDEN_DEATH_OUTCOME } from "./CoreSuddenDeathTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const FATE_INTERVENTION_VERSION = 1;

/**
 * Apply the fatal consequence of a Sudden Death result and expose the WFRP 1e
 * Fate Point escape to the GM or owner of the dying Actor.
 *
 * The table result remains immutable: a fatal roll is still recorded as
 * "killed". Spending Fate is stored as a separate Actor-side consequence so
 * the history records both the fatal result and the later intervention.
 */
export function registerFatalCriticalIntegration() {
	Hooks.on("updateActor", (actor, changes, _options, userId) => {
		refreshActorFatalCriticalCards(actor);

		if (!damageApplicationsChanged(changes)) {
			return;
		}

		// Status Śmierci zapisuje tylko jeden klient autorytatywny. Gdy MG jest
		// aktywny robi to pierwszy aktywny MG; bez MG może to zrobić właściciel
		// Actor-a, który właśnie zapisał wynik krytyczny.
		if (!isFatalStatusWriter(actor, userId)) {
			return;
		}

		void synchronizeFatalStatus(actor).catch((error) => {
			console.error(
				"WFRP1ED | Unable to apply defeated status after fatal critical.",
				error,
			);
			ui.notifications.warn(
				localize(
					"WFRP1ED.Critical.DeadStatusFailed",
					"The critical result is fatal, but the defeated status could not be applied.",
					"Wynik krytyczny oznacza śmierć, ale nie udało się zastosować statusu pokonanego.",
				),
			);
		});
	});

	Hooks.on("renderChatMessageHTML", (message, html) => {
		applyFatalCriticalClientState(message, html);
	});
}

/**
 * Permanently spend one Fate Point to avert one already-recorded fatal result.
 *
 * @param {ChatMessage} message Separate critical-result ChatMessage.
 * @param {User} user
 * @returns {Promise<Object>}
 */
export async function spendFatePointForFatalCritical(
	message,
	user = game.user,
) {
	const resultState = criticalResultState(message);
	const actor = actorForCriticalResult(resultState);

	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The critical target Actor is not available.");
	}

	if (!canManageFatalActor(actor, user)) {
		throw new Error(
			"Only a GM or an owner of the dying Actor may spend its Fate Point.",
		);
	}

	const packetId = String(resultState?.packetId ?? "").trim();
	const transaction = DamageApplication.transactionFor(actor, packetId);

	if (
		transaction?.criticalResolution?.outcome !==
		SUDDEN_DEATH_OUTCOME.KILLED
	) {
		throw new Error(
			"A Fate Point can only be spent here for a fatal critical result.",
		);
	}

	const existingIntervention = fateInterventionFor(actor, packetId);
	if (existingIntervention) {
		await setDefeatedStatus(actor, false);
		return existingIntervention;
	}

	const fate = readFateResource(actor);
	if (!fate.path || fate.value <= 0) {
		throw new Error(
			localize(
				"WFRP1ED.Critical.NoFatePoints",
				"No Fate Points remain.",
				"Brak pozostałych Punktów Przeznaczenia.",
			),
		);
	}

	const interventions = readFateInterventionMap(actor);
	const intervention = {
		version: FATE_INTERVENTION_VERSION,
		packetId,
		targetActorUuid: actor.uuid,
		fateBefore: fate.value,
		fateAfter: fate.value - 1,
		userId: String(user?.id ?? ""),
		spentAt: Date.now(),
	};

	interventions[packetId] = foundry.utils.deepClone(intervention);

	// Punkt Przeznaczenia i ślad jego wydania zapisujemy w jednym update Actor-a.
	// Dzięki temu odświeżenie karty zawsze może odtworzyć ostateczny stan.
	await actor.update({
		[fate.path]: intervention.fateAfter,
		[`flags.${FLAG_SCOPE}.${FATE_INTERVENTIONS_FLAG_KEY}`]: interventions,
	});

	await setDefeatedStatus(actor, false);
	refreshActorFatalCriticalCards(actor);

	ui.notifications.info(
		localize(
			"WFRP1ED.Critical.FateSpentNotice",
			`Spent 1 Fate Point. ${actor.name} avoids death.`,
			`Wydano 1 Punkt Przeznaczenia. ${actor.name} unika śmierci.`,
		),
	);

	return foundry.utils.deepFreeze(
		foundry.utils.deepClone(intervention),
	);
}

async function synchronizeFatalStatus(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	const applications = readDamageApplicationMap(actor);
	const hasUnavertedFatality = Object.values(applications).some(
		(transaction) =>
			transaction?.state === "applied" &&
			transaction?.criticalResolution?.outcome ===
				SUDDEN_DEATH_OUTCOME.KILLED &&
			!fateInterventionFor(actor, transaction.packetId),
	);

	if (!hasUnavertedFatality) return;
	await setDefeatedStatus(actor, true);
}

async function setDefeatedStatus(actor, active) {
	const statusId = defeatedStatusId();
	if (!statusId) {
		throw new Error(
			"Foundry has no configured defeated/dead status effect for this system.",
		);
	}

	return actor.toggleStatusEffect(statusId, {
		active: Boolean(active),
		overlay: true,
	});
}

function defeatedStatusId() {
	const configured = CONFIG.statusEffects ?? {};
	const special = CONFIG.specialStatusEffects ?? {};
	const direct = special.DEFEATED ?? special.defeated;

	if (typeof direct === "string" && configured[direct]) {
		return direct;
	}

	for (const [key, id] of Object.entries(special)) {
		if (
			String(key).toLowerCase().includes("defeat") &&
			typeof id === "string" &&
			configured[id]
		) {
			return id;
		}
	}

	for (const fallback of ["dead", "defeated"]) {
		if (configured[fallback]) return fallback;
	}

	return null;
}

function applyFatalCriticalClientState(message, html) {
	const resultState = criticalResultState(message);
	if (
		resultState?.resolution?.outcome !== SUDDEN_DEATH_OUTCOME.KILLED
	) {
		return;
	}

	const root = asElement(html);
	if (!root) return;

	const card = root.matches?.("[data-wfrp-critical-card]")
		? root
		: root.querySelector?.("[data-wfrp-critical-card]");
	if (!card) return;

	card.querySelector?.("[data-wfrp-fate-intervention]")?.remove();
	card.classList.remove("is-fate-saved");

	const actor = actorForCriticalResult(resultState);
	if (!(actor instanceof foundry.documents.Actor)) return;

	const packetId = String(resultState.packetId ?? "").trim();
	const transaction = DamageApplication.transactionFor(actor, packetId);
	if (
		transaction?.criticalResolution?.outcome !==
		SUDDEN_DEATH_OUTCOME.KILLED
	) {
		return;
	}

	const intervention = fateInterventionFor(actor, packetId);
	if (intervention) {
		card.classList.add("is-fate-saved");
		card.append(buildFateSpentPanel(intervention));
		return;
	}

	// Liczby Punktów Przeznaczenia nie pokazujemy osobom, które nie zarządzają
	// ofiarą. Gracz widzi decyzję na swojej postaci, a MG także na BN-ach.
	if (!canManageFatalActor(actor, game.user)) return;

	const fate = readFateResource(actor);
	if (fate.value <= 0) return;

	card.append(buildSpendFatePanel(message, fate.value));
}

function buildSpendFatePanel(message, fateValue) {
	const panel = document.createElement("section");
	panel.className = "wfrp1e-fate-intervention";
	panel.dataset.wfrpFateIntervention = "";

	const resource = document.createElement("div");
	resource.className = "wfrp1e-fate-intervention__resource";
	resource.textContent = `${localize(
		"WFRP1ED.Critical.FatePoints",
		"Fate Points",
		"Punkty Przeznaczenia",
	)}: ${fateValue}`;
	panel.append(resource);

	const action = document.createElement("button");
	action.type = "button";
	action.className = "wfrp1e-fate-intervention__action";
	action.dataset.wfrpSpendFate = "";
	action.innerHTML = `<i class="fa-solid fa-star"></i> ${localize(
		"WFRP1ED.Critical.SpendFate",
		"Spend Fate Point",
		"Wydaj Punkt Przeznaczenia",
	)}`;
	action.addEventListener("click", () => {
		action.disabled = true;
		void spendFatePointForFatalCritical(message).catch((error) => {
			action.disabled = false;
			reportFateError(error);
		});
	});
	panel.append(action);

	return panel;
}

function buildFateSpentPanel(intervention) {
	const panel = document.createElement("section");
	panel.className = "wfrp1e-fate-intervention is-spent";
	panel.dataset.wfrpFateIntervention = "";

	const text = document.createElement("div");
	text.className = "wfrp1e-fate-intervention__spent";
	text.textContent = localize(
		"WFRP1ED.Critical.FateAvertedDeath",
		"✓ Fate Point spent — death averted",
		"✓ Wydano Punkt Przeznaczenia — uniknięto śmierci",
	);
	panel.append(text);

	const remaining = Number(intervention?.fateAfter);
	if (Number.isInteger(remaining) && remaining >= 0 && canSeeFateRemainder(intervention)) {
		const resource = document.createElement("div");
		resource.className = "wfrp1e-fate-intervention__resource";
		resource.textContent = `${localize(
			"WFRP1ED.Critical.FateRemaining",
			"Fate Points remaining",
			"Pozostałe Punkty Przeznaczenia",
		)}: ${remaining}`;
		panel.append(resource);
	}

	return panel;
}

function canSeeFateRemainder(intervention) {
	if (game.user?.isGM) return true;

	try {
		const actor = foundry.utils.fromUuidSync(
			String(intervention?.targetActorUuid ?? ""),
		);
		return actor instanceof foundry.documents.Actor &&
			canManageFatalActor(actor, game.user);
	} catch (_error) {
		return false;
	}
}

function criticalResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function damageState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function actorForCriticalResult(resultState) {
	if (!resultState) return null;

	const sourceMessage = game.messages?.get(
		String(resultState.sourceMessageId ?? ""),
	);
	const state = damageState(sourceMessage);
	const uuid = String(state?.packet?.targetActorUuid ?? "").trim();
	if (!uuid) return null;

	try {
		const actor = foundry.utils.fromUuidSync(uuid);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function canManageFatalActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;

	return actor.testUserPermission(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	);
}

function readFateResource(actor) {
	const raw = actor?.system?.status?.fate;

	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const value = normalizeNonNegativeInteger(raw.value);
		return {
			value,
			path: "system.status.fate.value",
		};
	}

	if (raw !== undefined && raw !== null) {
		return {
			value: normalizeNonNegativeInteger(raw),
			path: "system.status.fate",
		};
	}

	return { value: 0, path: null };
}

function normalizeNonNegativeInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function readFateInterventionMap(actor) {
	const existing = actor?.getFlag?.(
		FLAG_SCOPE,
		FATE_INTERVENTIONS_FLAG_KEY,
	);

	return existing && typeof existing === "object" && !Array.isArray(existing)
		? foundry.utils.deepClone(existing)
		: {};
}

function fateInterventionFor(actor, packetId) {
	const id = String(packetId ?? "").trim();
	if (!id) return null;

	const map = actor?.getFlag?.(FLAG_SCOPE, FATE_INTERVENTIONS_FLAG_KEY);
	const intervention = map && typeof map === "object" && !Array.isArray(map)
		? map[id]
		: null;

	return intervention && typeof intervention === "object"
		? foundry.utils.deepClone(intervention)
		: null;
}

function readDamageApplicationMap(actor) {
	const applications = actor?.getFlag?.(FLAG_SCOPE, "damageApplications");
	return applications && typeof applications === "object" && !Array.isArray(applications)
		? applications
		: {};
}

function damageApplicationsChanged(changes) {
	return (
		foundry.utils.getProperty?.(
			changes,
			"flags.wfrp1ed.damageApplications",
		) !== undefined ||
		changes?.["flags.wfrp1ed.damageApplications"] !== undefined
	);
}

function refreshActorFatalCriticalCards(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const resultState = criticalResultState(message);
		if (!resultState) continue;

		const target = actorForCriticalResult(resultState);
		if (target?.uuid !== actor.uuid) continue;

		refreshVisibleFatalCriticalMessage(message);
	}
}

function refreshVisibleFatalCriticalMessage(message) {
	if (!message?.id) return;

	const entry = document.querySelector(
		`[data-message-id="${message.id}"]`,
	);
	if (entry) applyFatalCriticalClientState(message, entry);
}

function isFatalStatusWriter(actor, updateUserId) {
	const gm = primaryActiveGm();
	if (gm) {
		return Boolean(
			game.user?.isGM &&
			String(game.user.id) === String(gm.id),
		);
	}

	return Boolean(
		String(updateUserId ?? "") === String(game.user?.id ?? "") &&
		canManageFatalActor(actor, game.user),
	);
}

function primaryActiveGm() {
	const activeGms = (game.users ?? [])
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)));

	return activeGms[0] ?? null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportFateError(error) {
	console.error(
		"WFRP1ED | Unable to spend Fate Point for fatal critical.",
		error,
	);
	ui.notifications.error(
		error?.message ?? localize(
			"WFRP1ED.Critical.SpendFateFailed",
			"Unable to spend a Fate Point.",
			"Nie można wydać Punktu Przeznaczenia.",
		),
	);
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}
