import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const TEST_STATE_FLAG_KEY = "testResultState";
const DROWNING_STATE_FLAG_KEY = "drowningState";
const DROWNING_DAMAGE_FLAG_KEY = "drowningDamageState";
const DAMAGE_STATE_FLAG_KEY = "damageState";

const RISK_TEST_ID = "risk";
const DROWNING_STATE_VERSION = 1;
const DROWNING_DAMAGE_VERSION = 1;

const PHASE = Object.freeze({
	PENDING: "pending",
	COUNTDOWN: "countdown",
	DROWNING: "drowning",
	ENDED: "ended",
	CANCELLED: "cancelled",
});

const ACTION = Object.freeze({
	START: "start",
	ADVANCE: "advance",
	REWIND: "rewind",
	END: "end",
});

const syncQueues = new Map();

/*
 * WFRP 1e Core, Polish edition, Pływanie (printed p.74):
 * - a swimmer who fails the required Risk Test starts drowning after a number
 *   of rounds equal to Toughness;
 * - after that, the swimmer loses 1 Wound per round;
 * - when Wounds reach 0, the character dies.
 *
 * This integration intentionally does NOT advance from Foundry Combat rounds.
 * The table explicitly starts and advances the tracker from the Swimming card.
 * That preserves the Core procedure while avoiding computer-game automation.
 *
 * Each drowning Wound is a separate ordinary DamageChat transaction. It ignores
 * Armour and Toughness, has no Critical-table routing, and remains explicitly
 * Apply/Invalidate damage. The Swimming tracker therefore never mutates Wounds
 * directly and never overwrites another damage transaction.
 */

Hooks.on("createChatMessage", (message) => {
	queueRelevantSynchronization(message);
});

Hooks.on("updateChatMessage", (message) => {
	queueRelevantSynchronization(message);
});

Hooks.on("preUpdateChatMessage", (message, changes) => {
	return guardAcceptedDrowningRiskOutcome(message, changes);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	decorateSwimmingDrowning(message, html);
	decorateDrowningDamage(message, html);
});

Hooks.on("updateActor", (actor) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!hasDrowningTrackerForActor(actor)) return;
	setTimeout(() => {
		void ui.chat?.render?.({ force: true });
	}, 0);
});

Hooks.once("ready", () => {
	if (!isLifecycleAuthority()) return;
	for (const message of game.messages ?? []) {
		if (swimmingState(message)?.hazardous === true) {
			queueSwimmingSynchronization(message);
		}
	}
});

function queueRelevantSynchronization(message) {
	if (!isLifecycleAuthority() || !message?.id) return;

	if (swimmingState(message)?.hazardous === true) {
		queueSwimmingSynchronization(message);
		return;
	}

	if (!riskTestState(message)) return;
	for (const swimmingMessage of linkedSwimmingMessages(message.id)) {
		queueSwimmingSynchronization(swimmingMessage);
	}
}

function queueSwimmingSynchronization(message) {
	if (!message?.id) return;
	const id = String(message.id);
	const previous = syncQueues.get(id) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => synchronizeSwimmingMessage(message))
		.catch((error) => {
			console.error("WFRP1ED | Drowning synchronization failed.", error);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to synchronize the drowning state.",
					"Nie udało się zsynchronizować stanu tonięcia.",
				),
			);
		})
		.finally(() => {
			if (syncQueues.get(id) === next) syncQueues.delete(id);
		});

	syncQueues.set(id, next);
}

async function synchronizeSwimmingMessage(message) {
	const movement = swimmingState(message);
	if (!movement || movement.hazardous !== true) return;

	const riskMessageId = String(movement.riskMessageId ?? "").trim();
	if (!riskMessageId) return;

	const riskMessage = game.messages?.get?.(riskMessageId);
	const testState = riskTestState(riskMessage);
	if (!testState) return;

	const failure = !testSucceeded(testState);
	const current = drowningState(message);

	if (failure) {
		if (current && current.phase !== PHASE.CANCELLED) return;

		const state = createPendingDrowningState(message, movement, riskMessage);
		await message.setFlag(
			FLAG_SCOPE,
			DROWNING_STATE_FLAG_KEY,
			state,
		);
		return;
	}

	if (!current) return;

	if (drowningStateLocksRisk(current)) {
		/* preUpdateChatMessage should prevent this path; never auto-rewind here. */
		return;
	}

	if (hasAppliedDrowningDamage(current)) {
		/* Same safety boundary: applied Wounds must be explicitly invalidated. */
		return;
	}

	await cancelPendingDrowningDamage(current);

	if (
		current.phase === PHASE.PENDING &&
		(current.damageRounds?.length ?? 0) === 0 &&
		!current.startedAt
	) {
		await message.unsetFlag(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY);
		return;
	}

	const cancelled = foundry.utils.deepClone(current);
	cancelled.phase = PHASE.CANCELLED;
	cancelled.cancelledAt = Date.now();
	cancelled.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY, cancelled);
}

function createPendingDrowningState(message, movement, riskMessage) {
	const toughness = nonNegativeInteger(movement.toughness ?? 0);
	return {
		version: DROWNING_STATE_VERSION,
		actorUuid: String(movement.actorUuid ?? ""),
		swimmingMessageId: String(message.id ?? ""),
		riskMessageId: String(riskMessage?.id ?? movement.riskMessageId ?? ""),
		phase: PHASE.PENDING,
		graceRounds: toughness,
		roundsElapsed: 0,
		damageRounds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		startedAt: null,
		endedAt: null,
		cancelledAt: null,
	};
}

function decorateSwimmingDrowning(message, html) {
	const movement = swimmingState(message);
	const state = drowningState(message);
	if (!movement || movement.hazardous !== true || !state) return;

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-drowning-tracker]")?.remove();

	const actor = actorFromUuidSync(state.actorUuid);
	const block = document.createElement("section");
	block.classList.add("wfrp1e-drowning-tracker");
	block.dataset.wfrpDrowningTracker = "";
	block.classList.toggle("is-active", isActiveDrowningPhase(state.phase));
	block.classList.toggle("is-ended", state.phase === PHASE.ENDED);
	block.classList.toggle("is-cancelled", state.phase === PHASE.CANCELLED);
	block.classList.toggle("is-fatal", drowningReachedFatalWounds(state, actor));

	const header = document.createElement("div");
	header.classList.add("wfrp1e-drowning-tracker__header");

	const title = document.createElement("strong");
	title.textContent = localize("Drowning", "Tonięcie");

	const phase = document.createElement("span");
	phase.classList.add("wfrp1e-drowning-tracker__phase");
	phase.textContent = phaseLabel(state, actor);
	header.append(title, phase);

	const progress = document.createElement("div");
	progress.classList.add("wfrp1e-drowning-tracker__progress");
	progress.textContent = progressLabel(state);

	const note = document.createElement("div");
	note.classList.add("wfrp1e-drowning-tracker__note");
	note.textContent = trackerNote(state, actor);

	block.append(header, progress, note);

	const actions = buildTrackerActions(message, state, actor);
	if (actions) block.append(actions);

	const metrics = card.querySelector(".wfrp1e-test-card__metrics");
	if (metrics) metrics.before(block);
	else card.append(block);
}

function buildTrackerActions(message, state, actor) {
	if (!canManageTracker(message, actor)) return null;
	if ([PHASE.ENDED, PHASE.CANCELLED].includes(state.phase)) return null;

	const actions = document.createElement("div");
	actions.classList.add("wfrp1e-drowning-tracker__actions");

	if (state.phase === PHASE.PENDING) {
		actions.append(actionButton(
			ACTION.START,
			localize("Start drowning countdown", "Rozpocznij odliczanie tonięcia"),
			"fa-solid fa-water",
			message,
		));
		return actions;
	}

	if (!isActiveDrowningPhase(state.phase)) return null;

	const fatal = drowningReachedFatalWounds(state, actor);
	if (!fatal) {
		actions.append(actionButton(
			ACTION.ADVANCE,
			localize("Next round", "Następna runda"),
			"fa-solid fa-forward-step",
			message,
		));
	}
	if (state.roundsElapsed > 0) {
		actions.append(actionButton(
			ACTION.REWIND,
			localize("Undo round", "Cofnij rundę"),
			"fa-solid fa-rotate-left",
			message,
		));
	}
	actions.append(actionButton(
		ACTION.END,
		localize("End drowning", "Zakończ tonięcie"),
		"fa-solid fa-life-ring",
		message,
	));
	return actions;
}

function actionButton(action, label, iconClass, message) {
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.wfrpDrowningAction = action;
	button.innerHTML = `<i class="${iconClass}"></i> ${label}`;
	button.addEventListener("click", (event) => {
		event.preventDefault();
		button.disabled = true;
		void handleTrackerAction(message, action)
			.catch((error) => {
				console.error("WFRP1ED | Drowning action failed.", error);
				ui.notifications.error(
					error?.message ?? localize(
						"Unable to update drowning.",
						"Nie udało się zaktualizować tonięcia.",
					),
				);
			})
			.finally(() => {
				button.disabled = false;
			});
	});
	return button;
}

async function handleTrackerAction(message, action) {
	const current = drowningState(message);
	if (!current) {
		throw new Error(localize(
			"This Swimming result no longer has a drowning state.",
			"Ten wynik Pływania nie ma już stanu tonięcia.",
		));
	}

	const actor = await actorForState(current);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(localize(
			"The character for this drowning result is unavailable.",
			"Postać dla tego wyniku tonięcia jest niedostępna.",
		));
	}
	if (!canManageTracker(message, actor)) {
		throw new Error(localize(
			"You cannot manage this drowning result.",
			"Nie możesz zarządzać tym wynikiem tonięcia.",
		));
	}

	switch (action) {
		case ACTION.START:
			return startDrowning(message, current);
		case ACTION.ADVANCE:
			return advanceDrowning(message, current, actor);
		case ACTION.REWIND:
			return rewindDrowning(message, current, actor);
		case ACTION.END:
			return endDrowning(message, current);
		default:
			throw new Error(`Unsupported drowning action '${String(action)}'.`);
	}
}

async function startDrowning(message, state) {
	if (state.phase !== PHASE.PENDING) return message;

	const riskMessage = game.messages?.get?.(String(state.riskMessageId ?? ""));
	const testState = riskTestState(riskMessage);
	if (!testState || testSucceeded(testState)) {
		throw new Error(localize(
			"Drowning can start only while the linked Swimming Risk Test is failed.",
			"Tonięcie można rozpocząć tylko wtedy, gdy powiązany Test Ryzyka Pływania jest nieudany.",
		));
	}

	const updated = foundry.utils.deepClone(state);
	updated.phase = PHASE.COUNTDOWN;
	updated.startedAt = Date.now();
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY, updated);
	return message;
}

async function advanceDrowning(message, state, actor) {
	if (!isActiveDrowningPhase(state.phase)) {
		throw new Error(localize(
			"The drowning countdown is not active.",
			"Odliczanie tonięcia nie jest aktywne.",
		));
	}
	if (drowningReachedFatalWounds(state, actor)) {
		throw new Error(localize(
			"This drowning sequence has already reduced Wounds to 0. Under the Swimming rule the character is dead.",
			"Ta sekwencja tonięcia obniżyła już Żywotność do 0. Zgodnie z zasadą Pływania postać nie żyje.",
		));
	}

	const updated = foundry.utils.deepClone(state);
	const nextRound = nonNegativeInteger(updated.roundsElapsed) + 1;
	updated.roundsElapsed = nextRound;
	updated.phase = nextRound >= updated.graceRounds
		? PHASE.DROWNING
		: PHASE.COUNTDOWN;

	if (nextRound > updated.graceRounds) {
		const child = await publishDrowningDamage(actor, message, nextRound);
		const damage = child.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
		const packetId = String(damage?.packet?.id ?? "").trim();
		if (!packetId) {
			throw new Error("Drowning damage ChatMessage did not persist a DamagePacket id.");
		}
		updated.damageRounds = [
			...(updated.damageRounds ?? []),
			{
				round: nextRound,
				messageId: String(child.id ?? ""),
				packetId,
				createdAt: Date.now(),
			},
		];
	}

	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY, updated);
	return message;
}

async function rewindDrowning(message, state, actor) {
	if (!isActiveDrowningPhase(state.phase) || state.roundsElapsed <= 0) {
		return message;
	}

	const updated = foundry.utils.deepClone(state);
	const round = nonNegativeInteger(updated.roundsElapsed);
	const damageEntry = [...(updated.damageRounds ?? [])]
		.reverse()
		.find((entry) => Number(entry?.round) === round) ?? null;

	if (damageEntry) {
		const transaction = DamageApplication.transactionFor(
			actor,
			damageEntry.packetId,
		);
		if (transaction?.state === "applied") {
			throw new Error(localize(
				"Damage for this drowning round is already applied. First use “Invalidate Damage” on that child damage message, then undo the round.",
				"Obrażenia z tej rundy tonięcia są już zastosowane. Najpierw użyj „Unieważnij obrażenia” na powiązanej wiadomości obrażeń, a potem cofnij rundę.",
			));
		}

		await cancelDrowningDamageMessage(damageEntry, localize(
			"Cancelled because the drowning round was undone.",
			"Anulowano, ponieważ cofnięto rundę tonięcia.",
		));
		updated.damageRounds = (updated.damageRounds ?? []).filter(
			(entry) => String(entry?.packetId ?? "") !== String(damageEntry.packetId),
		);
	}

	updated.roundsElapsed = Math.max(0, round - 1);
	updated.phase = updated.roundsElapsed >= updated.graceRounds
		? PHASE.DROWNING
		: PHASE.COUNTDOWN;
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY, updated);
	return message;
}

async function endDrowning(message, state) {
	if (!isActiveDrowningPhase(state.phase)) return message;
	const updated = foundry.utils.deepClone(state);
	updated.phase = PHASE.ENDED;
	updated.endedAt = Date.now();
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY, updated);
	return message;
}

async function publishDrowningDamage(actor, swimmingMessage, round) {
	const packet = new DamagePacket({
		rawAmount: 1,
		targetActorUuid: actor.uuid,
		source: {
			kind: "movement-drowning",
			id: `drowning-round-${round}`,
			uuid: swimmingMessage.uuid,
			label: localize(
				`Drowning — round ${round}`,
				`Tonięcie — runda ${round}`,
			),
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.UNSPECIFIED,
		createdAt: Date.now(),
	});
	const resolution = DamageResolver.resolve(packet);
	const child = await DamageChat.publish({
		packet,
		resolution,
		speakerActor: actor,
	});
	await child.setFlag(FLAG_SCOPE, DROWNING_DAMAGE_FLAG_KEY, {
		version: DROWNING_DAMAGE_VERSION,
		actorUuid: actor.uuid,
		swimmingMessageId: String(swimmingMessage.id ?? ""),
		round,
		packetId: packet.id,
		cancelled: false,
		cancelReason: "",
		createdAt: Date.now(),
	});
	return child;
}

async function cancelPendingDrowningDamage(state) {
	for (const entry of state.damageRounds ?? []) {
		const actor = actorFromUuidSync(state.actorUuid);
		const transaction = actor
			? DamageApplication.transactionFor(actor, entry.packetId)
			: null;
		if (transaction?.state === "applied") continue;
		await cancelDrowningDamageMessage(
			entry,
			localize(
				"Cancelled because the linked Risk Test is now successful.",
				"Anulowano, ponieważ powiązany Test Ryzyka jest teraz udany.",
			),
		);
	}
}

async function cancelDrowningDamageMessage(entry, reason) {
	const child = game.messages?.get?.(String(entry?.messageId ?? ""));
	if (!(child instanceof foundry.documents.ChatMessage)) return;

	const current = child.getFlag?.(FLAG_SCOPE, DROWNING_DAMAGE_FLAG_KEY) ?? {};
	await child.update({
		[`flags.-=${FLAG_SCOPE}`]: undefined,
	});

	/*
	 * Foundry's whole-scope deletion syntax would also remove unrelated system
	 * flags. Restore the dedicated cancellation metadata and explicitly clear only
	 * damageState below instead of depending on scope deletion.
	 */
	if (child.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY)) {
		await child.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	}
	await child.setFlag(FLAG_SCOPE, DROWNING_DAMAGE_FLAG_KEY, {
		...foundry.utils.deepClone(current),
		version: DROWNING_DAMAGE_VERSION,
		packetId: String(entry?.packetId ?? current.packetId ?? ""),
		cancelled: true,
		cancelReason: String(reason ?? ""),
		cancelledAt: Date.now(),
	});
}

function decorateDrowningDamage(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DROWNING_DAMAGE_FLAG_KEY);
	if (!state || typeof state !== "object" || Array.isArray(state)) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-drowning-damage-note]")?.remove();

	const note = document.createElement("section");
	note.classList.add("wfrp1e-drowning-damage-note");
	note.dataset.wfrpDrowningDamageNote = "";

	if (state.cancelled === true) {
		note.classList.add("is-cancelled");
		note.textContent = String(state.cancelReason || localize(
			"This drowning damage was cancelled.",
			"Te obrażenia od tonięcia zostały anulowane.",
		));
	} else {
		const actor = actorFromUuidSync(state.actorUuid);
		const transaction = actor
			? DamageApplication.transactionFor(actor, state.packetId)
			: null;
		const fatal = transaction?.state === "applied" && transaction.woundsAfter === 0;
		note.classList.toggle("is-fatal", fatal);
		note.textContent = fatal
			? localize(
				"Wounds reached 0: under the Swimming rule the character dies. The system does not automatically mark the Actor defeated.",
				"Żywotność spadła do 0: zgodnie z zasadą Pływania postać umiera. System nie oznacza automatycznie Aktora jako pokonanego.",
			)
			: localize(
				"Drowning loss: 1 Wound. Armour and Toughness do not reduce this loss.",
				"Utrata przez tonięcie: 1 Punkt Żywotności. Zbroja i Wytrzymałość nie zmniejszają tej straty.",
			);
	}

	card.append(note);
}

function guardAcceptedDrowningRiskOutcome(message, changes) {
	const current = riskTestState(message);
	if (!current) return true;

	const candidate = changedTestState(changes);
	if (!candidate || String(candidate.testId ?? "") !== RISK_TEST_ID) return true;
	if (!testSucceeded(candidate)) return true;

	const blocking = linkedSwimmingMessages(message.id).find((swimmingMessage) => {
		const state = drowningState(swimmingMessage);
		return state && drowningLocksRiskOutcome(state);
	});
	if (!blocking) return true;

	ui.notifications.warn(localize(
		"Drowning from this failed Swimming Risk Test has already been accepted or has applied Wound loss. End the active drowning tracker and invalidate any applied drowning damage before changing the Risk result to success.",
		"Tonięcie wynikające z tego nieudanego Testu Ryzyka Pływania zostało już zaakceptowane albo zastosowano już utratę Żywotności. Zakończ aktywne tonięcie i unieważnij zastosowane obrażenia od tonięcia, zanim zmienisz wynik Ryzyka na sukces.",
	));
	setTimeout(() => {
		void ui.chat?.render?.({ force: true });
	}, 0);
	return false;
}

function drowningLocksRiskOutcome(state) {
	if (drowningStateLocksRisk(state)) return true;
	return hasAppliedDrowningDamage(state);
}

function drowningStateLocksRisk(state) {
	return isActiveDrowningPhase(state?.phase);
}

function hasAppliedDrowningDamage(state) {
	const actor = actorFromUuidSync(state?.actorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return (state?.damageRounds ?? []).some((entry) =>
		DamageApplication.transactionFor(actor, entry?.packetId)?.state === "applied",
	);
}

function drowningReachedFatalWounds(state, actor) {
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return (state?.damageRounds ?? []).some((entry) => {
		const transaction = DamageApplication.transactionFor(actor, entry?.packetId);
		return transaction?.state === "applied" && Number(transaction.woundsAfter) === 0;
	});
}

function phaseLabel(state, actor) {
	if (drowningReachedFatalWounds(state, actor)) {
		return localize("DEAD (0 Wounds)", "ŚMIERĆ (0 Żw)");
	}

	switch (state.phase) {
		case PHASE.PENDING:
			return localize("Pending", "Oczekuje");
		case PHASE.COUNTDOWN:
			return localize("Holding breath", "Wstrzymuje oddech");
		case PHASE.DROWNING:
			return localize("Drowning", "Tonie");
		case PHASE.ENDED:
			return localize("Ended", "Zakończono");
		case PHASE.CANCELLED:
			return localize("Cancelled", "Anulowano");
		default:
			return String(state.phase ?? "");
	}
}

function progressLabel(state) {
	if (state.phase === PHASE.PENDING) {
		return localize(
			`Core countdown: ${state.graceRounds} round(s) (Toughness).`,
			`Odliczanie z zasad: ${state.graceRounds} rund (Wytrzymałość).`,
		);
	}

	const elapsed = nonNegativeInteger(state.roundsElapsed);
	const grace = nonNegativeInteger(state.graceRounds);
	if (elapsed <= grace) {
		return localize(
			`Rounds elapsed: ${elapsed} / ${grace}.`,
			`Minęło rund: ${elapsed} / ${grace}.`,
		);
	}

	return localize(
		`Rounds elapsed: ${elapsed}. Drowning Wound rounds: ${elapsed - grace}.`,
		`Minęło rund: ${elapsed}. Rund z utratą Żywotności: ${elapsed - grace}.`,
	);
}

function trackerNote(state, actor) {
	if (drowningReachedFatalWounds(state, actor)) {
		return localize(
			"The Core Swimming rule says the character dies when Wounds reach 0. Defeated/dead status is left to table adjudication.",
			"Zasada Pływania mówi, że postać umiera, gdy Żywotność spadnie do 0. Oznaczenie pokonany/martwy pozostaje decyzją przy stole.",
		);
	}

	switch (state.phase) {
		case PHASE.PENDING:
			return localize(
				"The linked hazardous Swimming Risk Test failed. Start the countdown when the table accepts that result as final.",
				"Powiązany Test Ryzyka niebezpiecznego Pływania nie udał się. Rozpocznij odliczanie, gdy przy stole zaakceptujecie ten wynik jako ostateczny.",
			);
		case PHASE.COUNTDOWN:
			return localize(
				"Advance rounds manually. No Wounds are lost during the Toughness countdown.",
				"Przesuwaj rundy ręcznie. Podczas odliczania Wytrzymałości nie traci się Żywotności.",
			);
		case PHASE.DROWNING:
			return localize(
				"Each further round creates a separate pending 1-Wound damage message. Apply it explicitly from that message.",
				"Każda kolejna runda tworzy osobną oczekującą wiadomość z utratą 1 Punktu Żywotności. Zastosuj ją jawnie z tej wiadomości.",
			);
		case PHASE.ENDED:
			return localize(
				"Drowning was ended manually, for example because the character was rescued or reached safety.",
				"Tonięcie zakończono ręcznie, np. ponieważ postać została uratowana albo dotarła w bezpieczne miejsce.",
			);
		case PHASE.CANCELLED:
			return localize(
				"The drowning lifecycle was cancelled because the linked Risk outcome no longer supports it.",
				"Cykl tonięcia anulowano, ponieważ wynik powiązanego Testu Ryzyka już go nie uzasadnia.",
			);
		default:
			return "";
	}
}

function canManageTracker(message, actor) {
	if (!game.user || !(actor instanceof foundry.documents.Actor)) return false;
	const ownsActor = game.user.isGM || actor.testUserPermission?.(
		game.user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
	if (!ownsActor) return false;
	return game.user.isGM || message?.canUserModify?.(game.user, "update") === true;
}

function swimmingState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		String(state.kind ?? "") === "swimming"
			? state
			: null;
}

function drowningState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DROWNING_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? foundry.utils.deepClone(state)
		: null;
}

function riskTestState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_STATE_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		String(state.testId ?? "") === RISK_TEST_ID
			? state
			: null;
}

function changedTestState(changes) {
	const direct = changes?.flags?.[FLAG_SCOPE]?.[TEST_STATE_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) {
		return direct;
	}
	const flat = changes?.[`flags.${FLAG_SCOPE}.${TEST_STATE_FLAG_KEY}`];
	return flat && typeof flat === "object" && !Array.isArray(flat)
		? flat
		: null;
}

function testSucceeded(state) {
	return TestResultChat._templateContext(state)?.result?.success === true;
}

function linkedSwimmingMessages(riskMessageId) {
	const id = String(riskMessageId ?? "").trim();
	if (!id) return [];
	return [...(game.messages ?? [])].filter((message) => {
		const state = swimmingState(message);
		return state?.hazardous === true && String(state.riskMessageId ?? "") === id;
	});
}

function hasDrowningTrackerForActor(actor) {
	const uuid = String(actor?.uuid ?? "");
	if (!uuid) return false;
	return [...(game.messages ?? [])].some((message) =>
		String(drowningState(message)?.actorUuid ?? "") === uuid,
	);
}

function isActiveDrowningPhase(phase) {
	return phase === PHASE.COUNTDOWN || phase === PHASE.DROWNING;
}

async function actorForState(state) {
	const uuid = String(state?.actorUuid ?? "").trim();
	if (!uuid) return null;
	try {
		const document = await foundry.utils.fromUuid(uuid);
		return document instanceof foundry.documents.Actor ? document : null;
	} catch (_error) {
		return null;
	}
}

function actorFromUuidSync(uuid) {
	const id = String(uuid ?? "").trim();
	if (!id) return null;
	try {
		const document = foundry.utils.fromUuidSync(id);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function isLifecycleAuthority() {
	const primary = primaryActiveGm();
	if (primary) return Boolean(game.user?.isGM && String(primary.id) === String(game.user.id));
	return Boolean(game.user);
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
