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
const SOCKET_USE_REQUEST = "luck-use-request";
const SOCKET_USE_RESPONSE = "luck-use-response";
const SOCKET_TIMEOUT_MS = 60000;

const pendingSocketRequests = new Map();
const actorLocks = new Map();

Hooks.on("renderChatMessageHTML", (message, html) => {
	applyLuckClientState(message, html);
});

Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
	addLuckContextMenuOptions(menuItems);
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

/**
 * Add Luck/Szczęście actions to completed d100 TestResult chat cards.
 *
 * Players only receive the two roll-adjustment actions. Daily allowance
 * management stays GM-only because the Core Rulebook explicitly keeps the
 * number of available uses secret from the player.
 */
function addLuckContextMenuOptions(menuItems) {
	if (!Array.isArray(menuItems)) return;

	menuItems.push(
		{
			label: localize(
				"WFRP1ED.Luck.UseMinusTen",
				"Luck: change roll by -10",
				"Szczęście: zmień wynik o -10",
			),
			icon: '<i class="fa-solid fa-clover"></i>',
			visible: (target) => {
				const message = messageFromContextTarget(target);
				return canCurrentUserAttemptLuck(message, -10);
			},
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, -10);
			},
		},
		{
			label: localize(
				"WFRP1ED.Luck.UsePlusTen",
				"Luck: change roll by +10",
				"Szczęście: zmień wynik o +10",
			),
			icon: '<i class="fa-solid fa-clover"></i>',
			visible: (target) => {
				const message = messageFromContextTarget(target);
				return canCurrentUserAttemptLuck(message, 10);
			},
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, 10);
			},
		},
		{
			label: localize(
				"WFRP1ED.Luck.ShowStatus",
				"Luck: show today's hidden status",
				"Szczęście: pokaż dzisiejszy stan",
			),
			icon: '<i class="fa-solid fa-eye"></i>',
			visible: (target) => {
				if (!game.user?.isGM) return false;
				const actor = actorForMessage(messageFromContextTarget(target));
				return hasLuckSkill(actor);
			},
			onClick: (_event, target) => {
				const actor = actorForMessage(messageFromContextTarget(target));
				if (actor) showLuckStatus(actor);
			},
		},
		{
			label: localize(
				"WFRP1ED.Luck.RollAllowance",
				"Luck: roll today's hidden allowance",
				"Szczęście: wylosuj dzisiejszy limit",
			),
			icon: '<i class="fa-solid fa-dice-six"></i>',
			visible: (target) => {
				if (!game.user?.isGM) return false;
				const actor = actorForMessage(messageFromContextTarget(target));
				if (!hasLuckSkill(actor)) return false;
				return !readLuckDaily(actor).initialized;
			},
			onClick: (_event, target) => {
				const actor = actorForMessage(messageFromContextTarget(target));
				if (actor) void rollLuckAllowanceNow(actor).catch(reportLuckError);
			},
		},
		{
			label: localize(
				"WFRP1ED.Luck.ResetDay",
				"Luck: start a new day",
				"Szczęście: nowy dzień / reset",
			),
			icon: '<i class="fa-solid fa-sun"></i>',
			visible: (target) => {
				if (!game.user?.isGM) return false;
				const actor = actorForMessage(messageFromContextTarget(target));
				return hasLuckSkill(actor);
			},
			onClick: (_event, target) => {
				const actor = actorForMessage(messageFromContextTarget(target));
				if (actor) void resetLuckDay(actor).catch(reportLuckError);
			},
		},
	);
}

/**
 * Attempt to use one daily Luck allowance on a completed d100 TestResult.
 *
 * Non-GM owners route the request through the elected active GM. The response
 * deliberately does not contain the hidden d6 allowance or remaining uses.
 */
export async function useLuckOnMessage(message, delta, user = game.user) {
	try {
		const normalizedDelta = normalizeLuckDelta(delta);
		const actor = actorForMessage(message);
		assertLuckAttempt(message, actor, user, normalizedDelta);

		let result;

		if (user?.isGM) {
			result = await performLuckUse({
				message,
				actor,
				requester: user,
				delta: normalizedDelta,
				promptIfNeeded: true,
			});
		} else {
			result = await requestLuckUseFromGm(
				message,
				normalizedDelta,
				user,
			);
		}

		reportLuckUseResult(actor, result, user);
		return result;
	} catch (error) {
		reportLuckError(error);
		return null;
	}
}

/**
 * GM-only reset for the beginning of a new in-game day.
 *
 * The reset intentionally does not roll 1d6. The English Core Rulebook rolls
 * the secret allowance on the first attempted use of Luck that day. A separate
 * GM action can roll it immediately when the table follows the Polish timing.
 */
export async function resetLuckDay(actor, user = game.user) {
	assertGmLuckActor(actor, user);

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

	ui.notifications.info(
		localize(
			"WFRP1ED.Luck.ResetNotice",
			`Luck reset for ${actor.name}. The next attempt will require a new hidden d6 roll.`,
			`Zresetowano Szczęście: ${actor.name}. Następna próba wymaga nowego tajnego rzutu K6.`,
		),
	);

	return deepFrozenCopy(next);
}

/** GM-only manual initialization for tables using the Polish start-of-day timing. */
export async function rollLuckAllowanceNow(actor, user = game.user) {
	assertGmLuckActor(actor, user);

	return withActorLock(actor.uuid, async () => {
		const daily = readLuckDaily(actor);

		if (daily.initialized) {
			throw new Error(
				localize(
					"WFRP1ED.Luck.AlreadyInitialized",
					"Today's Luck allowance is already rolled. Start a new day before rolling another allowance.",
					"Dzisiejszy limit Szczęścia został już wylosowany. Najpierw rozpocznij nowy dzień.",
				),
			);
		}

		const initialized = await initializeLuckAllowance(actor, daily, user);
		showLuckStatus(actor, initialized);
		return initialized;
	});
}

/** Return GM-readable state. Callers must not expose it to non-GM users. */
export function luckStatus(actor) {
	if (!game.user?.isGM) return null;
	if (!hasLuckSkill(actor)) return null;
	return readLuckDaily(actor);
}

async function performLuckUse({
	message,
	actor,
	requester,
	delta,
	promptIfNeeded,
}) {
	return withActorLock(actor.uuid, async () => {
		assertLuckAttempt(message, actor, requester, delta);

		let daily = readLuckDaily(actor);

		if (!daily.initialized) {
			if (promptIfNeeded) {
				const confirmed = await confirmHiddenLuckRoll(actor, requester);
				if (!confirmed) {
					return Object.freeze({
						ok: false,
						cancelled: true,
						exhausted: false,
					});
				}
			}

			daily = await initializeLuckAllowance(actor, daily, game.user);
		}

		if (daily.used >= daily.allowance) {
			if (!daily.exhausted) {
				daily = {
					...daily,
					exhausted: true,
				};
				await persistLuckDaily(actor, daily);
			}

			return Object.freeze({
				ok: false,
				cancelled: false,
				exhausted: true,
			});
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

		// Daily allowance is consumed by the GM before the public card changes.
		// If the ChatMessage update fails, we attempt to roll that consumption
		// back so a transient chat error does not silently burn a Luck use.
		await persistLuckDaily(actor, nextDaily);

		try {
			const updatedState = foundry.utils.deepClone(state);
			updatedState.roll = adjustedRoll;
			updatedState.updatedBy = String(requester?.id ?? "");
			updatedState.updatedAt = Date.now();

			const content = await TestResultChat._render(updatedState);

			await message.update({
				content,
				[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}`]: updatedState,
				[`flags.${FLAG_SCOPE}.${LUCK_RESULT_FLAG_KEY}`]: luckResult,
			});
		} catch (error) {
			try {
				await persistLuckDaily(actor, daily);
			} catch (rollbackError) {
				console.error(
					"WFRP1ED | Luck use failed and daily allowance rollback also failed.",
					rollbackError,
				);
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

async function initializeLuckAllowance(actor, daily, user) {
	const roll = await new Roll("1d6").evaluate({
		allowInteractive: false,
	});
	const allowance = Math.trunc(finiteNumber(roll.total, "Luck allowance"));

	if (allowance < 1 || allowance > 6) {
		throw new Error(`Luck allowance must be between 1 and 6: ${allowance}`);
	}

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

	try {
		await roll.toMessage({
			speaker: ChatMessage.getSpeaker({ actor }),
			flavor: localize(
				"WFRP1ED.Luck.HiddenRollFlavor",
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
	} catch (error) {
		console.error(
			"WFRP1ED | Luck allowance was stored, but the GM-only roll message could not be created.",
			error,
		);
		ui.notifications.warn(
			localize(
				"WFRP1ED.Luck.HiddenRollMessageFailed",
				"The Luck allowance was stored, but its GM-only roll message could not be posted.",
				"Limit Szczęścia zapisano, ale nie udało się opublikować tajnego rzutu dla MG.",
			),
		);
	}

	return deepFrozenCopy(next);
}

async function confirmHiddenLuckRoll(actor, requester) {
	const requesterName = requester?.name || localize(
		"WFRP1ED.Luck.UnknownUser",
		"A player",
		"Gracz",
	);
	const content = document.createElement("div");

	const first = document.createElement("p");
	first.textContent = localize(
		"WFRP1ED.Luck.HiddenRollPrompt",
		`${requesterName} is trying to use Luck for ${actor.name}. Roll the hidden daily d6 allowance now?`,
		`${requesterName} próbuje użyć Szczęścia: ${actor.name}. Wykonać teraz tajny rzut K6 na dzienny limit?`,
	);
	content.append(first);

	const second = document.createElement("p");
	second.textContent = localize(
		"WFRP1ED.Luck.HiddenRollPromptHint",
		"The player will not be told the rolled allowance or how many uses remain.",
		"Gracz nie pozna wylosowanego limitu ani liczby pozostałych użyć.",
	);
	content.append(second);

	return foundry.applications.api.DialogV2.confirm({
		content: content.outerHTML,
		rejectClose: false,
		modal: true,
	});
}

async function requestLuckUseFromGm(message, delta, user) {
	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.RequiresGM",
				"An active GM is required to use Luck because its daily allowance is secret.",
				"Do użycia Szczęścia potrzebny jest aktywny MG, ponieważ dzienny limit jest tajny.",
			),
		);
	}

	const requestId = foundry.utils.randomID();
	const promise = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingSocketRequests.delete(requestId);
			reject(
				new Error(
					localize(
						"WFRP1ED.Luck.GMTimeout",
						"The GM did not answer the Luck request in time.",
						"MG nie odpowiedział na próbę użycia Szczęścia w wyznaczonym czasie.",
					),
				),
			);
		}, SOCKET_TIMEOUT_MS);

		pendingSocketRequests.set(requestId, {
			resolve,
			reject,
			timeout,
		});
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
		const recipient = String(payload.recipientUserId ?? "");
		if (recipient !== String(game.user?.id ?? "")) return;

		const pending = pendingSocketRequests.get(payload.requestId);
		if (!pending) return;

		clearTimeout(pending.timeout);
		pendingSocketRequests.delete(payload.requestId);

		if (payload.ok || payload.cancelled || payload.exhausted) {
			pending.resolve(Object.freeze({
				ok: payload.ok === true,
				cancelled: payload.cancelled === true,
				exhausted: payload.exhausted === true,
				originalRoll: payload.originalRoll,
				adjustedRoll: payload.adjustedRoll,
				delta: payload.delta,
			}));
		} else {
			pending.reject(
				new Error(
					String(payload.error ?? localize(
						"WFRP1ED.Luck.RequestFailed",
						"Unable to use Luck.",
						"Nie można użyć Szczęścia.",
					)),
				),
			);
		}
		return;
	}

	if (payload.type !== SOCKET_USE_REQUEST || !isPrimaryActiveGm()) {
		return;
	}

	const requestId = String(payload.requestId ?? "");
	const requesterUserId = String(payload.requesterUserId ?? "");
	const response = {
		type: SOCKET_USE_RESPONSE,
		requestId,
		recipientUserId: requesterUserId,
		ok: false,
		cancelled: false,
		exhausted: false,
	};

	try {
		const requester = game.users?.get(requesterUserId);
		if (!requester?.active) {
			throw new Error("Luck requester is not an active user.");
		}

		const message = game.messages?.get(String(payload.messageId ?? ""));
		const actor = actorForMessage(message);
		const delta = normalizeLuckDelta(payload.delta);
		assertLuckAttempt(message, actor, requester, delta);

		const result = await performLuckUse({
			message,
			actor,
			requester,
			delta,
			promptIfNeeded: true,
		});

		Object.assign(response, {
			ok: result.ok === true,
			cancelled: result.cancelled === true,
			exhausted: result.exhausted === true,
			originalRoll: result.originalRoll,
			adjustedRoll: result.adjustedRoll,
			delta: result.delta,
		});
	} catch (error) {
		console.error("WFRP1ED | GM Luck request failed.", error);
		response.error = error?.message ?? "Unable to use Luck.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function assertLuckAttempt(message, actor, user, delta) {
	normalizeLuckDelta(delta);

	if (!(message instanceof foundry.documents.ChatMessage)) {
		throw new Error("Luck requires a completed ChatMessage test result.");
	}

	const state = testResultState(message);
	if (!state) {
		throw new Error("This ChatMessage has no WFRP test result.");
	}

	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The Actor for this test result is not available.");
	}

	if (!hasLuckSkill(actor)) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.SkillRequired",
				`${actor.name} does not have the Luck skill.`,
				`${actor.name} nie posiada umiejętności Szczęście.`,
			),
		);
	}

	if (!canManageLuckActor(actor, user)) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.OwnerRequired",
				"Only the GM or an OWNER of the rolling Actor may use its Luck.",
				"Szczęścia może użyć tylko MG albo właściciel postaci wykonującej rzut.",
			),
		);
	}

	if (message.getFlag?.(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY)) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.AlreadyUsedOnRoll",
				"Luck has already modified this roll.",
				"Szczęście zostało już użyte do tego rzutu.",
			),
		);
	}

	if (damageAlreadyApplied(message)) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.DamageAlreadyApplied",
				"Luck cannot change this roll after its damage has been applied.",
				"Nie można zmienić tego rzutu Szczęściem po zastosowaniu wynikających z niego obrażeń.",
			),
		);
	}

	finiteNumber(state.roll, "test roll");
}

function canCurrentUserAttemptLuck(message, delta) {
	try {
		const actor = actorForMessage(message);
		assertLuckAttempt(message, actor, game.user, delta);
		if (game.user?.isGM) return true;
		return Boolean(primaryActiveGm());
	} catch (_error) {
		return false;
	}
}

function hasLuckSkill(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return false;

	return [...(actor.items ?? [])].some((item) =>
		item?.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === LUCK_RULES_ID,
	);
}

function canManageLuckActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;

	return actor.testUserPermission(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	);
}

function actorForMessage(message) {
	const speaker = message?.speaker ?? {};
	const worldActor = game.actors?.get?.(String(speaker.actor ?? ""));
	if (worldActor instanceof foundry.documents.Actor) return worldActor;

	const scene = game.scenes?.get?.(String(speaker.scene ?? ""));
	const token = scene?.tokens?.get?.(String(speaker.token ?? ""));
	return token?.actor instanceof foundry.documents.Actor
		? token.actor
		: null;
}

function testResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
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
		return actor instanceof foundry.documents.Actor &&
			DamageApplication.isApplied(actor, packetId);
	} catch (_error) {
		return false;
	}
}

function readLuckDaily(actor) {
	const raw = actor?.getFlag?.(FLAG_SCOPE, LUCK_DAILY_FLAG_KEY);
	const generation = normalizePositiveInteger(raw?.generation, 1);
	const initialized = raw?.initialized === true;
	const allowance = initialized
		? normalizeAllowance(raw?.allowance)
		: null;
	const used = initialized
		? Math.min(allowance, normalizeNonNegativeInteger(raw?.used))
		: 0;

	return {
		version: LUCK_VERSION,
		generation,
		initialized,
		allowance,
		used,
		exhausted: initialized && (
			raw?.exhausted === true || used >= allowance
		),
		resetBy: String(raw?.resetBy ?? ""),
		resetAt: finiteTimestampOrNull(raw?.resetAt),
		rolledBy: String(raw?.rolledBy ?? ""),
		rolledAt: finiteTimestampOrNull(raw?.rolledAt),
		lastUsedBy: String(raw?.lastUsedBy ?? ""),
		lastUsedAt: finiteTimestampOrNull(raw?.lastUsedAt),
	};
}

async function persistLuckDaily(actor, state) {
	if (!game.user?.isGM) {
		throw new Error("Only a GM client may persist the hidden Luck allowance.");
	}

	await actor.update({
		[`flags.${FLAG_SCOPE}.${LUCK_DAILY_FLAG_KEY}`]: foundry.utils.deepClone(state),
	});
}

function showLuckStatus(actor, explicitState = null) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) return;

	const state = explicitState ?? readLuckDaily(actor);

	if (!state.initialized) {
		ui.notifications.info(
			localize(
				"WFRP1ED.Luck.StatusUninitialized",
				`Luck — ${actor.name}: no allowance has been rolled for the current day.`,
				`Szczęście — ${actor.name}: nie wylosowano jeszcze limitu na bieżący dzień.`,
			),
		);
		return;
	}

	const remaining = Math.max(0, state.allowance - state.used);
	ui.notifications.info(
		localize(
			"WFRP1ED.Luck.Status",
			`Luck — ${actor.name}: used ${state.used}/${state.allowance}, remaining ${remaining}.`,
			`Szczęście — ${actor.name}: wykorzystano ${state.used}/${state.allowance}, pozostało ${remaining}.`,
		),
	);
}

function reportLuckUseResult(actor, result, user) {
	if (!result) return;

	if (result.cancelled) {
		ui.notifications.warn(
			localize(
				"WFRP1ED.Luck.Cancelled",
				"The hidden Luck allowance roll was cancelled. The test result was not changed.",
				"Anulowano tajny rzut limitu Szczęścia. Wynik testu nie został zmieniony.",
			),
		);
		return;
	}

	if (result.exhausted) {
		ui.notifications.warn(
			localize(
				"WFRP1ED.Luck.Exhausted",
				"Luck has deserted you.",
				"Szczęście cię opuściło.",
			),
		);
		return;
	}

	if (!result.ok) return;

	ui.notifications.info(
		localize(
			"WFRP1ED.Luck.Applied",
			`Luck changed the roll: ${result.originalRoll} → ${result.adjustedRoll}.`,
			`Szczęście zmieniło wynik rzutu: ${result.originalRoll} → ${result.adjustedRoll}.`,
		),
	);

	if (user?.isGM) showLuckStatus(actor);
}

function applyLuckClientState(message, html) {
	const result = message?.getFlag?.(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY);
	if (!result || typeof result !== "object") return;

	const root = asElement(html);
	if (!root) return;

	const card = root.matches?.(".wfrp1e-test-card")
		? root
		: root.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	card.querySelector?.("[data-wfrp-luck-result]")?.remove();

	const panel = document.createElement("div");
	panel.className = "wfrp1e-luck-result";
	panel.dataset.wfrpLuckResult = "";

	const label = document.createElement("strong");
	label.textContent = localize(
		"WFRP1ED.Luck.Label",
		"Luck",
		"Szczęście",
	);
	panel.append(label);

	const history = document.createElement("span");
	history.textContent = `${result.originalRoll} → ${result.adjustedRoll} (${signed(result.delta)})`;
	panel.append(history);

	card.append(panel);
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(
		entry?.dataset?.messageId ??
			target?.attr?.("data-message-id") ??
			target?.data?.("message-id") ??
			"",
	).trim();

	return messageId ? game.messages?.get(messageId) ?? null : null;
}

function normalizeLuckDelta(value) {
	const number = Number(value);
	if (number !== -10 && number !== 10) {
		throw new Error(`Luck d100 adjustment must be -10 or +10: ${String(value)}`);
	}
	return number;
}

function normalizeAllowance(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6
		? number
		: 1;
}

function normalizePositiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : 0;
}

function finiteTimestampOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be finite: ${String(value)}`);
	}
	return number;
}

function signed(value) {
	const number = Number(value);
	return number >= 0 ? `+${number}` : String(number);
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	const gm = primaryActiveGm();
	return Boolean(
		gm &&
		game.user?.isGM &&
		String(gm.id) === String(game.user.id),
	);
}

async function withActorLock(actorUuid, operation) {
	const key = String(actorUuid ?? "");
	const previous = actorLocks.get(key) ?? Promise.resolve();
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => gate);
	actorLocks.set(key, queued);

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (actorLocks.get(key) === queued) actorLocks.delete(key);
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function deepFrozenCopy(value) {
	return foundry.utils.deepFreeze(
		foundry.utils.deepClone(value),
	);
}

function assertGmLuckActor(actor, user) {
	if (!user?.isGM) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.GMOnly",
				"Only a GM can manage the hidden daily Luck allowance.",
				"Tylko MG może zarządzać tajnym dziennym limitem Szczęścia.",
			),
		);
	}

	if (!(actor instanceof foundry.documents.Actor) || !hasLuckSkill(actor)) {
		throw new Error(
			localize(
				"WFRP1ED.Luck.SkillRequired",
				"This Actor does not have the Luck skill.",
				"Ta postać nie posiada umiejętności Szczęście.",
			),
		);
	}
}

function reportLuckError(error) {
	console.error("WFRP1ED | Luck operation failed.", error);
	ui.notifications.error(
		error?.message ?? localize(
			"WFRP1ED.Luck.Error",
			"Unable to use Luck.",
			"Nie można użyć Szczęścia.",
		),
	);
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}
