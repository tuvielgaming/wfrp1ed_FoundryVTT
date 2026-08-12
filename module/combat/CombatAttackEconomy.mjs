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
 * Parrying follows the Core rule that each parry loses the character's next
 * attack. A parry made before the character's turn is therefore recorded as
 * debt and consumed when that turn starts. A parry made after the turn carries
 * into a future turn. The separate per-round parry counter enforces the Core
 * limit of at most `A` parry attempts in one round.
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

		let remaining;
		if (state.turnCompleted) {
			remaining = 0;
		} else if (state.turnStarted) {
			remaining = Math.max(0, allowance - state.spent);
		} else {
			remaining = Math.max(
				0,
				allowance - Math.min(allowance, state.parryDebt),
			);
		}

		return Object.freeze({
			combatId: String(combat?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			round: state.round,
			allowance,
			spent: state.spent,
			remaining,
			parryDebt: state.parryDebt,
			parriesThisRound: state.parriesThisRound,
			turnStarted: state.turnStarted,
			turnCompleted: state.turnCompleted,
		});
	}

	/**
	 * Begin a new Combat round for every Combatant.
	 *
	 * Existing parry debt is preserved and will be consumed when each Combatant's
	 * turn actually begins. Rewinding to an earlier round clears future debt
	 * rather than leaking state backward through time.
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
	 * @param {Combatant} combatant
	 * @returns {Promise<Object>}
	 */
	static async startTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat);
		const paidDebt = Math.min(allowance, state.parryDebt);

		const next = {
			...state,
			spent: paidDebt,
			parryDebt: Math.max(0, state.parryDebt - paidDebt),
			turnStarted: true,
			turnCompleted: false,
		};

		await writeState(combatant, next);
		return this.snapshot(combatant);
	}

	/**
	 * Mark a Combatant turn as completed. Any later parry therefore becomes debt
	 * for a future turn instead of mutating an already-finished attack budget.
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
			positiveInteger(count),
		);
	}

	/**
	 * Spend one or more parry attempts under the Core "lose next attack" rule.
	 *
	 * @param {Combatant} combatant
	 * @param {number} [count=1]
	 * @returns {Promise<Object>}
	 */
	static async spendParry(combatant, count = 1) {
		return requestAuthorizedAction(
			"parry",
			combatant,
			positiveInteger(count),
		);
	}

	/**
	 * GM-authoritative mutation used by direct GM calls and socket requests.
	 *
	 * @param {string} action
	 * @param {Combatant} combatant
	 * @param {number} count
	 * @param {User} requestingUser
	 * @returns {Promise<Object>}
	 * @internal
	 */
	static async commit(action, combatant, count, requestingUser) {
		assertCombatant(combatant);
		assertCanControlCombatant(combatant, requestingUser);

		if (!game.user?.isGM) {
			throw new Error(
				"Combat attack-economy mutations require GM authority.",
			);
		}

		if (action === "attack") {
			return this.#commitAttack(combatant, count);
		}

		if (action === "parry") {
			return this.#commitParry(combatant, count);
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
			throw new Error("The Combatant does not have an active turn.");
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

	static async #commitParry(combatant, count) {
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat);

		if (count + state.parriesThisRound > allowance) {
			const remainingParries = Math.max(
				0,
				allowance - state.parriesThisRound,
			);
			throw new Error(
				`Parry limit reached (${remainingParries} of ${allowance} attempts remain this round).`,
			);
		}

		let spentNow = 0;
		if (state.turnStarted && !state.turnCompleted) {
			const remainingAttacks = Math.max(
				0,
				allowance - state.spent,
			);
			spentNow = Math.min(count, remainingAttacks);
		}

		const deferred = count - spentNow;

		await writeState(combatant, {
			...state,
			spent: state.spent + spentNow,
			parryDebt: state.parryDebt + deferred,
			parriesThisRound: state.parriesThisRound + count,
		});

		return this.snapshot(combatant);
	}
}

async function requestAuthorizedAction(action, combatant, count) {
	assertCombatant(combatant);
	assertCanControlCombatant(combatant, game.user);

	if (game.user?.isGM) {
		return CombatAttackEconomy.commit(
			action,
			combatant,
			count,
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
			count,
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
				positiveInteger(payload.count),
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
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
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
		parryDebt: raw.round < round ? raw.parryDebt : 0,
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
