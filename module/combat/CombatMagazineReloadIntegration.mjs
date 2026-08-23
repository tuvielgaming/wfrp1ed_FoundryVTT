import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { AmmunitionInventory } from "../inventory/AmmunitionInventory.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MAGAZINE_FLAG_KEY = "rangedMagazineReload";
const RANGED_RUNTIME_FLAG_KEY = "rangedRuntime";
const TURN_FLAG_KEY = "rangedTurnState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "combat-magazine-reload-request";
const RESPONSE_TYPE = "combat-magazine-reload-response";
const TIMEOUT_MS = 10000;

const pending = new Map();
const endingCombatants = new Map();
let installed = false;

Hooks.once("init", () => install());
Hooks.once("ready", () => registerSocket());

function install() {
	if (installed) return;
	installed = true;

	const originalRuntime = CombatRangedState.runtime.bind(CombatRangedState);
	const originalActionLock = CombatRangedState.actionLock.bind(CombatRangedState);
	const originalFireAvailability = CombatRangedState.fireAvailability.bind(CombatRangedState);
	const originalReloadAvailability = CombatRangedState.reloadAvailability.bind(CombatRangedState);
	const originalCommitShot = CombatRangedState.commitShot.bind(CombatRangedState);

	CombatRangedState.runtime = function runtimeWithMagazineReload(weapon) {
		const base = originalRuntime(weapon);
		const raw = magazineState(weapon);
		return Object.freeze({
			...base,
			magazineReloadRemaining: clamp(raw.remaining, 0, base.magazineReloadRounds),
			magazineReloadSourceUuid: String(raw.sourceUuid ?? ""),
			magazineVariant: raw.variant && typeof raw.variant === "object"
				? foundry.utils.deepClone(raw.variant)
				: null,
		});
	};

	CombatRangedState.actionLock = function actionLockWithMagazine(actor) {
		const combatant = this.combatantForActor(actor, { requireActive: false });
		if (combatant) {
			const turn = this.turnState(combatant);
			if (turn.committedAction === "magazineReload") {
				return Object.freeze({
					locked: true,
					reason: localize(
						"You cannot perform another action while refilling the weapon magazine this turn.",
						"Nie możesz wykonać innej akcji w tej turze podczas przeładowywania magazynka.",
					),
				});
			}
		}
		return originalActionLock(actor);
	};

	CombatRangedState.fireAvailability = function fireAvailabilityWithMagazine(actor, weapon) {
		const result = originalFireAvailability(actor, weapon);
		const runtime = this.runtime(weapon);
		if (runtime.magazineReloadRemaining > 0) {
			return Object.freeze({
				...result,
				available: false,
				reason: localize(
					`Magazine reload in progress: ${runtime.magazineReloadRemaining} round(s) remain.`,
					`Trwa przeładowywanie magazynka: pozostało ${runtime.magazineReloadRemaining} rund(y).`,
				),
				runtime,
			});
		}

		/* Preserve the authoritative ranged-action reason before asking whether
		 * ammunition is accessible. Once the firing allowance is spent (or the
		 * weapon is otherwise not ready), inventory state is secondary and must
		 * not replace the more useful "no shots remain this turn" explanation. */
		if (!result.available) {
			return Object.freeze({ ...result, runtime });
		}

		const ammoGate = AmmunitionInventory.fireGate(actor, weapon, runtime);
		if (!ammoGate.allowed) {
			return Object.freeze({
				...result,
				available: false,
				reason: ammoGate.reason,
				runtime,
				ammunition: ammoGate,
			});
		}
		return Object.freeze({ ...result, runtime, ammunition: ammoGate });
	};

	/* The existing ranged launcher decides whether to open its dialog from only
	 * `fireAvailability` and `reloadAvailability`. Expose a magazine refill as a
	 * proxy reload action when ordinary Reload is unavailable, so a repeating
	 * weapon with Reload 0 can still open the same dialog and offer the magazine
	 * checkbox. UI code recognises `magazineProxy` and does not present it as an
	 * ordinary weapon reload. */
	CombatRangedState.reloadAvailability = function reloadAvailabilityWithMagazineProxy(actor, weapon) {
		const base = originalReloadAvailability(actor, weapon);
		if (base.available) return base;
		if (typeof this.magazineReloadAvailability !== "function") return base;
		let magazine;
		try { magazine = this.magazineReloadAvailability(actor, weapon); }
		catch (_error) { return base; }
		if (!magazine.available) return base;
		return Object.freeze({ ...base, available: true, reason: "", magazineProxy: true });
	};

	CombatRangedState.commitShot = async function commitShotWithMagazine(actor, weapon, requestingUser = game.user) {
		const result = await originalCommitShot(actor, weapon, requestingUser);
		const runtime = this.runtime(weapon);
		if (runtime.magazineCapacity > 0 && runtime.magazineRemaining <= 0) {
			await setMagazineState(weapon, { ...magazineState(weapon), variant: null });
		}
		return this.fireAvailability(actor, weapon);
	};

	CombatRangedState.magazineReloadAvailability = function magazineReloadAvailability(actor, weapon) {
		const runtime = this.runtime(weapon);
		const combatant = this.combatantForActor(actor, { requireActive: true });
		const turn = this.turnState(combatant, weapon);
		const lock = this.actionLock(actor);
		let reason = "";
		/* One click represents one complete reload round. Once this turn is
		 * committed, a second click in the same round must not progress the
		 * counter again. On the character's next round CombatRangedState resets the
		 * round-scoped commitment while the Item's magazine counter persists. */
		if (lock.locked) reason = lock.reason;
		else if (runtime.magazineCapacity <= 0 || runtime.magazineReloadRounds <= 0) {
			reason = localize(
				"This weapon does not have a separately refillable magazine.",
				"Ta broń nie ma osobno przeładowywanego magazynka.",
			);
		} else if (runtime.magazineRemaining >= runtime.magazineCapacity && runtime.magazineReloadRemaining <= 0) {
			reason = localize("The magazine is already full.", "Magazynek jest już pełny.");
		}
		return Object.freeze({
			available: !reason,
			reason,
			runtime,
			turn,
			combatant,
		});
	};

	CombatRangedState.reloadMagazine = function reloadMagazine(actor, weapon, { ammunitionUuid = "" } = {}) {
		return dispatch("reload", actor, weapon, { ammunitionUuid });
	};
	CombatRangedState.finishMagazineReload = function finishMagazineReload(actor, weapon) {
		return dispatch("finish", actor, weapon, {});
	};
	CombatRangedState.interruptMagazineReload = function interruptMagazineReload(actor, weapon) {
		return dispatch("interrupt", actor, weapon, {});
	};
}

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
	void decrementMagazineReloads(combatant.actor).catch(reportError);
});

async function decrementMagazineReloads(actor) {
	for (const weapon of actor.items ?? []) {
		if (
			weapon?.type !== "weapon" ||
			weapon.system?.kind !== WEAPON_KIND.RANGED
		) continue;
		const runtime = CombatRangedState.runtime(weapon);
		if (runtime.magazineReloadRemaining <= 0) continue;
		const remaining = runtime.magazineReloadRemaining - 1;
		await setMagazineState(weapon, {
			...magazineState(weapon),
			remaining,
		});
		if (remaining === 0) {
			const completion = await completeMagazineReload(actor, weapon);
			notifyCompletion(weapon, completion);
		}
	}
}

async function dispatch(action, actor, weapon, payload) {
	if (weapon?.parent?.uuid !== actor?.uuid) throw new Error("Magazine reload requires an Actor-owned Weapon.");
	if (game.user?.isGM) return commit(action, actor, weapon, payload, game.user);
	const gm = primaryActiveGM();
	if (!gm) throw new Error(localize("A GM must be connected to change magazine reload state.", "MG musi być połączony, aby zmienić stan przeładowania magazynka."));
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error("Magazine reload request timed out."));
		}, TIMEOUT_MS);
		pending.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user.id),
			actorUuid: String(actor.uuid ?? ""),
			weaponUuid: String(weapon.uuid ?? ""),
			action,
			payload: foundry.utils.deepClone(payload ?? {}),
		});
	});
}

async function commit(action, actor, weapon, payload, requestingUser) {
	if (!game.user?.isGM) throw new Error("Magazine reload commits require GM authority.");
	if (action === "finish" || action === "interrupt") {
		if (!CombatRangedState.canUserAdjudicate(weapon, requestingUser)) {
			throw new Error(localize("Manual magazine adjudication is locked by the GM.", "Ręczne rozstrzyganie magazynka jest zablokowane przez MG."));
		}
	} else {
		assertGameplayControl(actor, requestingUser);
	}

	if (action === "reload") return commitReload(actor, weapon, payload);
	if (action === "finish") {
		const completion = await completeMagazineReload(actor, weapon);
		return { runtime: CombatRangedState.runtime(weapon), completion };
	}
	if (action === "interrupt") {
		await setMagazineState(weapon, {
			...magazineState(weapon),
			remaining: 0,
			sourceUuid: "",
		});
		return { runtime: CombatRangedState.runtime(weapon), interrupted: true };
	}
	throw new Error(`Unknown magazine reload action '${String(action)}'.`);
}

async function commitReload(actor, weapon, payload) {
	const availability = CombatRangedState.magazineReloadAvailability(actor, weapon);
	if (!availability.available) throw new Error(availability.reason);
	const runtime = availability.runtime;
	let state = magazineState(weapon);
	let sourceUuid = String(state.sourceUuid ?? "");

	if (AmmunitionInventory.trackingEnabled() && AmmunitionInventory.requiresExternalAmmunition(weapon)) {
		if (!sourceUuid) sourceUuid = String(payload?.ammunitionUuid ?? "");
		const selected = AmmunitionInventory.accessibleStacks(actor, weapon).find((item) => item.uuid === sourceUuid);
		if (!selected) {
			throw new Error(localize(
				"Choose compatible readily accessible ammunition before reloading the magazine.",
				"Przed przeładowaniem magazynka wybierz zgodną, łatwo dostępną amunicję.",
			));
		}
		const selectedVariant = AmmunitionInventory.ammunitionVariantSnapshot(selected);
		const existingVariantKey = runtime.magazineVariant?.variantKey ||
			runtime.magazineVariant?.uuid ||
			runtime.magazineVariant?.key ||
			"";
		const selectedVariantKey = selectedVariant?.variantKey ||
			selectedVariant?.uuid ||
			selectedVariant?.key ||
			"";
		if (
			runtime.magazineRemaining > 0 &&
			existingVariantKey &&
			selectedVariantKey !== existingVariantKey
		) {
			throw new Error(localize(
				"Mixed ammunition inside one magazine is not supported yet. Refill with the same ammunition variant or empty the magazine first.",
				"Mieszanie różnych odmian amunicji w jednym magazynku nie jest jeszcze obsługiwane. Uzupełnij go tą samą odmianą albo najpierw opróżnij magazynek.",
			));
		}
	}

	const automatic = CombatRangedState.automaticCountdownEnabled();
	const work = runtime.magazineReloadRemaining > 0
		? runtime.magazineReloadRemaining
		: runtime.magazineReloadRounds;
	const remaining = automatic ? work : Math.max(0, work - 1);
	state = {
		...state,
		remaining,
		sourceUuid,
		startedAt: state.startedAt || Date.now(),
		updatedAt: Date.now(),
	};
	await setMagazineState(weapon, state);
	if (availability.combatant) {
		await availability.combatant.setFlag(FLAG_SCOPE, TURN_FLAG_KEY, {
			round: Number(availability.combatant.parent?.round ?? 0),
			weaponUuid: String(weapon.uuid ?? ""),
			allowance: runtime.shotsPerFireRound,
			spent: 0,
			committedAction: "magazineReload",
			updatedBy: String(game.user?.id ?? ""),
			updatedAt: Date.now(),
		});
	}
	let completion = null;
	if (remaining === 0) completion = await completeMagazineReload(actor, weapon);
	return { runtime: CombatRangedState.runtime(weapon), completion };
}

async function completeMagazineReload(actor, weapon) {
	const runtime = CombatRangedState.runtime(weapon);
	const completion = await AmmunitionInventory.completeMagazineRefill(actor, weapon, runtime);
	const rawRuntime = foundry.utils.deepClone(weapon.getFlag?.(FLAG_SCOPE, RANGED_RUNTIME_FLAG_KEY) ?? {});
	rawRuntime.magazineRemaining = completion.magazineRemaining;
	rawRuntime.updatedBy = String(game.user?.id ?? "");
	rawRuntime.updatedAt = Date.now();
	await weapon.setFlag(FLAG_SCOPE, RANGED_RUNTIME_FLAG_KEY, rawRuntime);
	await setMagazineState(weapon, {
		remaining: 0,
		sourceUuid: "",
		variant: completion.loaded > 0 ? completion.variant : runtime.magazineVariant,
		startedAt: 0,
		updatedAt: Date.now(),
	});
	return completion;
}

function notifyCompletion(weapon, completion) {
	if (!completion) return;
	const runtime = CombatRangedState.runtime(weapon);
	if (completion.full) {
		ui.notifications.info(localize(
			`${weapon.name}: magazine reload complete — ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
			`${weapon.name}: przeładowanie magazynka zakończone — ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
		));
		return;
	}
	ui.notifications.warn(localize(
		`${weapon.name}: magazine reload finished, but there was not enough ammunition. Loaded ${completion.loaded}; magazine ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
		`${weapon.name}: przeładowanie magazynka zakończone, ale nie było wystarczającej ilości amunicji. Załadowano ${completion.loaded}; magazynek ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
	));
}

function magazineState(weapon) {
	const raw = weapon.getFlag?.(FLAG_SCOPE, MAGAZINE_FLAG_KEY);
	return raw && typeof raw === "object" ? foundry.utils.deepClone(raw) : {
		remaining: 0,
		sourceUuid: "",
		variant: null,
		startedAt: 0,
		updatedAt: 0,
	};
}

async function setMagazineState(weapon, state) {
	await weapon.setFlag(FLAG_SCOPE, MAGAZINE_FLAG_KEY, state);
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (message) => {
		if (!message || typeof message !== "object") return;
		if (message.type === RESPONSE_TYPE) {
			if (String(message.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
			const entry = pending.get(String(message.requestId ?? ""));
			if (!entry) return;
			pending.delete(String(message.requestId ?? ""));
			clearTimeout(entry.timeout);
			if (message.error) entry.reject(new Error(String(message.error)));
			else entry.resolve(message.result ?? null);
			return;
		}
		if (message.type !== REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;
		const response = {
			type: RESPONSE_TYPE,
			requestId: String(message.requestId ?? ""),
			requestUserId: String(message.requestUserId ?? ""),
		};
		try {
			const user = game.users?.get(String(message.requestUserId ?? ""));
			if (!user?.active) throw new Error("Requesting user is not active.");
			const actor = await foundry.utils.fromUuid(String(message.actorUuid ?? ""));
			const weapon = await foundry.utils.fromUuid(String(message.weaponUuid ?? ""));
			response.result = await commit(String(message.action ?? ""), actor, weapon, message.payload ?? {}, user);
		} catch (error) {
			response.error = error?.message ?? String(error);
		}
		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function assertGameplayControl(actor, user) {
	if (user?.isGM) return;
	const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
	if (actor?.testUserPermission?.(user, owner) === true) return;
	throw new Error(localize(
		"Only the GM or an OWNER of this Actor may perform the magazine reload action.",
		"Tylko MG lub WŁAŚCICIEL tego Aktora może wykonać akcję przeładowania magazynka.",
	));
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function clamp(value, min, max) {
	const number = Number(value);
	const integer = Number.isFinite(number) ? Math.trunc(number) : min;
	return Math.min(max, Math.max(min, integer));
}

function reportError(error) {
	console.error("WFRP1ED | Magazine reload automation failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
