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
 * Core p.118 treats Attacks as a round resource for both blows and parries:
 * every ordinary parry consumes one Attack, while a shield parry consumes all
 * following Attacks. There is no next-round parry debt. Unspent Attacks remain
 * available for defensive parries after the Combatant's own turn, but attacks
 * themselves may only be made during that Combatant's active turn.
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
	 * `remaining` means unspent A for the current round. After the Combatant's
	 * own turn it can still pay for parries, but it can no longer be converted
	 * back into attacks because the attack window has closed.
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
		const remaining = Math.max(0, allowance - state.spent);
		const attackWindowOpen = Boolean(
			combat?.started &&
			combat.combatant?.id === combatant.id &&
			state.turnStarted &&
			!state.turnCompleted,
		);
		const parryAttemptsRemaining = Math.max(
			0,
			Math.min(
				remaining,
				allowance - state.parriesThisRound,
			),
		);

		return Object.freeze({
			combatId: String(combat?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			round: state.round,
			allowance,
			spent: state.spent,
			remaining,
			parriesThisRound: state.parriesThisRound,
			parryAttemptsRemaining,
			turnStarted: state.turnStarted,
			turnCompleted: state.turnCompleted,
			attackWindowOpen,
			canAttack: attackWindowOpen && remaining > 0,
			canParry: parryAttemptsRemaining > 0,
		});
	}

	/**
	 * Begin a new Combat round for every Combatant.
	 *
	 * Attacks are a round resource. Nothing carries forward from the previous
	 * round, including unused Attacks or parry costs.
	 *
	 * @param {Combat} combat
	 * @returns {Promise<void>}
	 */
	static async startRound(combat) {
		assertCombat(combat);

		const round = nonNegativeInteger(combat.round);
		const updates = [];

		for (const combatant of combat.combatants) {
			updates.push({
				_id: combatant.id,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: {
					round,
					spent: 0,
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
			parriesThisRound: 0,
			turnStarted: false,
			turnCompleted: false,
		});
	}

	/**
	 * Start one Combatant turn without resetting resources already spent on
	 * parries earlier in the same round.
	 *
	 * @param {Combatant} combatant
	 * @returns {Promise<Object>}
	 */
	static async startTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const state = stateForCurrentRound(combatant, combat);

		await writeState(combatant, {
			...state,
			turnStarted: true,
			turnCompleted: false,
		});

		return this.snapshot(combatant);
	}

	/**
	 * Mark a Combatant turn as completed.
	 *
	 * Unspent Attacks remain available for later parries in this round. They may
	 * not be spent as attacks because the character's own turn has ended.
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
	 * Ordinary weapon parry: one Attack.
	 * Shield parry: all Attacks which remain in this round.
	 *
	 * The eventual defensive-response flow supplies the cost mode from the
	 * selected held parry Item. The default remains one Attack for console/macros
	 * which explicitly model an ordinary weapon parry.
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
		const remaining = Math.max(0, allowance - state.spent);

		if (remaining <= 0) {
			throw new Error(
				"No Attacks remain to spend on a parry this round.",
			);
		}

		if (state.parriesThisRound >= allowance) {
			throw new Error(
				`Parry limit reached (0 of ${allowance} attempts remain this round).`,
			);
		}

		const attackCost = costMode ===
			PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS
			? remaining
			: 1;

		await writeState(combatant, {
			...state,
			spent: state.spent + attackCost,
			parriesThisRound: state.parriesThisRound + 1,
		});

		return Object.freeze({
			...this.snapshot(combatant),
			parryCostMode: costMode,
			parryAttackCost: attackCost,
		});
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
