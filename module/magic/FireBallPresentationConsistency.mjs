import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const VIEW_FLAG_KEY = "fireBallDamageResultView";
const ACTOR_TEST_FLAG_KEY = "actorTestRequest";
const TEST_FLAG_KEY = "testResultState";
const INLINE_TEST_FLAG_KEY = "fireBallInlineTest";

let installed = false;
let refreshQueued = false;
const fearSyncing = new Set();

/**
 * Presentation-only reconciliation for Fire Ball's linked TestResult cards.
 *
 * Initiative and Psychology remain canonical Test messages so all normal Test
 * controls (including Luck) are available. The Fire Ball transaction card only
 * mirrors the final success/failure state and never duplicates the d100 value.
 *
 * The same pass also keeps editable Fire Ball damage inputs and their native die
 * badges synchronized with the authoritative impact flag after a rerender.
 */
export function installFireBallPresentationConsistency() {
	if (installed) return;
	installed = true;

	Hooks.on("renderChatMessageHTML", (message, html) => {
		/* FireBallDamageResultView also decorates in requestAnimationFrame. Run one
		 * frame later so this module intentionally owns the final compact layout. */
		requestAnimationFrame(() => requestAnimationFrame(() => {
			revealRelatedTestResult(message, html);
			summarizeImpactRelatedTests(message, html);
			synchronizeDamageDieEditors(message, html);
		}));
	});

	/* A generic chat rerender proved too weak for Fear because the request result
	 * id and the Fire Ball source card are separate Documents. On the primary GM,
	 * persist the resolved Fear link/outcome onto every matching impact message.
	 * Updating the impact Document itself gives Foundry a concrete source-card
	 * update, so Fear can finish while Initiative is still pending. */
	Hooks.on("updateChatMessage", (message, changes) => {
		const requestChanged = fireBallRequestChanged(message, changes);
		const linkedChanged = fireBallLinkedTestChanged(message, changes);
		if (requestChanged) {
			void synchronizeFearRequestToImpacts(message).catch(reportFearSyncError);
		}
		if (linkedChanged && isFireBallFearResult(message)) {
			void synchronizeFearResultToImpacts(message).catch(reportFearSyncError);
		}
		if (requestChanged || linkedChanged) requestChatRefresh();
	});
	Hooks.on("createChatMessage", (message) => {
		if (isFireBallFearResult(message) ||
			message?.getFlag?.(FLAG_SCOPE, INLINE_TEST_FLAG_KEY)?.role === "initiative") {
			requestChatRefresh();
		}
	});
}

function revealRelatedTestResult(message, html) {
	const inline = message?.getFlag?.(FLAG_SCOPE, INLINE_TEST_FLAG_KEY);
	const isInitiative = inline?.role === "initiative";
	const isFear = isFireBallFearResult(message);
	if (!isInitiative && !isFear) return;

	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const entry = root.closest?.(".chat-message, li.message, li.chat-message") ??
		root.parentElement?.closest?.(".chat-message, li.message, li.chat-message") ??
		root;
	if (!(entry instanceof HTMLElement)) return;
	entry.hidden = false;
	entry.style.removeProperty("display");
	entry.removeAttribute("aria-hidden");
	root.hidden = false;
}

function summarizeImpactRelatedTests(message, html) {
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-impact-workflow]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	if (!(panel instanceof HTMLElement)) return;

	if (impact.initiative) {
		const row = panel.querySelector(":scope > .wfrp-fireball-initiative-row");
		if (row instanceof HTMLElement) {
			replaceWithOutcomeSummary(
				row,
				localize("Damage Reduction - Initiative", "Redukcja obrażeń — Inicjatywa"),
				currentInitiativeSuccess(impact),
			);
		}
	}

	const fearRow = panel.querySelector(":scope > [data-fire-ball-fear-test-row]");
	const fear = currentFearOutcome(impact);
	if (fearRow instanceof HTMLElement && fear.resolved) {
		replaceWithOutcomeSummary(
			fearRow,
			localize("Fear Test", "Test Strachu"),
			fear.success,
		);
	}
}

function currentInitiativeSuccess(impact) {
	const id = String(impact?.initiative?.testMessageId ?? "").trim();
	const testMessage = id ? game.messages?.get(id) ?? null : null;
	const state = testMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (state) return TestResultChat._templateContext(state).result?.success === true;
	return impact?.initiative?.success === true;
}

function currentFearOutcome(impact) {
	const fearMessage = fearResultMessage(impact);
	const state = fearMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (state) {
		return {
			resolved: true,
			success: TestResultChat._templateContext(state).result?.success === true,
		};
	}
	if (typeof impact?.fearSuccess === "boolean") {
		return { resolved: true, success: impact.fearSuccess === true };
	}
	return { resolved: false, success: false };
}

function replaceWithOutcomeSummary(row, labelText, success) {
	row.classList.add("wfrp-fireball-outcome-summary");
	Object.assign(row.style, {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content",
		alignItems: "center",
		columnGap: "0.75rem",
	});

	const label = document.createElement("span");
	label.textContent = labelText;
	label.style.minWidth = "0";

	const outcome = document.createElement("strong");
	outcome.className = "wfrp-fireball-outcome-summary__result";
	outcome.textContent = success
		? localize("Success", "Sukces")
		: localize("Failure", "Porażka");
	Object.assign(outcome.style, {
		minWidth: game.i18n.lang === "pl" ? "4.8rem" : "4.2rem",
		textAlign: "right",
		whiteSpace: "nowrap",
		justifySelf: "end",
	});

	row.replaceChildren(label, outcome);
}

function synchronizeDamageDieEditors(message, html) {
	const view = message?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
	if (!view?.sourceImpactMessageId) return;
	const source = game.messages?.get(String(view.sourceImpactMessageId));
	const impact = source?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact?.damage) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement)) return;

	synchronizeDamageDie(card, "d10", 10, impact.damage.damageRoll);
	if (impact.flammable === true) {
		synchronizeDamageDie(card, "d8", 8, impact.damage.flammableRoll);
	}
}

function synchronizeDamageDie(card, kind, faces, value) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > faces) return;
	const input = card.querySelector(`[data-fire-ball-damage-die="${kind}"]`);
	if (!(input instanceof HTMLInputElement)) return;

	/* A rerender must keep the adjudicated value visible in the editor as well as
	 * in the badge. Do not overwrite text while the user is actively typing. */
	if (document.activeElement !== input) input.value = String(number);
	input.dataset.lastValidValue = String(number);

	const roll = input.closest?.(".wfrp1e-damage-roll");
	const die = roll?.querySelector?.(`.roll.die.d${faces}`);
	if (die instanceof HTMLElement) {
		die.textContent = String(number);
		die.title = `d${faces}: ${number}`;
		die.setAttribute("aria-label", `d${faces}: ${number}`);
	}
	const operator = roll?.querySelector?.(".wfrp1e-damage-roll__operator");
	if (operator) operator.textContent = "=";
}

async function synchronizeFearRequestToImpacts(requestMessage) {
	if (!ActorRollPolicy.isPrimaryActiveGM()) return;
	const request = requestMessage?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	if (request?.source?.kind !== "spell-fire-ball" || request?.status !== "resolved") return;
	const resultId = String(request?.resultMessageId ?? "").trim();
	if (!resultId) return;
	const resultMessage = game.messages?.get(resultId) ?? null;
	const testState = resultMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	const success = testState
		? TestResultChat._templateContext(testState).result?.success === true
		: null;

	for (const sourceMessage of matchingFearImpacts(requestMessage, request)) {
		await persistFearSnapshot(sourceMessage, requestMessage.id, resultId, success, request.resolvedAt);
	}
}

async function synchronizeFearResultToImpacts(resultMessage) {
	if (!ActorRollPolicy.isPrimaryActiveGM()) return;
	const testState = resultMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!testState) return;
	const success = TestResultChat._templateContext(testState).result?.success === true;
	const resultId = String(resultMessage.id ?? "");
	if (!resultId) return;

	for (const sourceMessage of game.messages ?? []) {
		const impact = sourceMessage.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
		if (!impact?.fearOfFire) continue;
		if (String(fearResultMessage(impact)?.id ?? impact?.fearResultMessageId ?? "") !== resultId) continue;
		const request = fearRequestMessage(impact);
		await persistFearSnapshot(
			sourceMessage,
			String(request?.id ?? impact?.fearRequestMessageId ?? ""),
			resultId,
			success,
			request?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY)?.resolvedAt,
		);
	}
}

async function persistFearSnapshot(sourceMessage, requestId, resultId, success, resolvedAt) {
	const key = String(sourceMessage?.id ?? "");
	if (!key || fearSyncing.has(key)) return;
	const impact = sourceMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) return;
	if (
		String(impact.fearRequestMessageId ?? "") === String(requestId ?? "") &&
		String(impact.fearResultMessageId ?? "") === String(resultId ?? "") &&
		(typeof success !== "boolean" || impact.fearSuccess === success)
	) return;

	fearSyncing.add(key);
	try {
		const updated = foundry.utils.deepClone(impact);
		if (requestId) updated.fearRequestMessageId = String(requestId);
		updated.fearResultMessageId = String(resultId);
		if (typeof success === "boolean") updated.fearSuccess = success;
		updated.fearResolvedAt = Number(resolvedAt) || Date.now();
		updated.updatedAt = Date.now();
		await sourceMessage.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, updated);
	} finally {
		fearSyncing.delete(key);
	}
}

function matchingFearImpacts(requestMessage, request) {
	const requestId = String(requestMessage?.id ?? "");
	const spellUuid = String(request?.source?.spellUuid ?? "");
	const castId = String(request?.source?.castId ?? "");
	const actorUuid = String(request?.actorUuid ?? request?.source?.targetUuid ?? "");
	return [...(game.messages ?? [])].filter((message) => {
		const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
		if (!impact?.fearOfFire) return false;
		if (String(impact.fearRequestMessageId ?? "") === requestId) return true;
		if (actorUuid && String(impact.targetUuid ?? "") !== actorUuid) return false;
		if (castId && String(impact.castId ?? "") === castId) return true;
		return Boolean(spellUuid && String(impact.spellUuid ?? "") === spellUuid);
	});
}

function fireBallRequestChanged(message, changes) {
	const request = message?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	if (request?.source?.kind !== "spell-fire-ball") return false;
	return flagChanged(changes, ACTOR_TEST_FLAG_KEY);
}

function fireBallLinkedTestChanged(message, changes) {
	if (!flagChanged(changes, TEST_FLAG_KEY)) return false;
	const inline = message?.getFlag?.(FLAG_SCOPE, INLINE_TEST_FLAG_KEY);
	return inline?.role === "initiative" || isFireBallFearResult(message);
}

function flagChanged(changes, key) {
	if (!changes || typeof changes !== "object") return false;
	if (Object.hasOwn(changes, `flags.${FLAG_SCOPE}.${key}`)) return true;
	const scoped = changes?.flags?.[FLAG_SCOPE];
	return Boolean(scoped && typeof scoped === "object" && Object.hasOwn(scoped, key));
}

function requestChatRefresh() {
	if (refreshQueued) return;
	refreshQueued = true;
	requestAnimationFrame(() => {
		refreshQueued = false;
		void ui.chat?.render?.({ force: true });
	});
}

function isFireBallFearResult(message) {
	const id = String(message?.id ?? "").trim();
	if (!id) return false;
	for (const source of game.messages ?? []) {
		const impact = source.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
		if (!impact) continue;
		if (String(fearResultMessage(impact)?.id ?? impact?.fearResultMessageId ?? "") === id) return true;
	}
	return false;
}

function fearResultMessage(impact) {
	const directId = String(impact?.fearResultMessageId ?? "").trim();
	if (directId) return game.messages?.get(directId) ?? null;
	const request = fearRequestMessage(impact);
	const state = request?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	const id = String(state?.resultMessageId ?? "").trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function fearRequestMessage(impact) {
	const id = String(impact?.fearRequestMessageId ?? "").trim();
	if (id) return game.messages?.get(id) ?? null;
	for (const message of game.messages ?? []) {
		const request = message.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
		if (
			request?.source?.kind === "spell-fire-ball" &&
			String(request.source?.castId ?? "") === String(impact?.castId ?? "") &&
			String(request.actorUuid ?? "") === String(impact?.targetUuid ?? "")
		) return message;
	}
	return null;
}

function reportFearSyncError(error) {
	console.error("WFRP1ED | Unable to synchronize Fire Ball Fear result.", error);
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
