import {
	PARRY_ATTACK_COST_MODE,
	normalizeParryAttackCostMode,
} from "./CombatParryRules.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "attackEconomy";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-attack-economy-request";
const SOCKET_RESPONSE_TYPE = "combat-attack-economy-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingSocketRequests = new Map();

Hooks.once("ready", () => {
	registerSocket();
});

/**
 * WFRP 1e Attacks-resource state owned by Combatants.
 *
 * The Actor characteristic `A / Attacks` is the permanent allowance. Runtime
 * spending belongs to the Combatant so multiple tokens of the same Actor can
 * maintain independent combat state.
 *
 * Core p.118: an ordinary parry loses the character's next attack whether the
 * parry succeeds or fails. Core p.126 explicitly allows a parry even after the
 * character has already taken their individual turn, so an attack loss which
 * cannot be paid immediately must carry forward as parry debt. A shield parry
 * loses all following attacks; when no attacks remain in the current attack
 * window, that penalty therefore suppresses the next attack window through the
 * same debt mechanism.
 *
 * `parriesThisRound` is independent of attack availability. The Core limit is
 * at most A parry attempts in one round, even when all current attacks have
 * already been used.
 */
export class CombatAttackEconomy {
	/**
	 * Return the current Attacks allowance derived from the Combatant Actor.
	 *
	 * @param {Combatant} combatant
	 * @returns {number}
	 */
	static allowance(combatant) {
		const characteristic = combatant?.actor?.system?.characteristics?.a;
		const candidates = [
			characteristic?.current,
			characteristic?.value,
			characteristic,
		];

		for (const candidate of candidates) {
			const numeric = Number(candidate);
			if (!Number.isFinite(numeric)) continue;
			return Math.max(0, Math.trunc(numeric));
		}

		return 0;
	}

	/**
	 * Return an immutable, presentation-safe snapshot of one Combatant state.
	 *
	 * `remaining` means attacks available in the current attack window, or - if
	 * the Combatant's turn has not yet started - the attacks projected to remain
	 * when that turn starts after already accumulated parry debt is paid.
	 *
	 * A completed turn has `remaining = 0`, but the Combatant may still parry if
	 * the per-round parry-attempt limit permits it. Such parries create debt for
	 * a future attack window.
	 *
	 * @param {Combatant} combatant
	 * @returns {Object}
	 */
	static snapshot(combatant) {
		assertCombatant(combatant);

		const combat = combatant.parent;
		const allowance = this.allowance(combatant);
		const state = normalizeState(
			combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
			combat?.round ?? 0,
		);
		const attackWindowOpen = Boolean(
			combat?.started &&
			combat.combatant?.id === combatant.id &&
			state.turnStarted &&
			!state.turnCompleted,
		);
		const currentAttackRemaining = state.turnStarted && !state.turnCompleted
			? Math.max(0, allowance - state.spent)
			: 0;
		const projectedNextTurnAttacks = Math.max(
			0,
			allowance - Math.min(allowance, state.parryDebt),
		);

		let remaining;
		if (state.turnCompleted) {
			remaining = 0;
		} else if (state.turnStarted) {
			remaining = currentAttackRemaining;
		} else {
			remaining = projectedNextTurnAttacks;
		}

		const parryAttemptsRemaining = Math.max(
			0,
			allowance - state.parriesThisRound,
		);
		const combatStarted = Boolean(
			combat?.started && nonNegativeInteger(combat?.round) > 0,
		);

		return Object.freeze({
			combatId: String(combat?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			round: state.round,
			allowance,
			spent: state.spent,
			remaining,
			currentAttackRemaining,
			projectedNextTurnAttacks,
			parryDebt: state.parryDebt,
			parriesThisRound: state.parriesThisRound,
			parryAttemptsRemaining,
			turnStarted: state.turnStarted,
			turnCompleted: state.turnCompleted,
			attackWindowOpen,
			canAttack: attackWindowOpen && currentAttackRemaining > 0,
			canParry: combatStarted && parryAttemptsRemaining > 0,
		});
	}

	/**
	 * Preview the attack-resource consequences of one parry without mutating the
	 * Combatant. The future defence UI uses this for tactical weapon/shield choice
	 * presentation, while the authoritative commit recalculates the same plan.
	 *
	 * @param {Combatant} combatant
	 * @param {Object} [options]
	 * @param {string} [options.costMode]
	 * @returns {Object}
	 */
	static previewParry(
		combatant,
		{
			costMode = PARRY_ATTACK_COST_MODE.ONE_ATTACK,
		} = {},
	) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat);

		assertParryAttemptAvailable(state, allowance);

		const normalizedCostMode = normalizeParryAttackCostMode(costMode);
		const plan = planParry(state, allowance, normalizedCostMode);
		const before = this.snapshot(combatant);
		const remainingAfter = projectedRemainingForState(
			plan.nextState,
			allowance,
		);
		const projectedNextTurnAttacksAfter = Math.max(
			0,
			allowance - Math.min(allowance, plan.nextState.parryDebt),
		);

		return Object.freeze({
			parryCostMode: normalizedCostMode,
			parryAttackCost: plan.immediateAttackCost + plan.parryDebtAdded,
			parryImmediateAttackCost: plan.immediateAttackCost,
			parryDebtAdded: plan.parryDebtAdded,
			parryDebtBefore: state.parryDebt,
			parryDebtAfter: plan.nextState.parryDebt,
			remainingAttacksBefore: before.remaining,
			remainingAttacksAfter: remainingAfter,
			projectedNextTurnAttacksBefore: before.projectedNextTurnAttacks,
			projectedNextTurnAttacksAfter,
		});
	}

	/**
	 * Begin a new Combat round for every Combatant.
	 *
	 * The per-round parry-attempt counter and current-turn spending reset. Parry
	 * debt survives into the new round because Core p.126 allows a late parry to
	 * cost an attack from the defender's next attack opportunity. Rewinding to an
	 * earlier round clears future debt rather than leaking state backward in time.
	 *
	 * @param {Combat} combat
	 * @returns {Promise<void>}
	 */
	static async startRound(combat) {
		assertCombat(combat);

		const round = nonNegativeInteger(combat.round);
		const updates = [];

		for (const combatant of combat.combatants) {
			const previous = normalizeState(
				combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
				round,
			);
			const parryDebt = previous.round > round
				? 0
				: previous.parryDebt;

			updates.push({
				_id: combatant.id,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: {
					round,
					spent: 0,
					parryDebt,
					parriesThisRound: 0,
					turnStarted: false,
					turnCompleted: false,
				},
			});
		}

		if (updates.length) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}

	/**
	 * Initialize one Combatant which enters an encounter that is already running.
	 *
	 * @param {Combatant} combatant
	 * @returns {Promise<void>}
	 */
	static async initializeCombatant(combatant) {
		assertCombatant(combatant);
		const combat = combatant.parent;
		if (!combat?.started || nonNegativeInteger(combat.round) <= 0) return;

		await writeState(combatant, {
			round: nonNegativeInteger(combat.round),
			spent: 0,
			parryDebt: 0,
			parriesThisRound: 0,
			turnStarted: false,
			turnCompleted: false,
		});
	}

	/**
	 * Start one Combatant turn and pay as much accumulated parry debt as the
	 * current Attacks allowance permits.
	 *
	 * Debt can exceed A when an ordinary parry follows a shield parry whose
	 * penalty already suppresses the whole next attack window. In that case the
	 * excess correctly carries into a later attack opportunity.
	 *
	 * @param {Combatant} combatant
	 * @returns {Promise<Object>}
	 */
	static async startTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat);
		const paidDebt = Math.min(allowance, state.parryDebt);

		await writeState(combatant, {
			...state,
			spent: paidDebt,
			parryDebt: Math.max(0, state.parryDebt - paidDebt),
			turnStarted: true,
			turnCompleted: false,
		});

		return this.snapshot(combatant);
	}

	/**
	 * Mark a Combatant turn as completed.
	 *
	 * Later parries remain legal up to the per-round A limit. Their attack losses
	 * cannot alter the already-finished attack window and therefore become debt.
	 *
	 * @param {Combatant} combatant
	 * @returns {Promise<Object>}
	 */
	static async endTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const state = stateForCurrentRound(combatant, combat);

		await writeState(combatant, {
			...state,
			turnStarted: true,
			turnCompleted: true,
		});

		return this.snapshot(combatant);
	}

	/**
	 * Spend one or more attacks from the active Combatant's current turn.
	 *
	 * Owners may request this action; the persistent Combatant update is executed
	 * by a GM when the caller is not a GM.
	 *
	 * @param {Combatant} combatant
	 * @param {number} [count=1]
	 * @returns {Promise<Object>}
	 */
	static async spendAttack(combatant, count = 1) {
		return requestAuthorizedAction(
			"attack",
			combatant,
			{
				count: positiveInteger(count),
			},
		);
	}

	/**
	 * Spend the Attacks resource required by one parry attempt.
	 *
	 * Ordinary weapon parry: lose the next Attack, immediately when possible or
	 * as debt when the attack cannot be paid now.
	 * Shield parry: lose all following Attacks. If no attack window remains, the
	 * next attack window is suppressed through debt.
	 *
	 * @param {Combatant} combatant
	 * @param {Object} [options]
	 * @param {string} [options.costMode]
	 * @returns {Promise<Object>}
	 */
	static async spendParry(
		combatant,
		{
			costMode = PARRY_ATTACK_COST_MODE.ONE_ATTACK,
		} = {},
	) {
		return requestAuthorizedAction(
			"parry",
			combatant,
			{
				count: 1,
				costMode: normalizeParryAttackCostMode(costMode),
			},
		);
	}

	/**
	 * GM-authoritative mutation used by direct GM calls and socket requests.
	 *
	 * @param {string} action
	 * @param {Combatant} combatant
	 * @param {Object} actionData
	 * @param {User} requestingUser
	 * @returns {Promise<Object>}
	 * @internal
	 */
	static async commit(action, combatant, actionData, requestingUser) {
		assertCombatant(combatant);
		assertCanControlCombatant(combatant, requestingUser);

		if (!game.user?.isGM) {
			throw new Error(
				"Combat attack-economy mutations require GM authority.",
			);
		}

		if (action === "attack") {
			return this.#commitAttack(
				combatant,
				positiveInteger(actionData?.count),
			);
		}

		if (action === "parry") {
			return this.#commitParry(
				combatant,
				normalizeParryAttackCostMode(actionData?.costMode),
			);
		}

		throw new Error(`Unknown combat attack-economy action '${action}'.`);
	}

	static async #commitAttack(combatant, count) {
		const combat = assertStartedCombat(combatant);
		if (combat.combatant?.id !== combatant.id) {
			throw new Error(
				"Attacks can only be spent by the Combatant whose turn is currently active.",
			);
		}

		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat);

		if (!state.turnStarted || state.turnCompleted) {
			throw new Error("The Combatant does not have an active attack window.");
		}

		const remaining = Math.max(0, allowance - state.spent);
		if (count > remaining) {
			throw new Error(
				`Not enough Attacks remain (${remaining} available, ${count} requested).`,
			);
		}

		await writeState(combatant, {
			...state,
			spent: state.spent + count,
		});

		return this.snapshot(combatant);
	}

	static async #commitParry(combatant, costMode) {
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat);

		assertParryAttemptAvailable(state, allowance);

		const plan = planParry(state, allowance, costMode);

		await writeState(combatant, {
			...plan.nextState,
			parriesThisRound: state.parriesThisRound + 1,
		});

		return Object.freeze({
			...this.snapshot(combatant),
			parryCostMode: costMode,
			parryAttackCost: plan.immediateAttackCost + plan.parryDebtAdded,
			parryImmediateAttackCost: plan.immediateAttackCost,
			parryDebtAdded: plan.parryDebtAdded,
		});
	}
}

/**
 * Plan one Core parry cost without mutating persistent state.
 *
 * Ordinary parry:
 * - consume one attack immediately if the attack window is active and has room;
 * - otherwise add one point of debt.
 *
 * Shield parry:
 * - if attacks remain in the active attack window, consume all of them;
 * - otherwise ensure at least one full A-sized future attack window is already
 *   forfeited. Existing debt can already cover some/all of that penalty.
 *
 * The ordering matters. An ordinary parry made *after* a shield parry can add
 * debt beyond the shield-suppressed window, while a shield parry made after
 * existing ordinary debt subsumes that debt into the "all following attacks"
 * penalty rather than automatically erasing an additional later round.
 */
function planParry(state, allowance, costMode) {
	const normalized = normalizeParryAttackCostMode(costMode);
	const activeAttackWindow = state.turnStarted && !state.turnCompleted;
	const remainingNow = activeAttackWindow
		? Math.max(0, allowance - state.spent)
		: 0;
	let spentAfter = state.spent;
	let parryDebtAfter = state.parryDebt;
	let immediateAttackCost = 0;

	if (normalized === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS) {
		if (remainingNow > 0) {
			immediateAttackCost = remainingNow;
			spentAfter = state.spent + immediateAttackCost;
		} else {
			parryDebtAfter = Math.max(parryDebtAfter, allowance);
		}
	} else if (remainingNow > 0) {
		immediateAttackCost = 1;
		spentAfter = state.spent + 1;
	} else {
		parryDebtAfter += 1;
	}

	const parryDebtAdded = Math.max(0, parryDebtAfter - state.parryDebt);

	return {
		immediateAttackCost,
		parryDebtAdded,
		nextState: {
			...state,
			spent: spentAfter,
			parryDebt: parryDebtAfter,
		},
	};
}

function projectedRemainingForState(state, allowance) {
	if (state.turnCompleted) return 0;
	if (state.turnStarted) {
		return Math.max(0, allowance - state.spent);
	}
	return Math.max(
		0,
		allowance - Math.min(allowance, state.parryDebt),
	);
}

function assertParryAttemptAvailable(state, allowance) {
	if (state.parriesThisRound >= allowance) {
		throw new Error(
			`Parry limit reached (0 of ${allowance} attempts remain this round).`,
		);
	}
}

async function requestAuthorizedAction(action, combatant, actionData) {
	assertCombatant(combatant);
	assertCanControlCombatant(combatant, game.user);

	if (game.user?.isGM) {
		return CombatAttackEconomy.commit(
			action,
			combatant,
			actionData,
			game.user,
		);
	}

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(
			"A GM must be connected to update Combatant attack resources.",
		);
	}

	const requestId = foundry.utils.randomID();
	const combat = combatant.parent;

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingSocketRequests.delete(requestId);
			reject(new Error("Combat attack-economy request timed out."));
		}, SOCKET_TIMEOUT_MS);

		pendingSocketRequests.set(requestId, {
			resolve,
			reject,
			timeout,
		});

		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user.id),
			combatId: String(combat?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			action,
			actionData: foundry.utils.deepClone(actionData ?? {}),
		});
	});
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (payload) => {
		if (!payload || typeof payload !== "object") return;

		if (payload.type === SOCKET_RESPONSE_TYPE) {
			handleSocketResponse(payload);
			return;
		}

		if (payload.type !== SOCKET_REQUEST_TYPE) return;
		if (!game.user?.isGM) return;
		if (primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: SOCKET_RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			requestUserId: String(payload.requestUserId ?? ""),
		};

		try {
			const combat = game.combats?.get(
				String(payload.combatId ?? ""),
			);
			const combatant = combat?.combatants?.get(
				String(payload.combatantId ?? ""),
			);
			const user = game.users?.get(
				String(payload.requestUserId ?? ""),
			);

			if (!combatant) {
				throw new Error("Requested Combatant is not available.");
			}
			if (!user?.active) {
				throw new Error("Requesting user is not active.");
			}

			response.result = await CombatAttackEconomy.commit(
				String(payload.action ?? ""),
				combatant,
				payload.actionData ?? {},
				user,
			);
		} catch (error) {
			response.error = error instanceof Error
				? error.message
				: String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleSocketResponse(payload) {
	if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) {
		return;
	}

	const requestId = String(payload.requestId ?? "");
	const pending = pendingSocketRequests.get(requestId);
	if (!pending) return;

	clearTimeout(pending.timeout);
	pendingSocketRequests.delete(requestId);

	if (payload.error) {
		pending.reject(new Error(String(payload.error)));
		return;
	}

	pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
}

function primaryActiveGM() {
	return Array.from(game.users ?? [])
		.filter((user) => user.active && user.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function assertCanControlCombatant(combatant, user) {
	if (!user) {
		throw new Error("A user is required for Combatant attack-resource changes.");
	}
	if (user.isGM) return;

	const actor = combatant.actor;
	const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	if (actor?.testUserPermission?.(user, ownerLevel)) return;

	throw new Error(
		"Only a GM or an OWNER of the Combatant Actor may spend its attack resources.",
	);
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function assertCombat(combat) {
	if (!(combat instanceof foundry.documents.Combat)) {
		throw new TypeError("A Foundry Combat is required.");
	}
}

function assertStartedCombat(combatant) {
	const combat = combatant.parent;
	assertCombat(combat);

	if (!combat.started || nonNegativeInteger(combat.round) <= 0) {
		throw new Error("The Combat encounter has not started.");
	}

	return combat;
}

function stateForCurrentRound(combatant, combat) {
	const round = nonNegativeInteger(combat.round);
	const raw = normalizeState(
		combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
		round,
	);

	if (raw.round === round) return raw;

	return {
		round,
		spent: 0,
		parryDebt: raw.round > round ? 0 : raw.parryDebt,
		parriesThisRound: 0,
		turnStarted: false,
		turnCompleted: false,
	};
}

function normalizeState(raw, fallbackRound) {
	const source = raw && typeof raw === "object" ? raw : {};

	return {
		round: nonNegativeInteger(source.round ?? fallbackRound),
		spent: nonNegativeInteger(source.spent),
		parryDebt: nonNegativeInteger(source.parryDebt),
		parriesThisRound: nonNegativeInteger(source.parriesThisRound),
		turnStarted: Boolean(source.turnStarted),
		turnCompleted: Boolean(source.turnCompleted),
	};
}

async function writeState(combatant, state) {
	await combatant.update({
		[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: normalizeState(
			state,
			combatant.parent?.round ?? 0,
		),
	});
}

function positiveInteger(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		throw new TypeError("Attack-resource count must be a positive integer.");
	}
	return Math.trunc(numeric);
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric)
		? Math.max(0, Math.trunc(numeric))
		: 0;
}
