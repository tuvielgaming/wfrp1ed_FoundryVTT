import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	HeldItemsCheck,
	HELD_ITEMS_LUCK_ROLL_ID,
} from "../movement/HeldItemsCheck.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_RESULT_FLAG_KEY = "testResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const LUCK_RESULT_FLAG_KEY = "luckResult"; // legacy v1/v2
const LUCK_RESULTS_FLAG_KEY = "luckResults"; // legacy v3 map
const LUCK_HISTORY_FLAG_KEY = "luckHistory";
const LUCK_DAILY_FLAG_KEY = "luckDaily";
const LUCK_RULES_ID = "luck";
const LUCK_VERSION = 4;

const TEST_ROLL_ID = "test.primary";

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_USE_REQUEST = "luck-v5-use-request";
const SOCKET_USE_RESPONSE = "luck-v5-use-response";
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
			resetPools: resetDailyLuckPools,
			resetPlayers: resetPlayerLuckPools,
			resetNpcs: resetNpcLuckPools,
			status: luckStatus,
			options: luckOptionsForMessage,
			history: luckHistoryFor,
		}),
	});
});

function addLuckContextOptions(menuItems) {
	if (!Array.isArray(menuItems)) return;

	menuItems.push(
		luckContextEntry({
			delta: -10,
			english: "Luck: change d100 by -10",
			polish: "Szczęście: zmień K100 o -10",
		}),
		luckContextEntry({
			delta: 10,
			english: "Luck: change d100 by +10",
			polish: "Szczęście: zmień K100 o +10",
		}),
		luckContextEntry({
			delta: -1,
			english: "Luck: change d6 by -1",
			polish: "Szczęście: zmień K6 o -1",
		}),
		luckContextEntry({
			delta: 1,
			english: "Luck: change d6 by +1",
			polish: "Szczęście: zmień K6 o +1",
		}),
		{
			label: localize(
				"Luck: show today's hidden status",
				"Szczęście: pokaż dzisiejszy stan",
			),
			icon: "fa-solid fa-eye",
			visible: (target) => {
				if (!game.user?.isGM) return false;
				return hasLuckSkill(
					actorForMessage(messageFromContextTarget(target)),
				);
			},
			onClick: (_event, target) => {
				const actor = actorForMessage(
					messageFromContextTarget(target),
				);
				if (actor) showLuckStatus(actor);
			},
		},
		{
			label: localize(
				"Luck: reset daily pools…",
				"Szczęście: resetuj dzienne pule…",
			),
			icon: "fa-solid fa-sun",
			visible: (target) =>
				game.user?.isGM === true &&
				isWfrpResultMessage(messageFromContextTarget(target)),
			onClick: () => {
				void promptAndResetDailyLuckPools().catch(reportError);
			},
		},
	);
}

function luckContextEntry({ delta, english, polish }) {
	return {
		label: localize(english, polish),
		icon: "fa-solid fa-clover",
		visible: (target) =>
			canAttemptLuck(messageFromContextTarget(target), delta),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (message) void useLuckOnMessage(message, delta);
		},
	};
}

/**
 * Spend one hidden daily Luck use on a concrete roll.
 *
 * WFRP 1e limits the number of Luck uses per day, but the verified rule does
 * not impose a one-use-per-roll restriction. Therefore repeated adjustments of
 * the same roll are legal while the daily pool remains and the provider still
 * exposes a useful adjustment. Every use is appended to an audit history.
 */
export async function useLuckOnMessage(
	message,
	delta,
	user = game.user,
	rollId = null,
) {
	try {
		const adjustment = resolveLuckAdjustment(message, delta, rollId);
		const actor = actorForMessage(message);
		assertAttempt(message, actor, user, adjustment);

		const result = user?.isGM
			? await performLuckUse(message, actor, user, adjustment)
			: await requestLuckUseFromGm(message, adjustment, user);

		reportUseResult(actor, result, user);
		return result;
	} catch (error) {
		reportError(error);
		return null;
	}
}

async function promptAndResetDailyLuckPools() {
	if (!game.user?.isGM) {
		throw new Error("Only a GM may reset daily Luck pools.");
	}

	const groups = collectLuckActors();
	const content = document.createElement("div");

	const intro = document.createElement("p");
	intro.textContent = localize(
		"Start a new in-game day and secretly roll a new d6 Luck pool for every selected Actor with Luck.",
		"Rozpocznij nowy dzień gry i wykonaj tajny rzut K6 na nową pulę Szczęścia dla każdej wybranej postaci posiadającej Szczęście.",
	);
	content.append(intro);
	content.append(
		resetCheckbox(
			"players",
			localize(
				`Player characters (${groups.players.length})`,
				`Postacie graczy (${groups.players.length})`,
			),
			true,
		),
	);
	content.append(
		resetCheckbox(
			"npcs",
			localize(
				`NPCs / Monsters (${groups.npcs.length})`,
				`NPC / Potwory (${groups.npcs.length})`,
			),
			false,
		),
	);

	const selection = await foundry.applications.api.DialogV2.wait({
		window: {
			title: localize(
				"Reset Daily Luck Pools",
				"Reset dziennych pul Szczęścia",
			),
		},
		content,
		modal: true,
		rejectClose: false,
		buttons: [
			{
				action: "reset",
				label: localize("Reset and Roll", "Resetuj i rzuć"),
				icon: "fa-solid fa-dice-six",
				default: true,
				callback: (_event, button) => ({
					players:
						button.form?.elements?.players?.checked === true,
					npcs:
						button.form?.elements?.npcs?.checked === true,
				}),
			},
			{
				action: "cancel",
				label: localize("Cancel", "Anuluj"),
				icon: "fa-solid fa-xmark",
			},
		],
	});

	if (!selection || typeof selection !== "object") return null;
	return resetDailyLuckPools(selection, game.user, groups);
}

export async function resetDailyLuckPools(
	{ players = true, npcs = false } = {},
	user = game.user,
	precollectedGroups = null,
) {
	assertGm(user);

	if (!players && !npcs) {
		ui.notifications.warn(
			localize(
				"No Luck group was selected.",
				"Nie wybrano żadnej grupy Szczęścia.",
			),
		);
		return Object.freeze({ players: 0, npcs: 0, failed: 0 });
	}

	const groups = precollectedGroups ?? collectLuckActors();
	let playerResult = { success: 0, failed: 0 };
	let npcResult = { success: 0, failed: 0 };

	if (players) {
		playerResult = await resetPlayerLuckPools(groups.players, user);
	}
	if (npcs) {
		npcResult = await resetNpcLuckPools(groups.npcs, user);
	}

	const total = playerResult.success + npcResult.success;
	const failed = playerResult.failed + npcResult.failed;
	ui.notifications.info(
		localize(
			`Daily Luck pools reset: ${total}. Failed: ${failed}.`,
			`Zresetowano dzienne pule Szczęścia: ${total}. Błędy: ${failed}.`,
		),
	);

	return Object.freeze({
		players: playerResult.success,
		npcs: npcResult.success,
		failed,
	});
}

export async function resetPlayerLuckPools(
	actors = collectLuckActors().players,
	user = game.user,
) {
	assertGm(user);
	return resetActorGroup(actors, user, "player");
}

export async function resetNpcLuckPools(
	actors = collectLuckActors().npcs,
	user = game.user,
) {
	assertGm(user);
	return resetActorGroup(actors, user, "npc");
}

export function luckStatus(actor) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) return null;
	return readLuckDaily(actor);
}

export function luckHistoryFor(message) {
	return readLuckHistory(message).map((entry) =>
		foundry.utils.deepClone(entry),
	);
}

async function resetActorGroup(actors, user, group) {
	let success = 0;
	let failed = 0;

	for (const actor of actors) {
		try {
			await resetAndRollActor(actor, user, group);
			success += 1;
		} catch (error) {
			failed += 1;
			console.error(
				`WFRP1ED | Unable to reset Luck for ${actor?.name ?? "Actor"}.`,
				error,
			);
		}
	}

	return { success, failed };
}

async function resetAndRollActor(actor, user, group) {
	return withActorLock(actor.uuid, async () => {
		if (!hasLuckSkill(actor)) return null;
		const previous = readLuckDaily(actor);
		const daily = {
			version: LUCK_VERSION,
			generation: previous.generation + 1,
			initialized: false,
			allowance: null,
			used: 0,
			exhausted: false,
			group,
			resetBy: String(user.id ?? ""),
			resetAt: Date.now(),
			rolledBy: "",
			rolledAt: null,
			lastUsedBy: "",
			lastUsedAt: null,
		};
		return initializeAllowance(actor, daily, user);
	});
}

async function performLuckUse(
	message,
	actor,
	requester,
	requestedAdjustment,
) {
	return withActorLock(actor.uuid, async () => {
		/*
		 * Re-resolve after acquiring the Actor lock. Two fast clicks may have been
		 * queued with the same pre-lock value; the second use must continue from
		 * the result produced by the first one rather than reuse stale state.
		 */
		const adjustment = resolveLuckAdjustment(
			message,
			requestedAdjustment.delta,
			requestedAdjustment.id,
		);
		assertAttempt(message, actor, requester, adjustment);

		const daily = readLuckDaily(actor);
		if (!daily.initialized) {
			throw new Error(
				localize(
					"The GM has not generated today's Luck pool yet. Ask the GM to use 'Reset Daily Luck Pools'.",
					"MG nie wygenerował jeszcze dzisiejszej puli Szczęścia. MG musi użyć „Reset dziennych pul Szczęścia”.",
				),
			);
		}

		if (daily.used >= daily.allowance) {
			if (!daily.exhausted) {
				await persistLuckDaily(actor, {
					...daily,
					exhausted: true,
				});
			}
			return Object.freeze({
				ok: false,
				cancelled: false,
				exhausted: true,
			});
		}

		const nextDaily = {
			...daily,
			used: daily.used + 1,
			exhausted: false,
			lastUsedBy: String(requester?.id ?? ""),
			lastUsedAt: Date.now(),
		};
		await persistLuckDaily(actor, nextDaily);

		try {
			const result = await applyLuckThroughProvider(
				message,
				actor,
				requester,
				adjustment,
				daily,
			);
			return Object.freeze({
				ok: true,
				cancelled: false,
				exhausted: false,
				...result,
			});
		} catch (error) {
			try {
				await persistLuckDaily(actor, daily);
			} catch (rollbackError) {
				console.error(
					"WFRP1ED | Luck allowance rollback failed.",
					rollbackError,
				);
			}
			throw error;
		}
	});
}

async function applyLuckThroughProvider(
	message,
	actor,
	requester,
	adjustment,
	daily,
) {
	switch (adjustment.provider) {
		case "test":
			return applyLuckToTest(
				message,
				actor,
				requester,
				adjustment,
				daily,
			);
		case "movement":
			return applyLuckToExternalProvider(
				message,
				actor,
				requester,
				adjustment,
				daily,
				MovementStandardTest,
			);
		case "held-items":
			return applyLuckToExternalProvider(
				message,
				actor,
				requester,
				adjustment,
				daily,
				HeldItemsCheck,
			);
		default:
			throw new Error(
				`Unknown Luck provider '${String(adjustment.provider)}'.`,
			);
	}
}

async function applyLuckToTest(
	message,
	actor,
	requester,
	adjustment,
	daily,
) {
	const state = testResultState(message);
	const originalRoll = finiteNumber(state.roll, "test roll");
	const adjustedRoll = originalRoll + adjustment.delta;
	const updated = foundry.utils.deepClone(state);
	updated.roll = adjustedRoll;
	updated.updatedBy = String(requester?.id ?? "");
	updated.updatedAt = Date.now();

	const event = buildLuckEvent({
		actor,
		daily,
		requester,
		adjustment,
		originalRoll,
		adjustedRoll,
	});
	const history = [...readLuckHistory(message), event];
	const content = await TestResultChat._render(updated);

	await message.update({
		content,
		[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}`]: updated,
		[`flags.${FLAG_SCOPE}.${LUCK_HISTORY_FLAG_KEY}`]: history,
	});

	return {
		rollId: adjustment.id,
		originalRoll,
		adjustedRoll,
		delta: adjustment.delta,
	};
}

async function applyLuckToExternalProvider(
	message,
	actor,
	requester,
	adjustment,
	daily,
	provider,
) {
	const originalRoll = finiteNumber(adjustment.value, "provider roll");
	const adjustedRoll = originalRoll + adjustment.delta;
	const previousHistory = readLuckHistory(message);
	const event = buildLuckEvent({
		actor,
		daily,
		requester,
		adjustment,
		originalRoll,
		adjustedRoll,
	});
	const nextHistory = [...previousHistory, event];

	/*
	 * Store the audit event before provider re-resolution. Provider state lives
	 * in the same ChatMessage and will immediately cause a second render. If the
	 * provider rejects, restore the previous history so a failed adjustment does
	 * not consume a visible Luck event.
	 */
	await message.update({
		[`flags.${FLAG_SCOPE}.${LUCK_HISTORY_FLAG_KEY}`]: nextHistory,
	});

	try {
		const result = await provider.applyLuck(
			message,
			adjustment.id,
			adjustment.delta,
		);

		if (
			Number(result.originalRoll) !== originalRoll ||
			Number(result.adjustedRoll) !== adjustedRoll
		) {
			throw new Error(
				"Luck provider returned a result inconsistent with the locked roll snapshot.",
			);
		}
		return result;
	} catch (error) {
		try {
			await message.update({
				[`flags.${FLAG_SCOPE}.${LUCK_HISTORY_FLAG_KEY}`]:
					previousHistory,
			});
		} catch (historyRollbackError) {
			console.error(
				"WFRP1ED | Unable to roll back Luck history.",
				historyRollbackError,
			);
		}
		throw error;
	}
}

function buildLuckEvent({
	actor,
	daily,
	requester,
	adjustment,
	originalRoll,
	adjustedRoll,
}) {
	return {
		id: foundry.utils.randomID(),
		version: LUCK_VERSION,
		actorUuid: actor.uuid,
		generation: daily.generation,
		rollId: adjustment.id,
		die: adjustment.die,
		originalRoll,
		delta: adjustment.delta,
		adjustedRoll,
		usedBy: String(requester?.id ?? ""),
		usedAt: Date.now(),
	};
}

/**
 * Roll one hidden daily allowance and publish it to GMs only.
 */
async function initializeAllowance(actor, daily, user) {
	const roll = await new Roll("1d6").evaluate({ allowInteractive: false });
	const allowance = Math.trunc(
		finiteNumber(roll.total, "Luck allowance"),
	);
	if (allowance < 1 || allowance > 6) {
		throw new Error(
			`Luck allowance must be between 1 and 6: ${allowance}`,
		);
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

	try {
		await roll.toMessage(
			{
				speaker: ChatMessage.getSpeaker({ actor }),
				flavor: localize(
					`Hidden daily Luck allowance — ${actor.name}`,
					`Tajny dzienny limit Szczęścia — ${actor.name}`,
				),
				flags: {
					[FLAG_SCOPE]: {
						luckAllowanceRoll: {
							version: LUCK_VERSION,
							actorUuid: actor.uuid,
							generation: next.generation,
						},
					},
				},
			},
			{ messageMode: "gm" },
		);
	} catch (error) {
		console.error(
			"WFRP1ED | Luck pool stored but GM-only roll message failed.",
			error,
		);
		ui.notifications.warn(
			localize(
				`Luck pool for ${actor.name} was stored, but its GM-only roll card could not be created.`,
				`Pula Szczęścia dla ${actor.name} została zapisana, ale nie udało się utworzyć tajnej karty rzutu dla MG.`,
			),
		);
	}

	return foundry.utils.deepClone(next);
}

async function requestLuckUseFromGm(message, adjustment, user) {
	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(
			localize(
				"An active GM is required to use Luck because its daily pool is GM-controlled.",
				"Do użycia Szczęścia potrzebny jest aktywny MG, ponieważ dzienna pula jest kontrolowana przez MG.",
			),
		);
	}

	const requestId = foundry.utils.randomID();
	const promise = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(
				new Error(
					localize(
						"The GM did not answer the Luck request in time.",
						"MG nie odpowiedział na próbę użycia Szczęścia w wyznaczonym czasie.",
					),
				),
			);
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
	});

	game.socket.emit(SOCKET_CHANNEL, {
		type: SOCKET_USE_REQUEST,
		requestId,
		requesterUserId: String(user.id ?? ""),
		messageId: String(message.id ?? ""),
		rollId: adjustment.id,
		delta: adjustment.delta,
	});
	return promise;
}

async function onSocketMessage(payload) {
	if (!payload || typeof payload !== "object") return;

	if (payload.type === SOCKET_USE_RESPONSE) {
		handleSocketResponse(payload);
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
		if (!requester?.active) {
			throw new Error("Luck requester is not active.");
		}
		const message = game.messages?.get(String(payload.messageId ?? ""));
		const actor = actorForMessage(message);
		const adjustment = resolveLuckAdjustment(
			message,
			payload.delta,
			payload.rollId,
		);
		assertAttempt(message, actor, requester, adjustment);
		Object.assign(
			response,
			await performLuckUse(message, actor, requester, adjustment),
		);
	} catch (error) {
		console.error("WFRP1ED | GM Luck request failed.", error);
		response.error = error?.message ?? "Unable to use Luck.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleSocketResponse(payload) {
	if (
		String(payload.recipientUserId ?? "") !==
		String(game.user?.id ?? "")
	) return;

	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;
	clearTimeout(pending.timeout);
	pendingRequests.delete(requestId);

	if (payload.error) {
		pending.reject(new Error(String(payload.error)));
		return;
	}
	pending.resolve(Object.freeze({
		ok: payload.ok === true,
		cancelled: payload.cancelled === true,
		exhausted: payload.exhausted === true,
		rollId: payload.rollId,
		originalRoll: payload.originalRoll,
		adjustedRoll: payload.adjustedRoll,
		delta: payload.delta,
	}));
}

function assertAttempt(message, actor, user, adjustment) {
	if (!(message instanceof foundry.documents.ChatMessage)) {
		throw new Error("Luck requires a completed ChatMessage result.");
	}
	if (!adjustment) {
		throw new Error(
			"This result does not support the requested Luck adjustment.",
		);
	}
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The Actor for this result is not available.");
	}
	if (!hasLuckSkill(actor)) {
		throw new Error(
			localize(
				`${actor.name} does not have the Luck skill.`,
				`${actor.name} nie posiada umiejętności Szczęście.`,
			),
		);
	}
	if (!canManageActor(actor, user)) {
		throw new Error(
			localize(
				"Only the GM or an OWNER of the rolling Actor may use Luck.",
				"Szczęścia może użyć tylko MG albo właściciel postaci wykonującej rzut.",
			),
		);
	}
	if (adjustment.blocksAfterDamage && damageAlreadyApplied(message)) {
		throw new Error(
			localize(
				"Luck cannot change this roll after its damage has been applied.",
				"Nie można zmienić tego rzutu Szczęściem po zastosowaniu wynikających z niego obrażeń.",
			),
		);
	}
}

function canAttemptLuck(message, delta) {
	try {
		const adjustment = resolveLuckAdjustment(message, delta);
		const actor = actorForMessage(message);
		assertAttempt(message, actor, game.user, adjustment);
		return game.user?.isGM === true || Boolean(primaryActiveGm());
	} catch (_error) {
		return false;
	}
}

function resolveLuckAdjustment(message, delta, rollId = null) {
	const number = Number(delta);
	const requestedId = rollId === null || rollId === undefined
		? null
		: String(rollId);
	const matches = luckOptionsForMessage(message).filter(
		(option) =>
			option.delta === number &&
			(requestedId === null || option.id === requestedId),
	);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(
			"More than one roll matches this Luck action; an explicit roll id is required.",
		);
	}
	return null;
}

function luckOptionsForMessage(message) {
	const options = [];
	const testState = testResultState(message);
	if (testState) {
		const value = finiteNumber(testState.roll, "test roll");
		for (const delta of [-10, 10]) {
			options.push(Object.freeze({
				id: TEST_ROLL_ID,
				provider: "test",
				die: "d100",
				delta,
				value,
				blocksAfterDamage: true,
			}));
		}
	}

	for (const option of MovementStandardTest.luckOptions(message)) {
		options.push(Object.freeze({ ...option, provider: "movement" }));
	}
	for (const option of HeldItemsCheck.luckOptions(message)) {
		options.push(Object.freeze({ ...option, provider: "held-items" }));
	}
	return options;
}

/**
 * Read the append-only v4 Luck history plus all earlier flag shapes.
 *
 * v3 used roll ids such as "movement.jump.reduction" as object keys. Foundry
 * expands dotted update paths, so some persisted cards contain nested objects.
 * Recursive extraction repairs their presentation without rewriting history.
 */
function readLuckHistory(message) {
	const entries = [];
	const rawHistory = message?.getFlag?.(
		FLAG_SCOPE,
		LUCK_HISTORY_FLAG_KEY,
	);
	if (Array.isArray(rawHistory)) {
		for (const entry of rawHistory) collectHistoryEntry(entry, entries);
	}

	const legacyMap = message?.getFlag?.(
		FLAG_SCOPE,
		LUCK_RESULTS_FLAG_KEY,
	);
	collectLegacyTree(legacyMap, entries);

	const legacySingle = message?.getFlag?.(
		FLAG_SCOPE,
		LUCK_RESULT_FLAG_KEY,
	);
	if (legacySingle && typeof legacySingle === "object") {
		const fallbackRollId = inferLegacyRollId(message, legacySingle);
		collectHistoryEntry(legacySingle, entries, fallbackRollId);
	}

	const unique = new Map();
	for (const entry of entries) {
		const key = entry.id || [
			entry.rollId,
			entry.usedAt,
			entry.originalRoll,
			entry.adjustedRoll,
			entry.delta,
		].join("|");
		if (!unique.has(key)) unique.set(key, entry);
	}
	return [...unique.values()].sort(
		(first, second) => Number(first.usedAt) - Number(second.usedAt),
	);
}

function collectLegacyTree(value, entries) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	if (looksLikeLuckEvent(value)) {
		collectHistoryEntry(value, entries);
		return;
	}
	for (const child of Object.values(value)) {
		collectLegacyTree(child, entries);
	}
}

function collectHistoryEntry(raw, entries, fallbackRollId = null) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const originalRoll = Number(raw.originalRoll);
	const adjustedRoll = Number(raw.adjustedRoll);
	const delta = Number(raw.delta);
	const usedAt = Number(raw.usedAt);
	if (
		!Number.isFinite(originalRoll) ||
		!Number.isFinite(adjustedRoll) ||
		!Number.isFinite(delta) ||
		!Number.isFinite(usedAt) || usedAt <= 0
	) return;

	entries.push({
		id: String(raw.id ?? ""),
		version: Number(raw.version ?? 0),
		actorUuid: String(raw.actorUuid ?? ""),
		generation: nonNegativeInteger(raw.generation),
		rollId: String(raw.rollId ?? fallbackRollId ?? ""),
		die: String(raw.die ?? ""),
		originalRoll,
		delta,
		adjustedRoll,
		usedBy: String(raw.usedBy ?? ""),
		usedAt,
	});
}

function looksLikeLuckEvent(value) {
	return Object.prototype.hasOwnProperty.call(value, "originalRoll") &&
		Object.prototype.hasOwnProperty.call(value, "adjustedRoll") &&
		Object.prototype.hasOwnProperty.call(value, "delta");
}

function inferLegacyRollId(message, legacy) {
	if (testResultState(message)) return TEST_ROLL_ID;
	if (HeldItemsCheck.stateFor(message)) return HELD_ITEMS_LUCK_ROLL_ID;
	const state = MovementStandardTest.stateFor(message);
	if (state?.kind === "jump") return "movement.jump.reduction";
	if (state?.kind === "leap") return "movement.leap.distance";
	return String(legacy?.rollId ?? "").trim() || null;
}

function isWfrpResultMessage(message) {
	return Boolean(
		testResultState(message) ||
		MovementStandardTest.stateFor(message) ||
		HeldItemsCheck.stateFor(message) ||
		message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY),
	);
}

function actorForMessage(message) {
	const heldState = HeldItemsCheck.stateFor(message);
	const movementState = MovementStandardTest.stateFor(message);
	const explicitUuid = heldState?.actorUuid ?? movementState?.actorUuid ?? null;
	if (explicitUuid) {
		try {
			const actor = foundry.utils.fromUuidSync(String(explicitUuid));
			if (actor instanceof foundry.documents.Actor) return actor;
		} catch (_error) {
			// Fall through to speaker resolution.
		}
	}

	const speaker = message?.speaker ?? {};
	const scene = game.scenes?.get?.(String(speaker.scene ?? ""));
	const token = scene?.tokens?.get?.(String(speaker.token ?? ""));
	if (token?.actor instanceof foundry.documents.Actor) return token.actor;
	const worldActor = game.actors?.get?.(String(speaker.actor ?? ""));
	return worldActor instanceof foundry.documents.Actor ? worldActor : null;
}

function collectLuckActors() {
	const unique = new Map();
	const add = (actor) => {
		if (!(actor instanceof foundry.documents.Actor) || !hasLuckSkill(actor)) {
			return;
		}
		unique.set(actor.uuid, actor);
	};

	for (const actor of game.actors ?? []) add(actor);
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) add(token.actor);
	}

	const players = [];
	const npcs = [];
	for (const actor of unique.values()) {
		(hasExplicitPlayerOwner(actor) ? players : npcs).push(actor);
	}
	players.sort(actorNameSort);
	npcs.sort(actorNameSort);
	return { players, npcs };
}

function hasExplicitPlayerOwner(actor) {
	for (const user of game.users ?? []) {
		if (!user || user.isGM) continue;
		const level = Number(actor.ownership?.[user.id] ?? 0);
		if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return true;
	}
	return false;
}

function actorNameSort(first, second) {
	return String(first?.name ?? "").localeCompare(
		String(second?.name ?? ""),
		game.i18n.lang,
		{ sensitivity: "base" },
	);
}

function hasLuckSkill(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return [...(actor.items ?? [])].some(
		(item) =>
			item?.type === "skill" &&
			String(item.system?.rulesId ?? "").trim() === LUCK_RULES_ID,
	);
}

function canManageActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	);
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
	const generation = positiveInteger(raw?.generation, 0);
	const initialized = raw?.initialized === true;
	const allowance = initialized ? allowanceValue(raw?.allowance) : null;
	const used = initialized
		? Math.min(allowance, nonNegativeInteger(raw?.used))
		: 0;
	return {
		version: LUCK_VERSION,
		generation,
		initialized,
		allowance,
		used,
		exhausted: initialized &&
			(raw?.exhausted === true || used >= allowance),
		group: String(raw?.group ?? ""),
		resetBy: String(raw?.resetBy ?? ""),
		resetAt: timestampOrNull(raw?.resetAt),
		rolledBy: String(raw?.rolledBy ?? ""),
		rolledAt: timestampOrNull(raw?.rolledAt),
		lastUsedBy: String(raw?.lastUsedBy ?? ""),
		lastUsedAt: timestampOrNull(raw?.lastUsedAt),
	};
}

async function persistLuckDaily(actor, state) {
	if (!game.user?.isGM) {
		throw new Error("Only a GM may persist the hidden Luck allowance.");
	}
	await actor.update({
		[`flags.${FLAG_SCOPE}.${LUCK_DAILY_FLAG_KEY}`]:
			foundry.utils.deepClone(state),
	});
}

function showLuckStatus(actor, state = readLuckDaily(actor)) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) return;
	if (!state.initialized) {
		ui.notifications.info(
			localize(
				`Luck — ${actor.name}: no daily pool has been generated yet.`,
				`Szczęście — ${actor.name}: dzienna pula nie została jeszcze wygenerowana.`,
			),
		);
		return;
	}
	const remaining = Math.max(0, state.allowance - state.used);
	ui.notifications.info(
		localize(
			`Luck — ${actor.name}: used ${state.used}/${state.allowance}, remaining ${remaining}.`,
			`Szczęście — ${actor.name}: wykorzystano ${state.used}/${state.allowance}, pozostało ${remaining}.`,
		),
	);
}

function reportUseResult(actor, result, user) {
	if (!result) return;
	if (result.exhausted) {
		ui.notifications.warn(
			localize("Luck has deserted you.", "Szczęście cię opuściło."),
		);
		return;
	}
	if (!result.ok) return;
	ui.notifications.info(
		localize(
			`Luck changed the roll: ${result.originalRoll} → ${result.adjustedRoll}.`,
			`Szczęście zmieniło wynik rzutu: ${result.originalRoll} → ${result.adjustedRoll}.`,
		),
	);
	if (user?.isGM) showLuckStatus(actor);
}

function applyLuckResultPresentation(message, html) {
	const entries = readLuckHistory(message);
	if (entries.length === 0) return;

	const root = asElement(html);
	if (!root) return;
	const card = root.matches?.(".wfrp1e-test-card")
		? root
		: root.matches?.("[data-wfrp-held-items-card]")
			? root
			: root.querySelector?.(
				".wfrp1e-test-card, [data-wfrp-held-items-card]",
			);
	if (!card) return;

	card.querySelector?.("[data-wfrp-luck-result]")?.remove();
	const panel = document.createElement("div");
	panel.className = "wfrp1e-luck-result";
	panel.dataset.wfrpLuckResult = "";

	for (const result of entries) {
		const row = document.createElement("div");
		row.className = "wfrp1e-luck-result__row";
		const label = document.createElement("strong");
		label.textContent =
			`${localize("Luck", "Szczęście")} — ${luckResultLabel(result)}`;
		const history = document.createElement("span");
		history.textContent =
			`${result.originalRoll} → ${result.adjustedRoll} (${signed(result.delta)})`;
		row.append(label, history);
		panel.append(row);
	}
	card.append(panel);
}

function luckResultLabel(result) {
	switch (String(result?.rollId ?? "")) {
		case TEST_ROLL_ID:
			return localize("test roll", "rzut testu");
		case "movement.jump.reduction":
			return localize("Jump d6", "K6 Zeskoku");
		case HELD_ITEMS_LUCK_ROLL_ID:
			return localize(
				"held-items d100",
				"K100 utrzymania przedmiotów",
			);
		case "movement.leap.distance":
			return localize("Leap dice", "kości Skoku");
		default:
			return String(result?.die || "roll");
	}
}

function resetCheckbox(name, labelText, checked) {
	const label = document.createElement("label");
	label.className = "wfrp1e-luck-reset-dialog__option";
	label.style.display = "flex";
	label.style.alignItems = "center";
	label.style.gap = "0.5rem";
	label.style.margin = "0.45rem 0";
	const input = document.createElement("input");
	input.type = "checkbox";
	input.name = name;
	input.checked = checked;
	const text = document.createElement("span");
	text.textContent = labelText;
	label.append(input, text);
	return label;
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

function allowanceValue(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6 ? number : 1;
}

function positiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : fallback;
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
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function isPrimaryActiveGm() {
	const primary = primaryActiveGm();
	return Boolean(primary && primary.id === game.user?.id);
}

function withActorLock(actorUuid, callback) {
	const key = String(actorUuid ?? "");
	const previous = actorLocks.get(key) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(callback);
	actorLocks.set(key, next);
	void next.finally(() => {
		if (actorLocks.get(key) === next) actorLocks.delete(key);
	});
	return next;
}

function assertGm(user) {
	if (!user?.isGM) throw new Error("Only a GM may reset daily Luck pools.");
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Luck operation failed.", error);
	ui.notifications.error(
		error?.message ?? localize("Unable to use Luck.", "Nie można użyć Szczęścia."),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
