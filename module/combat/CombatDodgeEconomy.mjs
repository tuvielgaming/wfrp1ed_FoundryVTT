const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "dodgeEconomy";
const DODGE_BLOW_RULES_ID = "dodgeBlow";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-dodge-economy-request";
const SOCKET_RESPONSE_TYPE = "combat-dodge-economy-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingSocketRequests = new Map();

Hooks.once("ready", () => {
	registerSocket();
});

/**
 * Combatant-owned WFRP 1e Dodge Blow / Uniki usage state.
 *
 * Core Dodge Blow is not part of the Attacks resource. A character who owns
 * the Dodge Blow Skill may attempt to use it at most once in a combat round.
 * The eventual incoming-blow transaction decides whether a particular blow is
 * eligible (hand-to-hand, seen coming, not a prohibited surprise/missile use)
 * and owns the Initiative test. This service owns only the per-round resource.
 */
export class CombatDodgeEconomy {
	/**
	 * Stable rules identity used by the Skill Item contract.
	 *
	 * @returns {string}
	 */
	static get rulesId() {
		return DODGE_BLOW_RULES_ID;
	}

	/**
	 * Determine whether the Combatant Actor possesses the audited Dodge Blow
	 * Skill. Mechanical identity is resolved exclusively through Skill.rulesId;
	 * localized or user-edited Item names are never used for rules lookup.
	 *
	 * @param {Combatant} combatant
	 * @returns {boolean}
	 */
	static hasSkill(combatant) {
		assertCombatant(combatant);
		return actorHasDodgeBlow(combatant.actor);
	}

	/**
	 * Return presentation-safe Dodge Blow round state.
	 *
	 * `canAttemptThisRound` means only that the character owns Dodge Blow and
	 * has not spent its once-per-round use. It deliberately does not claim that
	 * a specific incoming attack can be dodged; that belongs to the pending
	 * defence transaction.
	 *
	 * @param {Combatant} combatant
	 * @returns {Object}
	 */
	static snapshot(combatant) {
		assertCombatant(combatant);

		const combat = combatant.parent;
		const round = nonNegativeInteger(combat?.round);
		const state = normalizeState(
			combatant.getFlag(FLAG_SCOPE, FLAG_KEY),
			round,
		);
		const combatStarted = Boolean(
			combat?.started && round > 0,
		);
		const hasSkill = actorHasDodgeBlow(combatant.actor);
		const currentRound = state.round === round;
		const usedThisRound = currentRound && state.used;

		return Object.freeze({
			combatId: String(combat?.id ?? ""),
			combatantId: String(combatant.id ?? ""),
			actorUuid: String(combatant.actor?.uuid ?? ""),
			round,
			hasSkill,
			usedThisRound,
			canAttemptThisRound:
				combatStarted && hasSkill && !usedThisRound,
		});
	}

	/**
	 * Reset the once-per-round Dodge Blow resource for every Combatant.
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
					used: false,
				},
			});
		}

		if (updates.length) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}

	/**
	 * Initialize a Combatant which enters an already-started encounter.
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
			used: false,
		});
	}

	/**
	 * Spend the character's Dodge Blow attempt for this round.
	 *
	 * The resource is spent when the defender commits to Dodge, before the
	 * Initiative test result is known. A failed Dodge therefore still consumes
	 * the once-per-round use, as required by the Core procedure.
	 *
	 * GM calls commit directly; an OWNER client sends an authoritative request
	 * to the primary active GM.
	 *
	 * @param {Combatant} combatant
	 * @returns {Promise<Object>}
	 */
	static async spendAttempt(combatant) {
		assertCombatant(combatant);
		assertCanControlCombatant(combatant, game.user);

		if (game.user?.isGM) {
			return this.commitAttempt(combatant, game.user);
		}

		const gm = primaryActiveGM();
		if (!gm) {
			throw new Error(
				"A GM must be connected to update Combatant Dodge Blow state.",
			);
		}

		const requestId = foundry.utils.randomID();
		const combat = combatant.parent;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingSocketRequests.delete(requestId);
				reject(new Error("Combat Dodge Blow request timed out."));
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
			});
		});
	}

	/**
	 * GM-authoritative Dodge Blow resource mutation.
	 *
	 * The future pending defence transaction may call this directly on the GM
	 * after validating that the selected incoming blow is Dodge-eligible.
	 *
	 * @param {Combatant} combatant
	 * @param {User} requestingUser
	 * @returns {Promise<Object>}
	 */
	static async commitAttempt(combatant, requestingUser) {
		assertCombatant(combatant);
		assertCanControlCombatant(combatant, requestingUser);

		if (!game.user?.isGM) {
			throw new Error(
				"Combat Dodge Blow mutations require GM authority.",
			);
		}

		const combat = assertStartedCombat(combatant);
		const round = nonNegativeInteger(combat.round);
		const state = stateForCurrentRound(combatant, combat);

		if (!actorHasDodgeBlow(combatant.actor)) {
			throw new Error(
				"The Combatant Actor does not possess the Dodge Blow Skill.",
			);
		}

		if (state.used) {
			throw new Error(
				"Dodge Blow has already been attempted by this Combatant this round.",
			);
		}

		await writeState(combatant, {
			round,
			used: true,
		});

		return this.snapshot(combatant);
	}
}

function actorHasDodgeBlow(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		return false;
	}

	return Array.from(actor.items ?? []).some((item) =>
		item.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === DODGE_BLOW_RULES_ID,
	);
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

			response.result = await CombatDodgeEconomy.commitAttempt(
				combatant,
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
		throw new Error("A user is required for Combatant Dodge Blow changes.");
	}
	if (user.isGM) return;

	const actor = combatant.actor;
	const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	if (actor?.testUserPermission?.(user, ownerLevel)) return;

	throw new Error(
		"Only a GM or an OWNER of the Combatant Actor may spend its Dodge Blow use.",
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
		used: false,
	};
}

function normalizeState(raw, fallbackRound) {
	const source = raw && typeof raw === "object" ? raw : {};

	return {
		round: nonNegativeInteger(source.round ?? fallbackRound),
		used: Boolean(source.used),
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

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric)
		? Math.max(0, Math.trunc(numeric))
		: 0;
}
