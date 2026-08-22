import { WEAPON_KIND, weaponRangedCycleSnapshot } from "../data-models/item/WeaponData.mjs";
import { ActorOwnerEditPermission } from "../sheets/ActorOwnerEditPermission.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ITEM_FLAG_KEY = "rangedRuntime";
const COMBATANT_FLAG_KEY = "rangedTurnState";
const SETTING_KEY = "automaticRangedReloadCountdown";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-ranged-state-request";
const SOCKET_RESPONSE_TYPE = "combat-ranged-state-response";
const SOCKET_TIMEOUT_MS = 10000;

const pendingRequests = new Map();
const endingCombatants = new Map();

/**
 * Runtime state for ranged weapons.
 *
 * Authored weapon facts live in WeaponData (Reload, shots per firing round,
 * magazine capacity/refill). Mutable play state lives in flags so it can be
 * adjudicated without duplicating authored data:
 * - Item flag: readyToFire, reloadRemaining, magazineRemaining;
 * - Combatant flag: one round-scoped ranged shot pool and full-turn commitment.
 */
export class CombatRangedState {
	static automaticCountdownEnabled() {
		try {
			return game.settings.get(game.system.id, SETTING_KEY) === true;
		} catch (_error) {
			return false;
		}
	}

	static runtime(weapon) {
		assertRangedWeapon(weapon);
		const cycle = weaponRangedCycleSnapshot(weapon);
		const raw = weapon.getFlag?.(FLAG_SCOPE, ITEM_FLAG_KEY) ?? {};
		const automatic = this.automaticCountdownEnabled();
		const maximumCounter = cycle.reloadRounds + (automatic ? 1 : 0);
		const reloadRemaining = clampInteger(
			raw.reloadRemaining,
			0,
			maximumCounter,
		);
		const magazineRemaining = cycle.magazineCapacity > 0
			? clampInteger(
				raw.magazineRemaining ?? cycle.magazineCapacity,
				0,
				cycle.magazineCapacity,
			)
			: null;

		return Object.freeze({
			weaponUuid: String(weapon.uuid ?? ""),
			reloadRounds: cycle.reloadRounds,
			reloadRemaining,
			readyToFire: cycle.reloadRounds === 0
				? true
				: raw.readyToFire === true,
			shotsPerFireRound: cycle.shotsPerFireRound,
			magazineCapacity: cycle.magazineCapacity,
			magazineRemaining,
			magazineReloadRounds: cycle.magazineReloadRounds,
			automaticCountdown: automatic,
		});
	}

	static turnState(combatant, weapon = null) {
		if (!combatant) {
			const allowance = weapon
				? weaponRangedCycleSnapshot(weapon)?.shotsPerFireRound ?? 1
				: 1;
			return Object.freeze({
				inCombat: false,
				round: 0,
				weaponUuid: "",
				allowance,
				spent: 0,
				remaining: allowance,
				committedAction: "",
			});
		}

		const combat = combatant.parent;
		const round = nonNegativeInteger(combat?.round);
		const raw = combatant.getFlag?.(FLAG_SCOPE, COMBATANT_FLAG_KEY) ?? {};
		const sameRound = nonNegativeInteger(raw.round) === round;
		const rawWeaponUuid = sameRound ? String(raw.weaponUuid ?? "") : "";
		const allowance = weapon
			? weaponRangedCycleSnapshot(weapon)?.shotsPerFireRound ?? 1
			: Math.max(1, nonNegativeInteger(raw.allowance) || 1);
		const sameWeapon = !weapon || !rawWeaponUuid || rawWeaponUuid === weapon.uuid;
		const spent = sameRound && sameWeapon
			? Math.min(allowance, nonNegativeInteger(raw.spent))
			: 0;

		return Object.freeze({
			inCombat: true,
			round,
			weaponUuid: rawWeaponUuid,
			allowance,
			spent,
			remaining: Math.max(0, allowance - spent),
			committedAction: sameRound ? String(raw.committedAction ?? "") : "",
		});
	}

	static combatantForActor(actor, { requireActive = false } = {}) {
		const combat = game.combat;
		if (!combat?.started) return null;

		const matches = matchingCombatants(combat, actor);
		if (matches.length === 0) return null;
		const active = combat.combatant;
		if (active && matches.some((entry) => entry.id === active.id)) return active;
		if (!requireActive) return matches.length === 1 ? matches[0] : null;

		throw new Error(localize(
			"This Actor is a Combat participant but it is not currently their turn.",
			"Ten Aktor jest uczestnikiem walki, ale nie jest obecnie jego tura.",
		));
	}

	static actionLock(actor) {
		const combatant = this.combatantForActor(actor, { requireActive: false });
		if (!combatant) return Object.freeze({ locked: false, reason: "" });
		const turn = this.turnState(combatant);
		if (turn.committedAction !== "reload") {
			return Object.freeze({ locked: false, reason: "" });
		}
		return Object.freeze({
			locked: true,
			reason: localize(
				"You cannot perform another action while reloading a weapon this turn.",
				"Nie możesz wykonać innej akcji w tej turze podczas przeładowywania broni.",
			),
		});
	}

	static fireAvailability(actor, weapon) {
		assertRangedWeapon(weapon);
		const runtime = this.runtime(weapon);
		const combatant = this.combatantForActor(actor, { requireActive: true });
		const turn = this.turnState(combatant, weapon);
		const lock = this.actionLock(actor);
		const magazineEmpty = runtime.magazineCapacity > 0 &&
			runtime.magazineRemaining <= 0;
		const boundToOtherWeapon = Boolean(
			turn.weaponUuid &&
			turn.weaponUuid !== weapon.uuid &&
			turn.spent > 0,
		);

		let reason = "";
		if (lock.locked) reason = lock.reason;
		else if (runtime.reloadRemaining > 0) {
			reason = localize(
				`Reloading: ${runtime.reloadRemaining} round(s) remain.`,
				`Przeładowanie: pozostało ${runtime.reloadRemaining} rund(y).`,
			);
		} else if (!runtime.readyToFire) {
			reason = localize(
				"The weapon is not ready to fire.",
				"Broń nie jest gotowa do strzału.",
			);
		} else if (magazineEmpty) {
			reason = localize(
				"The weapon magazine is empty.",
				"Magazynek broni jest pusty.",
			);
		} else if (boundToOtherWeapon) {
			reason = localize(
				"The ranged firing pool is already bound to another weapon this turn.",
				"Pula strzałów w tej turze jest już przypisana do innej broni.",
			);
		} else if (turn.remaining <= 0) {
			reason = localize(
				"No ranged shots remain for this weapon this turn.",
				"W tej turze nie pozostały już strzały dla tej broni.",
			);
		}

		return Object.freeze({
			available: !reason,
			reason,
			runtime,
			turn,
			combatant,
		});
	}

	static reloadAvailability(actor, weapon) {
		assertRangedWeapon(weapon);
		const runtime = this.runtime(weapon);
		const combatant = this.combatantForActor(actor, { requireActive: true });
		const turn = this.turnState(combatant, weapon);
		const lock = this.actionLock(actor);
		let reason = "";

		if (lock.locked) reason = lock.reason;
		else if (runtime.reloadRounds <= 0) {
			reason = localize(
				"This weapon does not require a separate reload round.",
				"Ta broń nie wymaga osobnej rundy przeładowania.",
			);
		} else if (runtime.readyToFire && runtime.reloadRemaining === 0) {
			reason = localize(
				"The weapon is already ready to fire.",
				"Broń jest już gotowa do strzału.",
			);
		}

		return Object.freeze({
			available: !reason,
			reason,
			runtime,
			turn,
			combatant,
		});
	}

	static canUserAdjudicate(weapon, user = game.user) {
		const actor = weapon?.actor ?? weapon?.parent;
		return actor?.documentName === "Actor" &&
			ActorOwnerEditPermission.canEdit(actor, user);
	}

	static async editRuntime(weapon, patch) {
		assertRangedWeapon(weapon);
		return requestAuthorized("edit", weapon, { patch });
	}

	static async reload(actor, weapon) {
		assertRangedWeapon(weapon);
		if (weapon.parent?.uuid !== actor?.uuid) {
			throw new Error("The selected ranged weapon is not owned by this Actor.");
		}
		return requestAuthorized("reload", weapon, {});
	}

	static async commit(action, weapon, payload, requestingUser) {
		assertRangedWeapon(weapon);
		if (!game.user?.isGM) {
			throw new Error("Ranged runtime commits require GM authority.");
		}

		const actor = weapon.actor ?? weapon.parent;
		if (actor?.documentName !== "Actor") {
			throw new Error("Ranged runtime state requires an Actor-owned Weapon.");
		}

		if (action === "edit") {
			if (!this.canUserAdjudicate(weapon, requestingUser)) {
				throw new Error(localize(
					"Manual ranged-state editing is locked by the GM.",
					"Ręczna edycja stanu broni dystansowej jest zablokowana przez MG.",
				));
			}
			return this.#commitEdit(weapon, payload?.patch ?? {});
		}

		if (action === "reload") {
			assertGameplayControl(actor, requestingUser);
			return this.#commitReload(actor, weapon);
		}

		throw new Error(`Unknown ranged-state action '${String(action)}'.`);
	}

	static async #commitEdit(weapon, patch) {
		const current = this.runtime(weapon);
		const automatic = this.automaticCountdownEnabled();
		const maxCounter = current.reloadRounds + (automatic ? 1 : 0);
		const next = {
			readyToFire: Object.hasOwn(patch, "readyToFire")
				? patch.readyToFire === true
				: current.readyToFire,
			reloadRemaining: Object.hasOwn(patch, "reloadRemaining")
				? clampInteger(patch.reloadRemaining, 0, maxCounter)
				: current.reloadRemaining,
			magazineRemaining: current.magazineCapacity > 0
				? (Object.hasOwn(patch, "magazineRemaining")
					? clampInteger(
						patch.magazineRemaining,
						0,
						current.magazineCapacity,
					)
					: current.magazineRemaining)
				: null,
			updatedBy: String(game.user?.id ?? ""),
			updatedAt: Date.now(),
		};
		await weapon.setFlag(FLAG_SCOPE, ITEM_FLAG_KEY, next);
		return this.runtime(weapon);
	}

	static async #commitReload(actor, weapon) {
		const availability = this.reloadAvailability(actor, weapon);
		if (!availability.available) throw new Error(availability.reason);

		const before = availability.runtime;
		const automatic = this.automaticCountdownEnabled();
		const workBefore = before.reloadRemaining > 0
			? before.reloadRemaining
			: before.reloadRounds;
		/*
		 * Manual mode spends the Reload action immediately: one click is one full
		 * preparation round. Automatic mode performs its single decrement only at
		 * end of turn, so the action merely commits the turn and initializes any
		 * missing counter. This avoids decrementing twice in automatic mode.
		 */
		const remaining = automatic
			? workBefore
			: Math.max(0, workBefore - 1);
		await weapon.setFlag(FLAG_SCOPE, ITEM_FLAG_KEY, {
			readyToFire: automatic ? false : remaining === 0,
			reloadRemaining: remaining,
			magazineRemaining: before.magazineRemaining,
			updatedBy: String(game.user?.id ?? ""),
			updatedAt: Date.now(),
		});

		if (availability.combatant) {
			const combatant = availability.combatant;
			const round = nonNegativeInteger(combatant.parent?.round);
			await combatant.setFlag(FLAG_SCOPE, COMBATANT_FLAG_KEY, {
				round,
				weaponUuid: String(weapon.uuid ?? ""),
				allowance: before.shotsPerFireRound,
				spent: 0,
				committedAction: "reload",
				updatedBy: String(game.user?.id ?? ""),
				updatedAt: Date.now(),
			});
		}

		return Object.freeze({
			runtime: this.runtime(weapon),
			turn: this.turnState(availability.combatant, weapon),
		});
	}

	/** Reserved for the firing transaction wired in the next ranged-combat step. */
	static async commitShot(actor, weapon, requestingUser = game.user) {
		if (!game.user?.isGM) {
			throw new Error("Ranged shot commits require GM authority.");
		}
		assertGameplayControl(actor, requestingUser);
		const availability = this.fireAvailability(actor, weapon);
		if (!availability.available) throw new Error(availability.reason);

		const combatant = availability.combatant;
		if (combatant) {
			const turn = availability.turn;
			await combatant.setFlag(FLAG_SCOPE, COMBATANT_FLAG_KEY, {
				round: turn.round,
				weaponUuid: String(weapon.uuid ?? ""),
				allowance: turn.allowance,
				spent: turn.spent + 1,
				committedAction: "",
				updatedBy: String(game.user?.id ?? ""),
				updatedAt: Date.now(),
			});
		}

		const runtime = availability.runtime;
		const magazineRemaining = runtime.magazineCapacity > 0
			? Math.max(0, runtime.magazineRemaining - 1)
			: null;
		await weapon.setFlag(FLAG_SCOPE, ITEM_FLAG_KEY, {
			readyToFire: runtime.reloadRounds === 0,
			reloadRemaining: runtime.reloadRounds === 0
				? 0
				: runtime.reloadRounds + (this.automaticCountdownEnabled() ? 1 : 0),
			magazineRemaining,
			updatedBy: String(game.user?.id ?? ""),
			updatedAt: Date.now(),
		});

		return this.fireAvailability(actor, weapon);
	}
}

Hooks.once("init", () => {
	game.settings.register(game.system.id, SETTING_KEY, {
		name: localize(
			"Automatic ranged reload countdown",
			"Automatyczne odliczanie przeładowania broni dystansowej",
		),
		hint: localize(
			"When enabled, ranged reload counters are decremented automatically at the end of the Combatant's turn. Disabled by default; manual Reload actions are the canonical workflow.",
			"Po włączeniu liczniki przeładowania broni dystansowej są automatycznie zmniejszane na końcu tury uczestnika. Domyślnie wyłączone; podstawowym trybem jest jawna akcja Przeładuj.",
		),
		scope: "world",
		config: true,
		type: Boolean,
		default: false,
	});
});

Hooks.once("ready", () => registerSocket());

Hooks.on("preUpdateCombat", (combat, changes) => {
	if (!CombatRangedState.automaticCountdownEnabled()) return;
	if (!Object.hasOwn(changes ?? {}, "turn") && !Object.hasOwn(changes ?? {}, "round")) return;
	const current = combat.combatant;
	if (current?.id) endingCombatants.set(String(combat.id), String(current.id));
});

Hooks.on("updateCombat", (combat, changes) => {
	if (!CombatRangedState.automaticCountdownEnabled()) return;
	if (!Object.hasOwn(changes ?? {}, "turn") && !Object.hasOwn(changes ?? {}, "round")) return;
	if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;
	const previousId = endingCombatants.get(String(combat.id));
	endingCombatants.delete(String(combat.id));
	if (!previousId) return;
	const combatant = combat.combatants?.get(previousId);
	if (!combatant?.actor) return;
	void decrementAutomaticReloads(combatant.actor);
});

async function decrementAutomaticReloads(actor) {
	for (const weapon of actor.items ?? []) {
		if (weapon?.type !== "weapon" || weapon.system?.kind !== WEAPON_KIND.RANGED) continue;
		const runtime = CombatRangedState.runtime(weapon);
		if (runtime.reloadRemaining <= 0) continue;
		const remaining = Math.max(0, runtime.reloadRemaining - 1);
		await weapon.setFlag(FLAG_SCOPE, ITEM_FLAG_KEY, {
			readyToFire: remaining === 0,
			reloadRemaining: remaining,
			magazineRemaining: runtime.magazineRemaining,
			updatedBy: String(game.user?.id ?? ""),
			updatedAt: Date.now(),
		});
	}
}

async function requestAuthorized(action, weapon, payload) {
	const actor = weapon?.actor ?? weapon?.parent;
	if (actor?.documentName !== "Actor") {
		throw new Error("Ranged runtime state requires an Actor-owned Weapon.");
	}

	if (game.user?.isGM) {
		return CombatRangedState.commit(action, weapon, payload, game.user);
	}

	if (action === "edit" && !CombatRangedState.canUserAdjudicate(weapon, game.user)) {
		throw new Error(localize(
			"Manual ranged-state editing is locked by the GM.",
			"Ręczna edycja stanu broni dystansowej jest zablokowana przez MG.",
		));
	}
	if (action === "reload") assertGameplayControl(actor, game.user);

	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to update ranged weapon state.",
			"MG musi być połączony, aby zmienić stan broni dystansowej.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Ranged-state request timed out."));
		}, SOCKET_TIMEOUT_MS);
		pendingRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user.id),
			weaponUuid: String(weapon.uuid ?? ""),
			action,
			payload: foundry.utils.deepClone(payload ?? {}),
		});
	});
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (message) => {
		if (!message || typeof message !== "object") return;
		if (message.type === SOCKET_RESPONSE_TYPE) {
			handleSocketResponse(message);
			return;
		}
		if (message.type !== SOCKET_REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: SOCKET_RESPONSE_TYPE,
			requestId: String(message.requestId ?? ""),
			requestUserId: String(message.requestUserId ?? ""),
		};
		try {
			const user = game.users?.get(String(message.requestUserId ?? ""));
			if (!user?.active) throw new Error("Requesting user is not active.");
			const weapon = await globalThis.fromUuid(String(message.weaponUuid ?? ""));
			if (weapon?.documentName !== "Item") throw new Error("Requested Weapon is unavailable.");
			response.result = await CombatRangedState.commit(
				String(message.action ?? ""),
				weapon,
				message.payload ?? {},
				user,
			);
		} catch (error) {
			response.error = error instanceof Error ? error.message : String(error);
		}
		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleSocketResponse(message) {
	if (String(message.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
	const requestId = String(message.requestId ?? "");
	const pending = pendingRequests.get(requestId);
	if (!pending) return;
	clearTimeout(pending.timeout);
	pendingRequests.delete(requestId);
	if (message.error) pending.reject(new Error(String(message.error)));
	else pending.resolve(message.result ?? null);
}

function matchingCombatants(combat, actor) {
	const exact = [...(combat?.combatants ?? [])].filter(
		(combatant) => combatant.actor?.uuid === actor?.uuid,
	);
	if (exact.length) return exact;
	const sameId = [...(combat?.combatants ?? [])].filter(
		(combatant) => combatant.actor?.id && actor?.id && combatant.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId : [];
}

function assertRangedWeapon(weapon) {
	if (!(weapon instanceof foundry.documents.Item) || weapon.type !== "weapon") {
		throw new TypeError("Ranged state requires a Weapon Item.");
	}
	if (weapon.system?.kind !== WEAPON_KIND.RANGED) {
		throw new Error("Ranged state is available only for ranged/thrown weapons.");
	}
}

function assertGameplayControl(actor, user) {
	if (!user) throw new Error("A user is required for ranged actions.");
	if (user.isGM) return;
	const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	if (actor?.testUserPermission?.(user, owner) === true) return;
	throw new Error(localize(
		"Only the GM or an OWNER of this Actor may perform the ranged action.",
		"Tylko MG lub WŁAŚCICIEL tego Aktora może wykonać tę akcję dystansową.",
	));
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function clampInteger(value, min, max) {
	const number = Number(value);
	const integer = Number.isFinite(number) ? Math.trunc(number) : min;
	return Math.min(max, Math.max(min, integer));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
