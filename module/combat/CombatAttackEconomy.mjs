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
 * The Actor characteristic `A / Attacks` is the permanent allowance. Runtime
 * spending belongs to the Combatant so multiple tokens of the same Actor can
 * maintain independent combat state.
 *
 * Core p.118: an ordinary parry loses the character's next attack whether the
 * parry succeeds or fails. A shield parry loses all following attacks. The
 * default implementation pays those losses immediately when possible and uses
 * bounded parry debt when the loss has to reach the next attack opportunity.
 *
 * `parriesThisRound` is independent of attack availability. The Core limit is
 * at most A parry attempts in one round, even when all current attacks have
 * already been used.
 *
 * The optional shield defensive-commitment world rule is intentionally separate
 * from the default interpretation. Under that rule a shield may be committed
 * only before the character has made an offensive attack in the round. The
 * commitment forfeits offence for the rest of that round while the ordinary A
 * parry-attempt limit remains in force; repeated shield parries do not create
 * additional future shield debt.
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
		const state = normalizeState(
			combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
			combat?.round ?? 0,
		);
		const shieldDefenceCommitted = Boolean(
			WfrpRuleSettings.usesShieldDefensiveCommitment() &&
			state.shieldDefenceCommitted,
		);
		const attackWindowOpen = Boolean(
			combat?.started &&
			combat.combatant?.id === combatant.id &&
			state.turnStarted &&
			!state.turnCompleted,
		);
		const currentAttackRemaining =
			state.turnStarted && !state.turnCompleted && !shieldDefenceCommitted
				? Math.max(0, allowance - state.spent)
				: 0;
		const projectedNextTurnAttacks = shieldDefenceCommitted && !state.turnStarted
			? 0
			: Math.max(
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
			parryDebt: Math.min(allowance, state.parryDebt),
			parriesThisRound: state.parriesThisRound,
			parryAttemptsRemaining,
			attacksMadeThisRound: state.attacksMadeThisRound,
			shieldDefenceCommitted,
			turnStarted: state.turnStarted,
			turnCompleted: state.turnCompleted,
			attackWindowOpen,
			canAttack:
				attackWindowOpen &&
				!shieldDefenceCommitted &&
				currentAttackRemaining > 0,
			canParry: combatStarted && parryAttemptsRemaining > 0,
		});
	}

	/**
	 * Return whether one parry-cost mode is currently legal before previewing it.
	 * This is primarily needed by the optional shield commitment rule so an
	 * illegal shield choice can be omitted without hiding other parry Items.
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
			WfrpRuleSettings.usesShieldDefensiveCommitment() &&
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
				"Shield defensive commitment cannot be declared after an offensive attack in the same round.",
			);
		}

		const plan = planParry(state, allowance, normalizedCostMode);
		const before = this.snapshot(combatant);
		const remainingAfter = projectedRemainingForState(
			plan.nextState,
			allowance,
		);
		const projectedNextTurnAttacksAfter =
			plan.nextState.shieldDefenceCommitted &&
			WfrpRuleSettings.usesShieldDefensiveCommitment() &&
			!plan.nextState.turnStarted
				? 0
				: Math.max(
					0,
					allowance - Math.min(allowance, plan.nextState.parryDebt),
				);

		return Object.freeze({
			parryCostMode: normalizedCostMode,
			parryAttackCost: plan.immediateAttackCost + plan.parryDebtAdded,
			parryImmediateAttackCost: plan.immediateAttackCost,
			parryDebtAdded: plan.parryDebtAdded,
			parryDebtBefore: Math.min(allowance, state.parryDebt),
			parryDebtAfter: Math.min(allowance, plan.nextState.parryDebt),
			remainingAttacksBefore: before.remaining,
			remainingAttacksAfter: remainingAfter,
			projectedNextTurnAttacksBefore: before.projectedNextTurnAttacks,
			projectedNextTurnAttacksAfter,
			shieldDefensiveCommitment:
				WfrpRuleSettings.usesShieldDefensiveCommitment() &&
				normalizedCostMode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS,
			shieldDefenceCommittedAfter: plan.nextState.shieldDefenceCommitted,
		});
	}

	static async startRound(combat) {
		assertCombat(combat);

		const round = nonNegativeInteger(combat.round);
		const updates = [];

		for (const combatant of combat.combatants) {
			const allowance = this.allowance(combatant);
			const previous = normalizeState(
				combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
				round,
			);
			const carriedDebt = previous.round > round
				? 0
				: previous.parryDebt;

			updates.push({
				_id: combatant.id,
				[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: {
					round,
					spent: 0,
					parryDebt: Math.min(allowance, carriedDebt),
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

	static async startTurn(combatant) {
		assertCombatant(combatant);
		const combat = assertStartedCombat(combatant);
		const allowance = this.allowance(combatant);
		const state = stateForCurrentRound(combatant, combat, allowance);
		const debt = Math.min(allowance, state.parryDebt);
		const paidDebt = Math.min(allowance, debt);

		await writeState(combatant, {
			...state,
			spent: paidDebt,
			parryDebt: Math.max(0, debt - paidDebt),
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
			turnStarted: true,
			turnCompleted: true,
		});

		return this.snapshot(combatant);
	}

	static async spendAttack(combatant, count = 1) {
		return requestAuthorizedAction(
			"attack",
			combatant,
			{
				count: positiveInteger(count),
			},
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
		if (
			WfrpRuleSettings.usesShieldDefensiveCommitment() &&
			state.shieldDefenceCommitted
		) {
			throw new Error(
				"This Combatant committed all offensive Attacks to shield defence for the current round.",
			);
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
				"Shield defensive commitment cannot be declared after an offensive attack in the same round.",
			);
		}

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
			shieldDefensiveCommitment:
				WfrpRuleSettings.usesShieldDefensiveCommitment() &&
				costMode === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS,
		});
	}
}

function planParry(state, allowance, costMode) {
	const normalized = normalizeParryAttackCostMode(costMode);
	const optionalCommitment = WfrpRuleSettings.usesShieldDefensiveCommitment();
	const activeAttackWindow = state.turnStarted && !state.turnCompleted;
	const currentOffenceForfeited = optionalCommitment && state.shieldDefenceCommitted;
	const remainingNow = activeAttackWindow && !currentOffenceForfeited
		? Math.max(0, allowance - state.spent)
		: 0;
	let spentAfter = state.spent;
	let parryDebtAfter = Math.min(allowance, state.parryDebt);
	let immediateAttackCost = 0;
	let shieldDefenceCommitted = state.shieldDefenceCommitted;

	if (optionalCommitment && state.shieldDefenceCommitted) {
		/*
		 * The round's offensive A pool has already been committed to defence.
		 * `parriesThisRound` remains the authoritative limit, so subsequent parry
		 * attempts in this round do not create another Attack/debt charge.
		 */
	} else if (
		optionalCommitment &&
		normalized === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS
	) {
		shieldDefenceCommitted = true;
		if (remainingNow > 0) {
			immediateAttackCost = remainingNow;
			spentAfter = allowance;
		}
		/* No future debt: this optional interpretation forfeits this round's offence. */
	} else if (normalized === PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS) {
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
		immediateAttackCost,
		parryDebtAdded,
		nextState: {
			...state,
			spent: spentAfter,
			parryDebt: parryDebtAfter,
			shieldDefenceCommitted,
		},
	};
}

function projectedRemainingForState(state, allowance) {
	if (state.turnCompleted) return 0;
	if (
		WfrpRuleSettings.usesShieldDefensiveCommitment() &&
		state.shieldDefenceCommitted
	) {
		return 0;
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

function stateForCurrentRound(combatant, combat, allowance = CombatAttackEconomy.allowance(combatant)) {
	const round = nonNegativeInteger(combat.round);
	const raw = normalizeState(
		combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
		round,
	);

	if (raw.round === round) {
		return {
			...raw,
			parryDebt: Math.min(allowance, raw.parryDebt),
		};
	}

	return {
		round,
		spent: 0,
		parryDebt: raw.round > round ? 0 : Math.min(allowance, raw.parryDebt),
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
