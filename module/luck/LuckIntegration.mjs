import { DamageApplication } from "../damage/DamageApplication.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_RESULT_FLAG_KEY = "testResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const LUCK_RESULT_FLAG_KEY = "luckResult";
const LUCK_DAILY_FLAG_KEY = "luckDaily";
const LUCK_RULES_ID = "luck";
const LUCK_VERSION = 1;

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_USE_REQUEST = "luck-v2-use-request";
const SOCKET_USE_RESPONSE = "luck-v2-use-response";
const SOCKET_TIMEOUT_MS = 60000;

const pendingRequests = new Map();
const actorLocks = new Map();

Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	addLuckContextOptions(menuItems);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	applyLuckResultPresentation(message, html);
});

Hooks.once("ready", () => {
	game.socket?.on?.(SOCKET_CHANNEL, onSocketMessage);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		luck: Object.freeze({
			rulesId: LUCK_RULES_ID,
			use: useLuckOnMessage,
			resetDay: resetLuckDay,
			rollAllowance: rollLuckAllowanceNow,
			status: luckStatus,
		}),
	});
});

function addLuckContextOptions(menuItems) {
	if (!Array.isArray(menuItems)) {
		return;
	}

	menuItems.push(
		{
			label: localize("Luck: change roll by -10", "Szczęście: zmień wynik o -10"),
			icon: "fa-solid fa-clover",
			visible: (target) => canAttemptLuck(messageFromContextTarget(target), -10),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, -10);
			},
		},
		{
			label: localize("Luck: change roll by +10", "Szczęście: zmień wynik o +10"),
			icon: "fa-solid fa-clover",
			visible: (target) => canAttemptLuck(messageFromContextTarget(target), 10),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, 10);
			},
		},
		{
			label: localize("Luck: show today's hidden status", "Szczęście: pokaż dzisiejszy stan"),
			icon: "fa-solid fa-eye",
			visible: (target) => game.user?.isGM === true && hasLuckSkill(actorForMessage(messageFromContextTarget(target))),
			onClick: (_event, target) => {
				const actor = actorForMessage(messageFromContextTarget(target));
				if (actor) showLuckStatus(actor);
			},
		},
		{
			label: localize("Luck: roll today's hidden allowance", "Szczęście: wylosuj dzisiejszy limit"),
			icon: "fa-solid fa-dice-six",
			visible: (target) => {
				if (!game.user?.isGM) return false;
				const actor = actorForMessage(messageFromContextTarget(target));
				return hasLuckSkill(actor) && !readLuckDaily(actor).initialized;
			},
			onClick: (_event, target) => {
				const actor = actorForMessage(messageFromContextTarget(target));
				if (actor) void rollLuckAllowanceNow(actor).catch(reportError);
			},
		},
		{
			label: localize("Luck: start a new day", "Szczęście: nowy dzień / reset"),
			icon: "fa-solid fa-sun",
			visible: (target) => game.user?.isGM === true && hasLuckSkill(actorForMessage(messageFromContextTarget(target))),
			onClick: (_event, target) => {
				const actor = actorForMessage(messageFromContextTarget(target));
				if (actor) void resetLuckDay(actor).catch(reportError);
			},
		},
	);
}

export async function useLuckOnMessage(message, delta, user = game.user) {
	try {
		const normalizedDelta = normalizeDelta(delta);
		const actor = actorForMessage(message);
		assertAttempt(message, actor, user, normalizedDelta);

		const result = user?.isGM
			? await performLuckUse(message, actor, user, normalizedDelta, true)
			: await requestLuckUseFromGm(message, normalizedDelta, user);

		reportUseResult(actor, result, user);
		return result;
	} catch (error) {
		reportError(error);
		return null;
	}
}

export async function resetLuckDay(actor, user = game.user) {
	assertGmActor(actor, user);
	const previous = readLuckDaily(actor);
	const next = {
		version: LUCK_VERSION,
		generation: previous.generation + 1,
		initialized: false,
		allowance: null,
		used: 0,
		exhausted: false,
		resetBy: String(user.id ?? ""),
		resetAt: Date.now(),
		rolledBy: "",
		rolledAt: null,
	};

	await persistLuckDaily(actor, next);
	ui.notifications.info(localize(
		`Luck reset for ${actor.name}. The next attempt will require a new hidden d6 roll.`,
		`Zresetowano Szczęście: ${actor.name}. Następna próba wymaga nowego tajnego rzutu K6.`,
	));
	return foundry.utils.deepClone(next);
}

export async function rollLuckAllowanceNow(actor, user = game.user) {
	assertGmActor(actor, user);

	return withActorLock(actor.uuid, async () => {
		const daily = readLuckDaily(actor);
		if (daily.initialized) {
			throw new Error(localize(
				"Today's Luck allowance is already rolled. Start a new day first.",
				"Dzisiejszy limit Szczęścia został już wylosowany. Najpierw rozpocznij nowy dzień.",
			));
		}

		const initialized = await initializeAllowance(actor, daily, user);
		showLuckStatus(actor, initialized);
		return initialized;
	});
}

export function luckStatus(actor) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) {
		return null;
	}

	return readLuckDaily(actor);
}

async function performLuckUse(message, actor, requester, delta, promptIfNeeded) {
	return withActorLock(actor.uuid, async () => {
		assertAttempt(message, actor, requester, delta);
		let daily = readLuckDaily(actor);

		if (!daily.initialized) {
			if (promptIfNeeded) {
				const confirmed = await confirmHiddenRoll(actor, requester);
				if (!confirmed) {
					return Object.freeze({ ok: false, cancelled: true, exhausted: false });
				}
			}

			daily = await initializeAllowance(actor, daily, game.user);
		}

		if (daily.used >= daily.allowance) {
			if (!daily.exhausted) {
				daily = { ...daily, exhausted: true };
				await persistLuckDaily(actor, daily);
			}

			return Object.freeze({ ok: false, cancelled: false, exhausted: true });
		}

		const state = testResultState(message);
		const originalRoll = finiteNumber(state.roll, "test roll");
		const adjustedRoll = originalRoll + delta;
		const nextDaily = {
			...daily,
			used: daily.used + 1,
			exhausted: false,
			lastUsedBy: String(requester?.id ?? ""),
			lastUsedAt: Date.now(),
		};
		const luckResult = {
			version: LUCK_VERSION,
			actorUuid: actor.uuid,
			generation: daily.generation,
			originalRoll,
			delta,
			adjustedRoll,
			usedBy: String(requester?.id ?? ""),
			usedAt: Date.now(),
		};

		await persistLuckDaily(actor, nextDaily);

		try {
			const updated = foundry.utils.deepClone(state);
			updated.roll = adjustedRoll;
			updated.updatedBy = String(requester?.id ?? "");
			updated.updatedAt = Date.now();
			const content = await TestResultChat._render(updated);

			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}`]: updated,
				[`flags.${FLAG_SCOPE}.${LUCK_RESULT_FLAG_KEY}`]: luckResult,
			});
		} catch (error) {
			try {
				await persistLuckDaily(actor, daily);
			} catch (rollbackError) {
				console.error("WFRP1ED | Luck rollback failed.", rollbackError);
			}
			throw error;
		}

		return Object.freeze({
			ok: true,
			cancelled: false,
			exhausted: false,
			originalRoll,
			adjustedRoll,
			delta,
		});
	});
}

async function initializeAllowance(actor, daily, user) {
	const roll = await new Roll("1d6").evaluate({ allowInteractive: false });
	const allowance = Math.trunc(finiteNumber(roll.total, "Luck allowance"));
	const next = {
		...daily,
		initialized: true,
		allowance,
		used: 0,
		exhausted: false,
		rolledBy: String(user?.id ?? ""),
		rolledAt: Date.now(),
	};

	await persistLuckDaily(actor, next);

	const whisper = [...(game.users ?? [])]
		.filter((candidate) => candidate?.isGM)
		.map((candidate) => candidate.id);

	await roll.toMessage({
		speaker: ChatMessage.getSpeaker({ actor }),
		flavor: localize(
			`Hidden daily Luck allowance — ${actor.name}`,
			`Tajny dzienny limit Szczęścia — ${actor.name}`,
		),
		whisper,
		flags: {
			[FLAG_SCOPE]: {
				luckAllowanceRoll: {
					version: LUCK_VERSION,
					actorUuid: actor.uuid,
					generation: next.generation,
				},
			},
		},
	});

	return foundry.utils.deepClone(next);
}

async function confirmHiddenRoll(actor, requester) {
	const requesterName = requester?.name || localize("A player", "Gracz");
	return foundry.applications.api.DialogV2.confirm({
		content: `<p>${escapeHtml(localize(
			`${requesterName} is trying to use Luck for ${actor.name}. Roll the hidden daily d6 allowance now?`,
			`${requesterName} próbuje użyć Szczęścia: ${actor.name}. Wykonać teraz tajny rzut K6 na dzienny limit?`,
		))}</p><p>${escapeHtml(localize(
			"The player will not be told the rolled allowance or how many uses remain.",
			"Gracz nie pozna wylosowanego limitu ani liczby pozostałych użyć.",
		))}</p>`,
		rejectClose: false,
		modal: true,
	});
}

async function requestLuckUseFromGm(message, delta, user) {
	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to use Luck because its daily allowance is secret.",
			"Do użycia Szczęścia potrzebny jest aktywny MG, ponieważ dzienny limit jest tajny.",
		));
	}

	const requestId = foundry.utils.randomID();
	const promise = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(localize(
				"The GM did not answer the Luck request in time.",
				"MG nie odpowiedział na próbę użycia Szczęścia w wyznaczonym czasie.",
			)));
		}, SOCKET_TIMEOUT_MS);

		pendingRequests.set(requestId, { resolve, reject, timeout });
	});

	game.socket.emit(SOCKET_CHANNEL, {
		type: SOCKET_USE_REQUEST,
		requestId,
		requesterUserId: String(user.id ?? ""),
		messageId: String(message.id ?? ""),
		delta,
	});

	return promise;
}

async function onSocketMessage(payload) {
	if (!payload || typeof payload !== "object") return;

	if (payload.type === SOCKET_USE_RESPONSE) {
		if (String(payload.recipientUserId ?? "") !== String(game.user?.id ?? "")) return;
		const pending = pendingRequests.get(String(payload.requestId ?? ""));
		if (!pending) return;

		clearTimeout(pending.timeout);
		pendingRequests.delete(String(payload.requestId ?? ""));

		if (payload.error) pending.reject(new Error(String(payload.error)));
		else pending.resolve(Object.freeze({
			ok: payload.ok === true,
			cancelled: payload.cancelled === true,
			exhausted: payload.exhausted === true,
			originalRoll: payload.originalRoll,
			adjustedRoll: payload.adjustedRoll,
			delta: payload.delta,
		}));
		return;
	}

	if (payload.type !== SOCKET_USE_REQUEST || !isPrimaryActiveGm()) return;

	const requesterUserId = String(payload.requesterUserId ?? "");
	const response = {
		type: SOCKET_USE_RESPONSE,
		requestId: String(payload.requestId ?? ""),
		recipientUserId: requesterUserId,
		ok: false,
		cancelled: false,
		exhausted: false,
	};

	try {
		const requester = game.users?.get(requesterUserId);
		if (!requester?.active) throw new Error("Luck requester is not active.");
		const message = game.messages?.get(String(payload.messageId ?? ""));
		const actor = actorForMessage(message);
		const delta = normalizeDelta(payload.delta);
		assertAttempt(message, actor, requester, delta);
		const result = await performLuckUse(message, actor, requester, delta, true);
		Object.assign(response, result);
	} catch (error) {
		console.error("WFRP1ED | GM Luck request failed.", error);
		response.error = error?.message ?? "Unable to use Luck.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function assertAttempt(message, actor, user, delta) {
	normalizeDelta(delta);
	if (!(message instanceof foundry.documents.ChatMessage)) throw new Error("Luck requires a completed ChatMessage test result.");
	if (!testResultState(message)) throw new Error("This ChatMessage has no WFRP test result.");
	if (!(actor instanceof foundry.documents.Actor)) throw new Error("The Actor for this test result is not available.");
	if (!hasLuckSkill(actor)) throw new Error(localize(`${actor.name} does not have the Luck skill.`, `${actor.name} nie posiada umiejętności Szczęście.`));
	if (!canManageActor(actor, user)) throw new Error(localize("Only the GM or an OWNER of the rolling Actor may use Luck.", "Szczęścia może użyć tylko MG albo właściciel postaci wykonującej rzut."));
	if (message.getFlag?.(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY)) throw new Error(localize("Luck has already modified this roll.", "Szczęście zostało już użyte do tego rzutu."));
	if (damageAlreadyApplied(message)) throw new Error(localize("Luck cannot change this roll after its damage has been applied.", "Nie można zmienić tego rzutu Szczęściem po zastosowaniu wynikających z niego obrażeń."));
}

function canAttemptLuck(message, delta) {
	try {
		const actor = actorForMessage(message);
		assertAttempt(message, actor, game.user, delta);
		return game.user?.isGM === true || Boolean(primaryActiveGm());
	} catch (_error) {
		return false;
	}
}

function actorForMessage(message) {
	const speaker = message?.speaker ?? {};

	// Token first: an unlinked synthetic Actor may own different Skills than its
	// world prototype. The roll belongs to the token which actually rolled it.
	const scene = game.scenes?.get?.(String(speaker.scene ?? ""));
	const token = scene?.tokens?.get?.(String(speaker.token ?? ""));
	if (token?.actor instanceof foundry.documents.Actor) return token.actor;

	const worldActor = game.actors?.get?.(String(speaker.actor ?? ""));
	return worldActor instanceof foundry.documents.Actor ? worldActor : null;
}

function hasLuckSkill(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return [...(actor.items ?? [])].some((item) => item?.type === "skill" && String(item.system?.rulesId ?? "").trim() === LUCK_RULES_ID);
}

function canManageActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function testResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state) ? state : null;
}

function damageAlreadyApplied(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	if (!state || typeof state !== "object") return false;
	if (state.application?.state === "applied") return true;

	const packetId = String(state.packet?.id ?? "").trim();
	const targetActorUuid = String(state.packet?.targetActorUuid ?? "").trim();
	if (!packetId || !targetActorUuid) return false;

	try {
		const actor = foundry.utils.fromUuidSync(targetActorUuid);
		return actor instanceof foundry.documents.Actor && DamageApplication.isApplied(actor, packetId);
	} catch (_error) {
		return false;
	}
}

function readLuckDaily(actor) {
	const raw = actor?.getFlag?.(FLAG_SCOPE, LUCK_DAILY_FLAG_KEY);
	const generation = positiveInteger(raw?.generation, 1);
	const initialized = raw?.initialized === true;
	const allowance = initialized ? allowanceValue(raw?.allowance) : null;
	const used = initialized ? Math.min(allowance, nonNegativeInteger(raw?.used)) : 0;

	return {
		version: LUCK_VERSION,
		generation,
		initialized,
		allowance,
		used,
		exhausted: initialized && (raw?.exhausted === true || used >= allowance),
		resetBy: String(raw?.resetBy ?? ""),
		resetAt: timestampOrNull(raw?.resetAt),
		rolledBy: String(raw?.rolledBy ?? ""),
		rolledAt: timestampOrNull(raw?.rolledAt),
		lastUsedBy: String(raw?.lastUsedBy ?? ""),
		lastUsedAt: timestampOrNull(raw?.lastUsedAt),
	};
}

async function persistLuckDaily(actor, state) {
	if (!game.user?.isGM) throw new Error("Only a GM may persist the hidden Luck allowance.");
	await actor.update({ [`flags.${FLAG_SCOPE}.${LUCK_DAILY_FLAG_KEY}`]: foundry.utils.deepClone(state) });
}

function showLuckStatus(actor, state = readLuckDaily(actor)) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) return;
	if (!state.initialized) {
		ui.notifications.info(localize(`Luck — ${actor.name}: no allowance has been rolled for the current day.`, `Szczęście — ${actor.name}: nie wylosowano jeszcze limitu na bieżący dzień.`));
		return;
	}

	const remaining = Math.max(0, state.allowance - state.used);
	ui.notifications.info(localize(`Luck — ${actor.name}: used ${state.used}/${state.allowance}, remaining ${remaining}.`, `Szczęście — ${actor.name}: wykorzystano ${state.used}/${state.allowance}, pozostało ${remaining}.`));
}

function reportUseResult(actor, result, user) {
	if (!result) return;
	if (result.cancelled) {
		ui.notifications.warn(localize("The hidden Luck roll was cancelled. The test result was not changed.", "Anulowano tajny rzut Szczęścia. Wynik testu nie został zmieniony."));
		return;
	}
	if (result.exhausted) {
		ui.notifications.warn(localize("Luck has deserted you.", "Szczęście cię opuściło."));
		return;
	}
	if (!result.ok) return;
	ui.notifications.info(localize(`Luck changed the roll: ${result.originalRoll} → ${result.adjustedRoll}.`, `Szczęście zmieniło wynik rzutu: ${result.originalRoll} → ${result.adjustedRoll}.`));
	if (user?.isGM) showLuckStatus(actor);
}

function applyLuckResultPresentation(message, html) {
	const result = message?.getFlag?.(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY);
	if (!result || typeof result !== "object") return;
	const root = asElement(html);
	if (!root) return;
	const card = root.matches?.(".wfrp1e-test-card") ? root : root.querySelector?.(".wfrp1e-test-card");
	if (!card) return;
	card.querySelector?.("[data-wfrp-luck-result]")?.remove();

	const panel = document.createElement("div");
	panel.className = "wfrp1e-luck-result";
	panel.dataset.wfrpLuckResult = "";
	const label = document.createElement("strong");
	label.textContent = localize("Luck", "Szczęście");
	const history = document.createElement("span");
	history.textContent = `${result.originalRoll} → ${result.adjustedRoll} (${signed(result.delta)})`;
	panel.append(label, history);
	card.append(panel);
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement ? target : target?.[0] instanceof HTMLElement ? target[0] : null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(entry?.dataset?.messageId ?? target?.attr?.("data-message-id") ?? target?.data?.("message-id") ?? "").trim();
	return messageId ? game.messages?.get(messageId) ?? null : null;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return game.user?.isGM === true && primaryActiveGm()?.id === game.user.id;
}

function withActorLock(key, operation) {
	const previous = actorLocks.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	actorLocks.set(key, current);
	return current.finally(() => {
		if (actorLocks.get(key) === current) actorLocks.delete(key);
	});
}

function assertGmActor(actor, user) {
	if (!user?.isGM) throw new Error(localize("Only the GM can manage the hidden Luck allowance.", "Tylko MG może zarządzać tajnym limitem Szczęścia."));
	if (!hasLuckSkill(actor)) throw new Error(localize("This Actor does not have the Luck skill.", "Ta postać nie posiada umiejętności Szczęście."));
}

function normalizeDelta(value) {
	const number = Number(value);
	if (number !== -10 && number !== 10) throw new Error(`Luck d100 adjustment must be -10 or +10: ${String(value)}`);
	return number;
}

function allowanceValue(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6 ? number : 1;
}

function positiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : 0;
}

function timestampOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`${label} must be finite: ${String(value)}`);
	return number;
}

function signed(value) {
	const number = Number(value);
	return number >= 0 ? `+${number}` : String(number);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function escapeHtml(value) {
	const element = document.createElement("div");
	element.textContent = String(value ?? "");
	return element.innerHTML;
}

function reportError(error) {
	console.error("WFRP1ED | Luck operation failed.", error);
	ui.notifications.error(error?.message ?? localize("Unable to use Luck.", "Nie można użyć Szczęścia."));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
