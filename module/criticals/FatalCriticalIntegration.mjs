import { DamageApplication } from "../damage/DamageApplication.mjs";
import { SUDDEN_DEATH_OUTCOME } from "./CoreSuddenDeathTables.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTION_VERSION = 1;
const FATAL_APPLICATION_VERSION = 1;

/**
 * Apply fatal critical consequences explicitly and expose the WFRP 1e Fate
 * Point escape to the GM or owner of the dying Actor.
 *
 * Resolving a table roll and applying its fatal consequence are deliberately
 * separate. The immutable critical result may say "killed", but the Actor is
 * not marked defeated until an authorized user presses Apply Fatal Critical.
 * Spending Fate is then stored as a second Actor-side intervention, preserving
 * the full result -> application -> Fate history.
 */
export function registerFatalCriticalIntegration() {
	Hooks.on("updateActor", (actor, changes, _options, userId) => {
		refreshActorFatalCriticalCards(actor);

		if (
			!damageApplicationsChanged(changes) &&
			!fatalApplicationsChanged(changes) &&
			!fateInterventionsChanged(changes)
		) {
			return;
		}

		// Status Śmierci zapisuje tylko jeden klient autorytatywny. Gdy MG jest
		// aktywny robi to pierwszy aktywny MG; bez MG może to zrobić właściciel
		// Actor-a, który właśnie zapisał wynik/aplikację krytyczną.
		if (!isFatalStatusWriter(actor, userId)) {
			return;
		}

		void synchronizeFatalStatus(actor).catch((error) => {
			console.error(
				"WFRP1ED | Unable to synchronize defeated status after fatal critical.",
				error,
			);
			ui.notifications.warn(
				localize(
					"WFRP1ED.Critical.DeadStatusFailed",
					"The fatal critical state changed, but the defeated status could not be synchronized.",
					"Stan śmiertelnego trafienia krytycznego uległ zmianie, ale nie udało się zsynchronizować statusu pokonanego.",
				),
			);
		});
	});

	Hooks.on("renderChatMessageHTML", (message, html) => {
		applyFatalCriticalClientState(message, html);
	});
}

/**
 * Explicitly apply one already-resolved fatal critical result to its Actor.
 *
 * @param {ChatMessage} message Separate critical-result ChatMessage.
 * @param {User} user
 * @returns {Promise<Object>}
 */
export async function applyFatalCriticalResult(
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
			"Only a GM or an owner of the dying Actor may apply this fatal critical result.",
		);
	}

	const packetId = String(resultState?.packetId ?? "").trim();
	const transaction = DamageApplication.transactionFor(actor, packetId);
	if (
		transaction?.state !== "applied" ||
		transaction?.criticalResolution?.outcome !== SUDDEN_DEATH_OUTCOME.KILLED
	) {
		throw new Error(
			"A fatal critical can only be applied from an active fatal damage transaction.",
		);
	}

	const existing = fatalApplicationFor(actor, packetId);
	if (existing?.state === "applied") {
		await synchronizeFatalStatus(actor);
		return existing;
	}

	const applications = readFatalApplicationMap(actor);
	const application = {
		version: FATAL_APPLICATION_VERSION,
		packetId,
		targetActorUuid: actor.uuid,
		resultMessageId: String(message?.id ?? ""),
		defeatedBefore: hasDefeatedStatus(actor),
		userId: String(user?.id ?? ""),
		appliedAt: Date.now(),
		state: "applied",
	};
	applications[packetId] = foundry.utils.deepClone(application);

	await actor.setFlag(
		FLAG_SCOPE,
		FATAL_APPLICATIONS_FLAG_KEY,
		applications,
	);
	await synchronizeFatalStatus(actor);
	refreshActorFatalCriticalCards(actor);

	ui.notifications.info(
		localize(
			"WFRP1ED.Critical.FatalAppliedNotice",
			`Fatal critical applied to ${actor.name}.`,
			`Zastosowano śmiertelne trafienie krytyczne: ${actor.name}.`,
		),
	);

	return foundry.utils.deepFreeze(
		foundry.utils.deepClone(application),
	);
}

/**
 * Permanently spend one Fate Point to avert one explicitly-applied fatal result.
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
		transaction?.state !== "applied" ||
		transaction?.criticalResolution?.outcome !==
		SUDDEN_DEATH_OUTCOME.KILLED
	) {
		throw new Error(
			"A Fate Point can only be spent here for an active fatal critical result.",
		);
	}
	if (fatalApplicationFor(actor, packetId)?.state !== "applied") {
		throw new Error(
			"Apply the fatal critical result before spending Fate to avert it.",
		);
	}

	const existingIntervention = fateInterventionFor(actor, packetId);
	if (existingIntervention) {
		await synchronizeFatalStatus(actor);
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

	await synchronizeFatalStatus(actor);
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

	const damageApplications = readDamageApplicationMap(actor);
	const fatalApplications = readFatalApplicationMap(actor);
	const fatalEntries = Object.values(fatalApplications).filter(
		(application) => application?.state === "applied",
	);
	if (fatalEntries.length === 0) return;

	const hasUnavertedFatality = fatalEntries.some((application) => {
		const packetId = String(application.packetId ?? "");
		const transaction = damageApplications[packetId];
		return Boolean(
			transaction?.state === "applied" &&
			transaction?.criticalResolution?.outcome ===
				SUDDEN_DEATH_OUTCOME.KILLED &&
			!fateInterventionFor(actor, packetId)
		);
	});

	if (hasUnavertedFatality) {
		await setDefeatedStatus(actor, true);
		return;
	}

	/*
	 * Restore the pre-fatal defeated state rather than blindly clearing a status
	 * which may have existed before WFRP applied this fatal transaction.
	 */
	const defeatedBefore = fatalEntries.some(
		(application) => application.defeatedBefore === true,
	);
	await setDefeatedStatus(actor, defeatedBefore);
}

async function setDefeatedStatus(actor, active) {
	const statusId = defeatedStatusId();
	if (!statusId) {
		throw new Error(
			"Foundry has no configured defeated/dead status effect for this system.",
		);
	}

	if (hasDefeatedStatus(actor) === Boolean(active)) return actor;
	return actor.toggleStatusEffect(statusId, {
		active: Boolean(active),
		overlay: true,
	});
}

function hasDefeatedStatus(actor) {
	const statusId = defeatedStatusId();
	return Boolean(statusId && actor?.statuses?.has?.(statusId));
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

	const selector = "[data-wfrp-critical-card], [data-wfrp-detailed-critical-card]";
	const card = root.matches?.(selector)
		? root
		: root.querySelector?.(selector);
	if (!card) return;

	card.querySelector?.("[data-wfrp-fate-intervention]")?.remove();
	card.querySelector?.("[data-wfrp-fatal-application]")?.remove();
	card.classList.remove("is-fate-saved");

	const actor = actorForCriticalResult(resultState);
	if (!(actor instanceof foundry.documents.Actor)) return;

	const packetId = String(resultState.packetId ?? "").trim();
	const transaction = DamageApplication.transactionFor(actor, packetId);
	if (
		transaction?.state !== "applied" ||
		transaction?.criticalResolution?.outcome !==
		SUDDEN_DEATH_OUTCOME.KILLED
	) {
		return;
	}

	const fatalApplication = fatalApplicationFor(actor, packetId);
	if (fatalApplication?.state !== "applied") {
		card.append(buildApplyFatalPanel(message, actor));
		return;
	}

	const intervention = fateInterventionFor(actor, packetId);
	if (intervention) {
		card.classList.add("is-fate-saved");
		card.append(buildFateSpentPanel(intervention));
		return;
	}

	const applied = document.createElement("section");
	applied.className = "wfrp1e-fate-intervention";
	applied.dataset.wfrpFatalApplication = "";
	const appliedText = document.createElement("div");
	appliedText.className = "wfrp1e-fate-intervention__spent";
	appliedText.textContent = localize(
		"WFRP1ED.Critical.FatalApplied",
		"✓ Fatal critical applied — character is defeated",
		"✓ Zastosowano śmiertelne trafienie krytyczne — postać jest pokonana",
	);
	applied.append(appliedText);
	card.append(applied);

	// Liczby Punktów Przeznaczenia nie pokazujemy osobom, które nie zarządzają
	// ofiarą. Gracz widzi decyzję na swojej postaci, a MG także na BN-ach.
	if (!canManageFatalActor(actor, game.user)) return;

	const fate = readFateResource(actor);
	if (fate.value <= 0) return;

	card.append(buildSpendFatePanel(message, fate.value));
}

function buildApplyFatalPanel(message, actor) {
	const panel = document.createElement("section");
	panel.className = "wfrp1e-fate-intervention";
	panel.dataset.wfrpFatalApplication = "";

	if (!canManageFatalActor(actor, game.user)) {
		const pending = document.createElement("div");
		pending.className = "wfrp1e-critical-result__pending";
		pending.textContent = localize(
			"WFRP1ED.Critical.FatalAwaitingApply",
			"Awaiting the GM or target owner to apply this fatal result.",
			"Oczekuje na MG lub właściciela celu, który zastosuje ten śmiertelny wynik.",
		);
		panel.append(pending);
		return panel;
	}

	const action = document.createElement("button");
	action.type = "button";
	action.className = "wfrp1e-fate-intervention__action";
	action.dataset.wfrpApplyFatal = "";
	action.innerHTML = `<i class="fa-solid fa-skull"></i> ${localize(
		"WFRP1ED.Critical.ApplyFatal",
		"Apply Fatal Critical",
		"Zastosuj śmiertelne trafienie krytyczne",
	)}`;
	action.addEventListener("click", () => {
		action.disabled = true;
		void applyFatalCriticalResult(message).catch((error) => {
			action.disabled = false;
			reportFatalApplyError(error);
		});
	});
	panel.append(action);
	return panel;
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
	actio