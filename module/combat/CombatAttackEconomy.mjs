import {
	PARRY_ATTACK_COST_MODE,
	normalizeParryAttackCostMode,
} from "./CombatParryRules.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";

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
 * Actor A is the permanent allowance. Runtime state is stored on Combatant so
 * multiple Tokens of one Actor remain independent.
 *
 * Two world-level interpretations are supported:
 *
 * 1. Core/default following-attacks model:
 *    - ordinary parry loses the next Attack;
 *    - a shield parry loses all following Attacks;
 *    - losses which cannot be paid in the current attack window become bounded
 *      parry debt for the next attack opportunity.
 *
 * 2. Optional round contract:
 *    - no parry debt exists;
 *    - weapon parry reduces this round's remaining offensive Attacks by 1;
 *    - a shield parry is legal only if no offensive attack has been made this
 *      round and sets this round's offensive Attacks to 0;
 *    - parry attempts remain a separate resource capped by permanent A;
 *    - all round-contract state resets on the next round.
 */
export class CombatAttackEconomy {
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

	static snapshot(combatant) {
		assertCombatant(combatant);

		const combat = combatant.parent;
		const allowance = this.allowance(combatant);
		const roundContract = WfrpRuleSettings.usesRoundDefenceContract();
		const state = stateForCurrentRound(combatant, combat, allowance);
		const attackWindowOpen = Boolean(
			combat?.started &&
			combat.combatant?.id === combatant.id &&
			state.turnStarted &&
			!state.turnCompleted,
		);
		const currentAttackRemaining = state.turnStarted && !state.turnCompleted
			? Math.max(0, allowance - state.spent)
			: 0;

		let projectedNextTurnAttacks;
		let remaining;
		if (roundContract) {
			projectedNextTurnAttacks = Math.max(0, allowance - state.spent);
			remaining = state.turnCompleted
				? 0
				: projectedNextTurnAttacks;
		} else {
			projectedNextTurnAttacks = Math.max(
				0,
				allowance - Math.min(allowance, state.parryDebt),
			);
			if (state.turnCompleted) {
				remaining = 0;
			} else if (state.turnStarted) {
				remaining = currentAttackRemaining;
			} else {
				remaining = projectedNextTurnAttacks;
			}
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
			parryDebt: roundContract
				? 0
				: Math.min(allowance, state.parryDebt),
			parriesThisRound: state.parriesThisRound,
			parryAttemptsRemaining,
			attacksMadeThisRound: state.attacksMadeThisRound,
			shieldDefenceCommitted:
				roundContract && state.shieldDefenceCommitted,
			turnStarted: state.turnStarted,
			turnCompleted: state.turnCompleted,
			attackWindowOpen,
			canAttack: attackWindowOpen && currentAttackRemaining > 0,
			canParry: combatStarted && parryAttemptsRemaining > 0,
			roundContract,
		});
	}

	/**
	 * Return whether the requested parry cost mode is legal right now.
	 *
	 * In the round-contract interpretation Shield is unavailable after any real
	 * offensive attack this round. Weapon parries do not count as offensive
	 * attacks, so a character may parry with a weapon and later choose Full
	 * Defence with a shield before actually attacking.
	 */
	static parryCostAvailability(
		combatant,
		{
			costMode = PARRY_ATTACK_COST_MODE.ONE_ATTACK,
		} = {},
	) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat, allowance);
		const normalizedCostMode = normalizeParryAttackCostMode(costMode);

		if (
			WfrpRuleSettings.usesRoundDefenceContract() &&
			normalizedCostMode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS &&
			!state.shieldDefenceCommitted &&
			state.attacksMadeThisRound > 0
		) {
			return Object.freeze({
				available: false,
				reason: "shield-after-offensive-attack",
			});
		}

		return Object.freeze({ available: true, reason: null });
	}

	static previewParry(
		combatant,
		{
			costMode = PARRY_ATTACK_COST_MODE.ONE_ATTACK,
		} = {},
	) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat, allowance);

		assertParryAttemptAvailable(state, allowance);

		const normalizedCostMode = normalizeParryAttackCostMode(costMode);
		const availability = this.parryCostAvailability(combatant, {
			costMode: normalizedCostMode,
		});
		if (!availability.available) {
			throw new Error(
				"Shield Full Defence cannot be declared after an offensive attack in the same round.",
			);
		}

		const before = this.snapshot(combatant);
		const plan = planParry(state, allowance, normalizedCostMode);
		const roundContract = WfrpRuleSettings.usesRoundDefenceContract();
		const remainingAfter = projectedRemainingForState(
			plan.nextState,
			allowance,
		);
		const projectedNextTurnAttacksAfter = roundContract
			? Math.max(0, allowance - plan.nextState.spent)
			: Math.max(
				0,
				allowance - Math.min(allowance, plan.nextState.parryDebt),
			);

		return Object.freeze({
			parryCostMode: normalizedCostMode,
			parryAttackCost: plan.ruleAttackCost,
			parryImmediateAttackCost: plan.immediateAttackCost,
			parryDebtAdded: roundContract ? 0 : plan.parryDebtAdded,
			parryDebtBefore: roundContract
				? 0
				: Math.min(allowance, state.parryDebt),
			parryDebtAfter: roundContract
				? 0
				: Math.min(allowance, plan.nextState.parryDebt),
			remainingAttacksBefore: before.remaining,
			remainingAttacksAfter: remainingAfter,
			projectedNextTurnAttacksBefore: before.projectedNextTurnAttacks,
			projectedNextTurnAttacksAfter,
			shieldDefensiveCommitment:
				roundContract &&
				normalizedCostMode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS,
			shieldDefenceCommittedAfter: plan.nextState.shieldDefenceCommitted,
			roundContract,
		});
	}

	/** Reset round-scoped counters. */
	static async startRound(combat) {
		assertCombat(combat);

		const round = nonNegativeInteger(combat.round);
		const roundContract = WfrpRuleSettings.usesRoundDefenceContract();
		const updates = [];

		for (const combatant of combat.combatants) {
			const allowance = this.allowance(combatant);
			const previous = normalizeState(
				combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
				round,
			);
			const carriedDebt = roundContract || previous.round > round
				? 0
				: Math.min(allowance, previous.parryDebt);

			updates.push({
				_id: combatant.id,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: {
					round,
					spent: 0,
					parryDebt: carriedDebt,
					parriesThisRound: 0,
					attacksMadeThisRound: 0,
					shieldDefenceCommitted: false,
					turnStarted: false,
					turnCompleted: false,
				},
			});
		}

		if (updates.length) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}

	static async initializeCombatant(combatant) {
		assertCombatant(combatant);
		const combat = combatant.parent;
		if (!combat?.started || nonNegativeInteger(combat.round) <= 0) return;

		await writeState(combatant, {
			round: nonNegativeInteger(combat.round),
			spent: 0,
			parryDebt: 0,
			parriesThisRound: 0,
			attacksMadeThisRound: 0,
			shieldDefenceCommitted: false,
			turnStarted: false,
			turnCompleted: false,
		});
	}

	/**
	 * Opening a turn never resets same-round parry costs.
	 *
	 * Round contract simply opens the attack window using whatever Attacks remain
	 * after earlier parries. Default mode additionally pays carried debt.
	 */
	static async startTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat, allowance);
		const roundContract = WfrpRuleSettings.usesRoundDefenceContract();
		const debt = roundContract ? 0 : Math.min(allowance, state.parryDebt);
		const paidDebt = Math.min(
			debt,
			Math.max(0, allowance - state.spent),
		);

		await writeState(combatant, {
			...state,
			spent: Math.min(allowance, state.spent + paidDebt),
			parryDebt: roundContract ? 0 : Math.max(0, debt - paidDebt),
			turnStarted: true,
			turnCompleted: false,
		});

		return this.snapshot(combatant);
	}

	static async endTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat, allowance);

		await writeState(combatant, {
			...state,
			parryDebt: WfrpRuleSettings.usesRoundDefenceContract()
				? 0
				: state.parryDebt,
			turnStarted: true,
			turnCompleted: true,
		});

		return this.snapshot(combatant);
	}

	static async spendAttack(combatant, count = 1) {
		return requestAuthorizedAction(
			"attack",
			combatant,
			{ count: positiveInteger(count) },
		);
	}

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

	/** GM-authoritative mutation used directly and by socket requests. */
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
		const state = stateForCurrentRound(combatant, combat, allowance);

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
			parryDebt: WfrpRuleSettings.usesRoundDefenceContract()
				? 0
				: state.parryDebt,
			attacksMadeThisRound: state.attacksMadeThisRound + count,
		});

		return this.snapshot(combatant);
	}

	static async #commitParry(combatant, costMode) {
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat, allowance);

		assertParryAttemptAvailable(state, allowance);
		const availability = this.parryCostAvailability(combatant, { costMode });
		if (!availability.available) {
			throw new Error(
				"Shield Full Defence cannot be declared after an offensive attack in the same round.",
			);
		}

		const plan = planParry(state, allowance, costMode);
		const roundContract = WfrpRuleSettings.usesRoundDefenceContract();

		await writeState(combatant, {
			...plan.nextState,
			parryDebt: roundContract ? 0 : plan.nextState.parryDebt,
			parriesThisRound: state.parriesThisRound + 1,
		});

		return Object.freeze({
			...this.snapshot(combatant),
			parryCostMode: costMode,
			parryAttackCost: plan.ruleAttackCost,
			parryImmediateAttackCost: plan.immediateAttackCost,
			parryDebtAdded: roundContract ? 0 : plan.parryDebtAdded,
			shieldDefensiveCommitment:
				roundContract &&
				costMode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS,
			roundContract,
		});
	}
}

/**
 * Plan one parry without mutating persistent state.
 */
function planParry(state, allowance, costMode) {
	const normalized = normalizeParryAttackCostMode(costMode);
	const roundContract = WfrpRuleSettings.usesRoundDefenceContract();

	if (roundContract) {
		const remainingBefore = Math.max(0, allowance - state.spent);
		let spentAfter = state.spent;
		let immediateAttackCost = 0;
		let shieldDefenceCommitted = state.shieldDefenceCommitted;
		let ruleAttackCost = normalized === PARRY_ATTACK_COST_MODE.ONE_ATTACK
			? 1
			: remainingBefore;

		if (
			normalized === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS
		) {
			shieldDefenceCommitted = true;
			immediateAttackCost = remainingBefore;
			spentAfter = allowance;
		} else {
			immediateAttackCost = Math.min(1, remainingBefore);
			spentAfter = Math.min(allowance, state.spent + 1);
		}

		return {
			ruleAttackCost,
			immediateAttackCost,
			parryDebtAdded: 0,
			nextState: {
				...state,
				spent: spentAfter,
				parryDebt: 0,
				shieldDefenceCommitted,
			},
		};
	}

	const activeAttackWindow = state.turnStarted && !state.turnCompleted;
	const remainingNow = activeAttackWindow
		? Math.max(0, allowance - state.spent)
		: 0;
	let spentAfter = state.spent;
	let parryDebtAfter = Math.min(allowance, state.parryDebt);
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
		parryDebtAfter = Math.min(allowance, parryDebtAfter + 1);
	}

	parryDebtAfter = Math.min(allowance, Math.max(0, parryDebtAfter));
	const parryDebtAdded = Math.max(
		0,
		parryDebtAfter - Math.min(allowance, state.parryDebt),
	);

	return {
		ruleAttackCost: immediateAttackCost + parryDebtAdded,
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
	if (WfrpRuleSettings.usesRoundDefenceContract()) {
		return Math.max(0, allowance - state.spent);
	}
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

function stateForCurrentRound(
	combatant,
	combat,
	allowance = CombatAttackEconomy.allowance(combatant),
) {
	const round = nonNegativeInteger(combat?.round);
	const raw = normalizeState(
		combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
		round,
	);
	const roundContract = WfrpRuleSettings.usesRoundDefenceContract();

	if (raw.round === round) {
		return {
			...raw,
			spent: Math.min(allowance, raw.spent),
			parryDebt: roundContract
				? 0
				: Math.min(allowance, raw.parryDebt),
		};
	}

	return {
		round,
		spent: 0,
		parryDebt: roundContract || raw.round > round
			? 0
			: Math.min(allowance, raw.parryDebt),
		parriesThisRound: 0,
		attacksMadeThisRound: 0,
		shieldDefenceCommitted: false,
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
		attacksMadeThisRound: nonNegativeInteger(source.attacksMadeThisRound),
		shieldDefenceCommitted: Boolean(source.shieldDefenceCommitted),
		turnStarted: Boolean(source.turnStarted),
		turnCompleted: Boolean(source.turnCompleted),
	};
}

async function writeState(combatant, state) {
	const normalized = normalizeState(
		state,
		combatant.parent?.round ?? 0,
	);
	if (WfrpRuleSettings.usesRoundDefenceContract()) {
		normalized.parryDebt = 0;
	}

	await combatant.update({
		[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: normalized,
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
