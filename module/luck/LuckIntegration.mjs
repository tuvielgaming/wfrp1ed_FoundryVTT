import { DamageApplication } from "../damage/DamageApplication.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TEST_RESULT_FLAG_KEY = "testResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const LUCK_RESULT_FLAG_KEY = "luckResult";
const LUCK_DAILY_FLAG_KEY = "luckDaily";
const LUCK_RULES_ID = "luck";
const LUCK_VERSION = 2;

const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_USE_REQUEST = "luck-v3-use-request";
const SOCKET_USE_RESPONSE = "luck-v3-use-response";
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
		}),
	});
});

function addLuckContextOptions(menuItems) {
	if (!Array.isArray(menuItems)) {
		return;
	}

	menuItems.push(
		{
			label: localize(
				"Luck: change roll by -10",
				"Szczęście: zmień wynik o -10",
			),
			icon: "fa-solid fa-clover",
			visible: (target) =>
				canAttemptLuck(messageFromContextTarget(target), -10),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, -10);
			},
		},
		{
			label: localize(
				"Luck: change roll by +10",
				"Szczęście: zmień wynik o +10",
			),
			icon: "fa-solid fa-clover",
			visible: (target) =>
				canAttemptLuck(messageFromContextTarget(target), 10),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, 10);
			},
		},
		{
			label: localize(
				"Luck: change d6 by +1",
				"Szczęście: zmień K6 o +1",
			),
			icon: "fa-solid fa-clover",
			visible: (target) =>
				canAttemptLuck(messageFromContextTarget(target), 1),
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void useLuckOnMessage(message, 1);
			},
		},
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

/**
 * Use one point from the already-generated daily Luck pool.
 *
 * The pool is no longer rolled on first use. Daily initialization belongs to
 * the GM-wide reset action, so normal play never interrupts a player's roll
 * with an extra GM confirmation dialog.
 */
export async function useLuckOnMessage(message, delta, user = game.user) {
	try {
		const adjustment = resolveLuckAdjustment(message, delta);
		const actor = actorForMessage(message);
		assertAttempt(message, actor, user, adjustment);

		const result = user?.isGM
			? await performLuckUse(message, actor, user, adjustment)
			: await requestLuckUseFromGm(message, adjustment.delta, user);

		reportUseResult(actor, result, user);
		return result;
	} catch (error) {
		reportError(error);
		return null;
	}
}

/**
 * GM-facing global new-day workflow.
 *
 * Players are selected by default. NPC/Monster actors are a separate opt-in
 * path because Luck on non-player Actors is expected to be uncommon.
 */
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

	if (!selection || typeof selection !== "object") {
		return null;
	}

	return resetDailyLuckPools(selection, game.user, groups);
}

/**
 * Reset selected daily pools and immediately generate the secret allowance.
 */
export async function resetDailyLuckPools(
	{ players = true, npcs = false } = {},
	user = game.user,
	precollectedGroups = null,
) {
	assertGm(user);

	if (!players && !npcs) {
		ui.notifications.warn(localize(
			"No Luck group was selected.",
			"Nie wybrano żadnej grupy Szczęścia.",
		));
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

	ui.notifications.info(localize(
		`Daily Luck pools reset: ${total}. Failed: ${failed}.`,
		`Zresetowano dzienne pule Szczęścia: ${total}. Błędy: ${failed}.`,
	));

	return Object.freeze({
		players: playerResult.success,
		npcs: npcResult.success,
		failed,
	});
}

/** Separate execution path for player-owned Actors. */
export async function resetPlayerLuckPools(
	actors = collectLuckActors().players,
	user = game.user,
) {
	assertGm(user);
	return resetActorGroup(actors, user, "player");
}

/** Separate execution path for NPC/Monster Actors. */
export async function resetNpcLuckPools(
	actors = collectLuckActors().npcs,
	user = game.user,
) {
	assertGm(user);
	return resetActorGroup(actors, user, "npc");
}

export function luckStatus(actor) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) {
		return null;
	}
	return readLuckDaily(actor);
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
		if (!hasLuckSkill(actor)) {
			return null;
		}

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

async function performLuckUse(message, actor, requester, adjustment) {
	return withActorLock(actor.uuid, async () => {
		assertAttempt(message, actor, requester, adjustment);
		const daily = readLuckDaily(actor);

		if (!daily.initialized) {
			throw new Error(localize(
				"The GM has not generated today's Luck pool yet. Ask the GM to use 'Reset Daily Luck Pools'.",
				"MG nie wygenerował jeszcze dzisiejszej puli Szczęścia. MG musi użyć „Reset dziennych pul Szczęścia”.",
			));
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
			const result = adjustment.kind === "d100"
				? await applyLuckToD100(
					message,
					actor,
					requester,
					adjustment,
					daily,
				)
				: await applyLuckToMovement(
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

async function applyLuckToD100(
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

	const luckResult = buildLuckResult({
		actor,
		daily,
		requester,
		kind: adjustment.kind,
		originalRoll,
		adjustedRoll,
		delta: adjustment.delta,
	});
	const content = await TestResultChat._render(updated);

	await message.update({
		content,
		[`flags.${FLAG_SCOPE}.${TEST_RESULT_FLAG_KEY}`]: updated,
		[`flags.${FLAG_SCOPE}.${LUCK_RESULT_FLAG_KEY}`]: luckResult,
	});

	return {
		originalRoll,
		adjustedRoll,
		delta: adjustment.delta,
	};
}

async function applyLuckToMovement(
	message,
	actor,
	requester,
	adjustment,
	daily,
) {
	const state = MovementStandardTest.stateFor(message);
	const originalRoll = finiteNumber(state?.die, "movement d6 roll");
	const adjustedRoll = originalRoll + adjustment.delta;
	const luckResult = buildLuckResult({
		actor,
		daily,
		requester,
		kind: adjustment.kind,
		originalRoll,
		adjustedRoll,
		delta: adjustment.delta,
	});

	/*
	 * Polish note: ustawiamy ślad użycia Szczęścia przed rekalkulacją ruchu.
	 * Jeśli rekalkulacja się nie powiedzie, flaga jest cofana razem z dziennym
	 * zużyciem. Dzięki temu ten sam rzut nie może zużyć Szczęścia dwa razy.
	 */
	await message.setFlag(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY, luckResult);

	try {
		return await MovementStandardTest.applyLuck(
			message,
			adjustment.delta,
		);
	} catch (error) {
		try {
			await message.unsetFlag(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY);
		} catch (flagRollbackError) {
			console.error(
				"WFRP1ED | Unable to roll back movement Luck flag.",
				flagRollbackError,
			);
		}
		throw error;
	}
}

function buildLuckResult({
	actor,
	daily,
	requester,
	kind,
	originalRoll,
	adjustedRoll,
	delta,
}) {
	return {
		version: LUCK_VERSION,
		actorUuid: actor.uuid,
		generation: daily.generation,
		kind,
		originalRoll,
		delta,
		adjustedRoll,
		usedBy: String(requester?.id ?? ""),
		usedAt: Date.now(),
	};
}

/**
 * Roll one allowance and publish it in GM roll mode.
 *
 * `messageMode: "gm"` is used instead of manually constructing whisper IDs so
 * Foundry owns visibility semantics for the roll message.
 */
async function initializeAllowance(actor, daily, user) {
	const roll = await new Roll("1d6").evaluate({
		allowInteractive: false,
	});
	const allowance = Math.trunc(
		finiteNumber(roll.total, "Luck allowance"),
	);

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
		ui.notifications.warn(localize(
			`Luck pool for ${actor.name} was stored, but its GM-only roll card could not be created.`,
			`Pula Szczęścia dla ${actor.name} została zapisana, ale nie udało się utworzyć tajnej karty rzutu dla MG.`,
		));
	}

	return foundry.utils.deepClone(next);
}

async function requestLuckUseFromGm(message, delta, user) {
	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(localize(
			"An active GM is required to use Luck because its daily pool is GM-controlled.",
			"Do użycia Szczęścia potrzebny jest aktywny MG, ponieważ dzienna pula jest kontrolowana przez MG.",
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

		pendingRequests.set(requestId, {
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
	if (!payload || typeof payload !== "object") {
		return;
	}

	if (payload.type === SOCKET_USE_RESPONSE) {
		handleSocketResponse(payload);
		return;
	}

	if (payload.type !== SOCKET_USE_REQUEST || !isPrimaryActiveGm()) {
		return;
	}

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

		const message = game.messages?.get(
			String(payload.messageId ?? ""),
		);
		const actor = actorForMessage(message);
		const adjustment = resolveLuckAdjustment(
			message,
			payload.delta,
		);
		assertAttempt(message, actor, requester, adjustment);

		const result = await performLuckUse(
			message,
			actor,
			requester,
			adjustment,
		);
		Object.assign(response, result);
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
	) {
		return;
	}

	const requestId = String(payload.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) {
		return;
	}

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
		originalRoll: payload.originalRoll,
		adjustedRoll: payload.adjustedRoll,
		delta: payload.delta,
	}));
}

function assertAttempt(message, actor, user, adjustment) {
	if (!(message instanceof foundry.documents.ChatMessage)) {
		throw new Error(
			"Luck requires a completed ChatMessage result.",
		);
	}

	if (!adjustment) {
		throw new Error(
			"This result does not support the requested Luck adjustment.",
		);
	}

	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(
			"The Actor for this result is not available.",
		);
	}

	if (!hasLuckSkill(actor)) {
		throw new Error(localize(
			`${actor.name} does not have the Luck skill.`,
			`${actor.name} nie posiada umiejętności Szczęście.`,
		));
	}

	if (!canManageActor(actor, user)) {
		throw new Error(localize(
			"Only the GM or an OWNER of the rolling Actor may use Luck.",
			"Szczęścia może użyć tylko MG albo właściciel postaci wykonującej rzut.",
		));
	}

	if (message.getFlag?.(FLAG_SCOPE, LUCK_RESULT_FLAG_KEY)) {
		throw new Error(localize(
			"Luck has already modified this roll.",
			"Szczęście zostało już użyte do tego rzutu.",
		));
	}

	if (damageAlreadyApplied(message)) {
		throw new Error(localize(
			"Luck cannot change this roll after its damage has been applied.",
			"Nie można zmienić tego rzutu Szczęściem po zastosowaniu wynikających z niego obrażeń.",
		));
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

function resolveLuckAdjustment(message, delta) {
	const number = Number(delta);

	if (testResultState(message)) {
		if (number !== -10 && number !== 10) {
			return null;
		}
		return Object.freeze({ kind: "d100", delta: number });
	}

	if (MovementStandardTest.canApplyLuck(message, number)) {
		return Object.freeze({ kind: "d6", delta: number });
	}

	return null;
}

function isWfrpResultMessage(message) {
	return Boolean(
		testResultState(message) ||
		MovementStandardTest.stateFor(message) ||
		message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY),
	);
}

function actorForMessage(message) {
	const speaker = message?.speaker ?? {};

	// Token first: an unlinked synthetic Actor may own a different Skill list
	// than its world prototype. The roll belongs to the token that made it.
	const scene = game.scenes?.get?.(String(speaker.scene ?? ""));
	const token = scene?.tokens?.get?.(String(speaker.token ?? ""));
	if (token?.actor instanceof foundry.documents.Actor) {
		return token.actor;
	}

	const worldActor = game.actors?.get?.(String(speaker.actor ?? ""));
	return worldActor instanceof foundry.documents.Actor
		? worldActor
		: null;
}

function collectLuckActors() {
	const unique = new Map();

	const add = (actor) => {
		if (!(actor instanceof foundry.documents.Actor)) return;
		if (!hasLuckSkill(actor)) return;
		unique.set(actor.uuid, actor);
	};

	for (const actor of game.actors ?? []) {
		add(actor);
	}

	/*
	 * Polish note: osobno zbieramy syntetycznych Actorów niepołączonych tokenów.
	 * NPC może mieć Szczęście tylko na konkretnym tokenie, więc sam world Actor
	 * nie jest wystarczającym źródłem do dziennego resetu.
	 */
	for (const scene of game.scenes ?? []) {
		for (const token of scene.tokens ?? []) {
			add(token.actor);
		}
	}

	const players = [];
	const npcs = [];

	for (const actor of unique.values()) {
		if (hasExplicitPlayerOwner(actor)) players.push(actor);
		else npcs.push(actor);
	}

	players.sort(actorNameSort);
	npcs.sort(actorNameSort);

	return { players, npcs };
}

function hasExplicitPlayerOwner(actor) {
	for (const user of game.users ?? []) {
		if (!user || user.isGM) continue;

		const level = Number(actor.ownership?.[user.id] ?? 0);
		if (level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
			return true;
		}
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
	if (!(actor instanceof foundry.documents.Actor)) {
		return false;
	}

	return [...(actor.items ?? [])].some((item) =>
		item?.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === LUCK_RULES_ID,
	);
}

function canManageActor(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) {
		return false;
	}
	if (user.isGM) {
		return true;
	}
	return actor.testUserPermission(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	);
}

function testResultState(message) {
	const state = message?.getFlag?.(
		FLAG_SCOPE,
		TEST_RESULT_FLAG_KEY,
	);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function damageAlreadyApplied(message) {
	const state = message?.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_STATE_FLAG_KEY,
	);
	if (!state || typeof state !== "object") {
		return false;
	}

	if (state.application?.state === "applied") {
		return true;
	}

	const packetId = String(state.packet?.id ?? "").trim();
	const targetActorUuid = String(
		state.packet?.targetActorUuid ?? "",
	).trim();
	if (!packetId || !targetActorUuid) {
		return false;
	}

	try {
		const actor = foundry.utils.fromUuidSync(targetActorUuid);
		return actor instanceof foundry.documents.Actor &&
			DamageApplication.isApplied(actor, packetId);
	} catch (_error) {
		return false;
	}
}

function readLuckDaily(actor) {
	const raw = actor?.getFlag?.(
		FLAG_SCOPE,
		LUCK_DAILY_FLAG_KEY,
	);
	const generation = positiveInteger(raw?.generation, 0);
	const initialized = raw?.initialized === true;
	const allowance = initialized
		? allowanceValue(raw?.allowance)
		: null;
	const used = initialized
		? Math.min(
			allowance,
			nonNegativeInteger(raw?.used),
		)
		: 0;

	return {
		version: LUCK_VERSION,
		generation,
		initialized,
		allowance,
		used,
		exhausted:
			initialized &&
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
		throw new Error(
			"Only a GM may persist the hidden Luck allowance.",
		);
	}

	await actor.update({
		[`flags.${FLAG_SCOPE}.${LUCK_DAILY_FLAG_KEY}`]:
			foundry.utils.deepClone(state),
	});
}

function showLuckStatus(actor, state = readLuckDaily(actor)) {
	if (!game.user?.isGM || !hasLuckSkill(actor)) {
		return;
	}

	if (!state.initialized) {
		ui.notifications.info(localize(
			`Luck — ${actor.name}: no daily pool has been generated yet.`,
			`Szczęście — ${actor.name}: dzienna pula nie została jeszcze wygenerowana.`,
		));
		return;
	}

	const remaining = Math.max(0, state.allowance - state.used);
	ui.notifications.info(localize(
		`Luck — ${actor.name}: used ${state.used}/${state.allowance}, remaining ${remaining}.`,
		`Szczęście — ${actor.name}: wykorzystano ${state.used}/${state.allowance}, pozostało ${remaining}.`,
	));
}

function reportUseResult(actor, result, user) {
	if (!result) return;

	if (result.exhausted) {
		ui.notifications.warn(localize(
			"Luck has deserted you.",
			"Szczęście cię opuściło.",
		));
		return;
	}

	if (!result.ok) return;

	ui.notifications.info(localize(
		`Luck changed the roll: ${result.originalRoll} → ${result.adjustedRoll}.`,
		`Szczęście zmieniło wynik rzutu: ${result.originalRoll} → ${result.adjustedRoll}.`,
	));

	if (user?.isGM) {
		showLuckStatus(actor);
	}
}

function applyLuckResultPresentation(message, html) {
	const result = message?.getFlag?.(
		FLAG_SCOPE,
		LUCK_RESULT_FLAG_KEY,
	);
	if (!result || typeof result !== "object") {
		return;
	}

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
	label.textContent = localize("Luck", "Szczęście");
	panel.append(label);

	const history = document.createElement("span");
	history.textContent =
		`${result.originalRoll} → ${result.adjustedRoll} ` +
		`(${signed(result.delta)})`;
	panel.append(history);

	card.append(panel);
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
	label.append(input);

	const text = document.createElement("span");
	text.textContent = labelText;
	label.append(text);
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

	return messageId
		? game.messages?.get(messageId) ?? null
		: null;
}

function allowanceValue(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6
		? number
		: 1;
}

function positiveInteger(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0
		? number
		: fallback;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0
		? number
		: 0;
}

function timestampOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0
		? number
		: null;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(
			`${label} must be finite: ${String(value)}`,
		);
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
	const next = previous
		.catch(() => undefined)
		.then(callback);

	actorLocks.set(key, next);
	void next.finally(() => {
		if (actorLocks.get(key) === next) {
			actorLocks.delete(key);
		}
	});
	return next;
}

function assertGm(user) {
	if (!user?.isGM) {
		throw new Error(
			"Only a GM may reset daily Luck pools.",
		);
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Luck operation failed.", error);
	ui.notifications.error(
		error?.message ??
			localize("Unable to use Luck.", "Nie można użyć Szczęścia."),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
