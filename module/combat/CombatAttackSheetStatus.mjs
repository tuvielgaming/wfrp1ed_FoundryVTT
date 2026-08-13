import { ActorOwnerEditPermission } from "../sheets/ActorOwnerEditPermission.mjs";
import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ECONOMY_FLAG_KEY = "attackEconomy";
const ACTOR_REMAINING_FLAG_KEY = "manualAttacksRemaining";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-attack-manual-request";
const SOCKET_RESPONSE_TYPE = "combat-attack-manual-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/**
 * Classic-sheet presentation for current Attacks.
 *
 * Actor A remains the permanent allowance. Outside a started Combat encounter
 * the displayed current value is an explicitly editable Actor-level manual
 * value and attacks never spend it automatically. Inside Combat, the matching
 * Combatant is authoritative and the value is a current-round resource. Manual
 * corrections rewrite only that round's attack state; Combat start/round start
 * still initializes the Combatant from permanent Actor A.
 */
export class CombatAttackSheetStatus {
	static canUserEdit(actor, user = game.user) {
		return ActorOwnerEditPermission.canEdit(actor, user);
	}

	static async setRemaining(actor, combatant, remaining) {
		assertActor(actor);
		const allowance = combatant
			? CombatAttackEconomy.allowance(combatant)
			: allowanceForActor(actor);
		const value = normalizedRemaining(remaining, allowance);

		if (game.user?.isGM) {
			return this.commitRemaining(
				actor,
				combatant,
				value,
				game.user,
			);
		}

		if (!this.canUserEdit(actor, game.user)) {
			throw new Error(localize(
				"Manual editing of Attacks is locked by the GM.",
				"Ręczna edycja Ataków jest zablokowana przez MG.",
			));
		}

		const gm = primaryActiveGM();
		if (!gm) {
			throw new Error(localize(
				"A GM must be connected to edit Attacks.",
				"MG musi być połączony, aby edytować Ataki.",
			));
		}

		const requestId = foundry.utils.randomID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(requestId);
				reject(new Error("Manual Attack adjustment request timed out."));
			}, SOCKET_TIMEOUT_MS);

			pendingRequests.set(requestId, { resolve, reject, timeout });
			game.socket.emit(SOCKET_CHANNEL, {
				type: SOCKET_REQUEST_TYPE,
				requestId,
				requestUserId: String(game.user.id),
				actorUuid: String(actor.uuid ?? ""),
				combatId: String(combatant?.parent?.id ?? ""),
				combatantId: String(combatant?.id ?? ""),
				remaining: value,
			});
		});
	}

	static decorate(application, element) {
		const actor = application?.document;
		if (
			actor?.documentName !== "Actor" ||
			actor.type !== "character" ||
			!element?.querySelector?.(".wfrp1ed-classic-sheet")
		) return;

		const cell = element.querySelector(
			'.characteristics-row--current [data-characteristic="a"]',
		);
		if (!cell) return;

		const combatant = combatantForActor(actor);
		const state = displayState(actor, combatant);
		const permanent = cell.querySelector(".characteristic-current-profile");
		if (permanent) permanent.hidden = true;

		cell.querySelector("[data-wfrp-current-attacks]")?.remove();
		const wrapper = document.createElement("span");
		wrapper.classList.add("characteristic-current-attacks");
		wrapper.dataset.wfrpCurrentAttacks = "";
		wrapper.title = statusTitle(state);

		if (this.canUserEdit(actor)) {
			const input = document.createElement("input");
			input.type = "number";
			input.classList.add("characteristic-current-attacks-input");
			input.value = String(state.remaining);
			input.min = "0";
			input.max = String(state.allowance);
			input.step = "1";
			input.inputMode = "numeric";
			input.autocomplete = "off";
			input.title = state.inCombat
				? localize(
					"Edit remaining Attacks for this Combat round.",
					"Edytuj pozostałe Ataki w tej rundzie walki.",
				)
				: localize(
					"Edit the manual Attacks value used outside Combat Tracker automation.",
					"Edytuj ręczną wartość Ataków używaną poza automatyką Monitora Walki.",
				);
			input.setAttribute("aria-label", input.title);
			input.addEventListener("change", () => {
				void updateRemaining(actor, combatant, input);
			});
			wrapper.append(input, separator(), maximum(state.allowance));
		} else {
			const value = document.createElement("span");
			value.classList.add("characteristic-current-attacks-readonly");
			value.textContent = `${state.remaining}/${state.allowance}`;
			wrapper.append(value);
		}

		cell.append(wrapper);
	}

	/** GM-authoritative commit used by direct GM edits and socket requests. */
	static async commitRemaining(actor, combatant, remaining, requestingUser) {
		assertActor(actor);
		if (!this.canUserEdit(actor, requestingUser)) {
			throw new Error(localize(
				"This user is not allowed to edit Attacks.",
				"Ten użytkownik nie może edytować Ataków.",
			));
		}
		if (!game.user?.isGM) {
			throw new Error("Manual Attack commits require GM authority.");
		}

		if (!combatant) {
			const allowance = allowanceForActor(actor);
			const desired = normalizedRemaining(remaining, allowance);
			await actor.setFlag(FLAG_SCOPE, ACTOR_REMAINING_FLAG_KEY, desired);
			return displayState(actor, null);
		}

		assertCombatant(combatant);
		if (!sameActor(combatant.actor, actor)) {
			throw new Error("The Combatant does not belong to the requested Actor.");
		}

		const snapshot = CombatAttackEconomy.snapshot(combatant);
		const desired = normalizedRemaining(remaining, snapshot.allowance);
		const raw = combatant.getFlag(FLAG_SCOPE, ECONOMY_FLAG_KEY) ?? {};
		const state = {
			...raw,
			round: nonNegativeInteger(raw.round ?? snapshot.round),
			spent: nonNegativeInteger(raw.spent ?? snapshot.spent),
			parryDebt: nonNegativeInteger(raw.parryDebt ?? snapshot.parryDebt),
			parriesThisRound: nonNegativeInteger(
				raw.parriesThisRound ?? snapshot.parriesThisRound,
			),
			turnStarted: raw.turnStarted === true,
			turnCompleted: raw.turnCompleted === true,
		};

		if (state.turnStarted) {
			state.spent = snapshot.allowance - desired;
		} else {
			/*
			 * Before the Combatant's turn, spent + parryDebt together determine
			 * what will remain when the attack window opens. Preserve real debt when
			 * a manual correction merely lowers A further; an explicit increase may
			 * override debt because the GM is deliberately adjudicating the resource.
			 */
			const targetPenalty = snapshot.allowance - desired;
			if (state.parryDebt <= targetPenalty) {
				state.spent = targetPenalty - state.parryDebt;
			} else {
				state.parryDebt = targetPenalty;
				state.spent = 0;
			}
		}

		await combatant.update({
			[`flags.${FLAG_SCOPE}.${ECONOMY_FLAG_KEY}`]: state,
		});
		return displayState(actor, combatant);
	}
}

Hooks.once("init", () => {
	if (!game.WFRP1ED) return;
	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		combat: Object.freeze({
			...(game.WFRP1ED.combat ?? {}),
			attackSheetStatus: CombatAttackSheetStatus,
		}),
	});
});

Hooks.once("ready", () => registerSocket());

Hooks.on("renderApplicationV2", (application, element) => {
	CombatAttackSheetStatus.decorate(application, element);
});

Hooks.on("updateCombatant", (combatant, changes) => {
	if (!attackEconomyChanged(changes)) return;
	void refreshActorSheet(combatant?.actor);
});

Hooks.on("updateActor", (actor, changes) => {
	if (!actorManualAttacksChanged(changes)) return;
	void refreshActorSheet(actor);
});

async function updateRemaining(actor, combatant, input) {
	try {
		const raw = String(input?.value ?? "").trim();
		const requested = raw === "" || raw === "+" || raw === "-"
			? 0
			: Number(raw);
		if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
			throw new Error(localize(
				"Enter a whole number of remaining Attacks.",
				"Wprowadź całkowitą liczbę pozostałych Ataków.",
			));
		}

		const allowance = combatant
			? CombatAttackEconomy.allowance(combatant)
			: allowanceForActor(actor);
		const value = Math.min(allowance, Math.max(0, requested));
		if (value !== requested) {
			input.value = String(value);
			ui.notifications.warn(localize(
				`Remaining Attacks must be between 0 and A (${allowance}). The value was set to ${value}.`,
				`Pozostałe Ataki muszą mieścić się w zakresie od 0 do A (${allowance}). Wartość ustawiono na ${value}.`,
			));
		}

		await CombatAttackSheetStatus.setRemaining(
			actor,
			combatant,
			value,
		);
		input.value = String(value);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit remaining Attacks.", error);
		ui.notifications.error(error?.message ?? String(error));
		input.value = String(displayState(actor, combatant).remaining);
	}
}

function displayState(actor, combatant) {
	if (!combatant) {
		const allowance = allowanceForActor(actor);
		const stored = Number(actor.getFlag?.(FLAG_SCOPE, ACTOR_REMAINING_FLAG_KEY));
		const remaining = Number.isFinite(stored) && Number.isInteger(stored)
			? Math.min(allowance, Math.max(0, stored))
			: allowance;
		return Object.freeze({
			inCombat: false,
			allowance,
			remaining,
			round: 0,
			parryDebt: 0,
		});
	}

	const snapshot = CombatAttackEconomy.snapshot(combatant);
	const debtThisWindow = snapshot.turnStarted
		? 0
		: Math.min(snapshot.allowance, snapshot.parryDebt);
	const remaining = Math.min(
		snapshot.allowance,
		Math.max(0, snapshot.allowance - snapshot.spent - debtThisWindow),
	);
	return Object.freeze({
		inCombat: true,
		allowance: snapshot.allowance,
		remaining,
		round: snapshot.round,
		parryDebt: snapshot.parryDebt,
	});
}

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started) return null;

	const active = combat.combatant;
	if (sameActor(active?.actor, actor)) return active;

	const exact = [...combat.combatants].filter(
		(combatant) => combatant.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];

	const sameId = [...combat.combatants].filter(
		(combatant) =>
			combatant.actor?.id &&
			actor.id &&
			combatant.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function statusTitle(state) {
	if (!state.inCombat) {
		return localize(
			`Manual Attacks outside Combat Tracker: ${state.remaining}/${state.allowance}. Attack rolls do not spend this value automatically.`,
			`Ręczne Ataki poza Monitorem Walki: ${state.remaining}/${state.allowance}. Rzuty ataku nie zużywają tej wartości automatycznie.`,
		);
	}

	const lines = [
		localize(
			`Remaining Attacks this round: ${state.remaining}/${state.allowance}`,
			`Pozostałe Ataki w tej rundzie: ${state.remaining}/${state.allowance}`,
		),
		localize(
			`Combat round: ${state.round}`,
			`Runda walki: ${state.round}`,
		),
	];
	if (state.parryDebt > 0) {
		lines.push(localize(
			`Parry debt: ${state.parryDebt}`,
			`Dług za parowanie: ${state.parryDebt}`,
		));
	}
	return lines.join("\n");
}

function allowanceForActor(actor) {
	const characteristic = actor?.system?.characteristics?.a;
	for (const candidate of [
		characteristic?.current,
		characteristic?.value,
		characteristic,
	]) {
		const numeric = Number(candidate);
		if (Number.isFinite(numeric)) return Math.max(0, Math.trunc(numeric));
	}
	return 0;
}

function separator() {
	const span = document.createElement("span");
	span.classList.add("characteristic-current-attacks-separator");
	span.textContent = "/";
	return span;
}

function maximum(value) {
	const span = document.createElement("span");
	span.classList.add("characteristic-current-attacks-max");
	span.textContent = String(value);
	return span;
}

function registerSocket() {
	game.socket.on(SOCKET_CHANNEL, async (payload) => {
		if (!payload || typeof payload !== "object") return;

		if (payload.type === SOCKET_RESPONSE_TYPE) {
			if (
				String(payload.requestUserId ?? "") !==
				String(game.user?.id ?? "")
			) return;
			const pending = pendingRequests.get(String(payload.requestId ?? ""));
			if (!pending) return;
			clearTimeout(pending.timeout);
			pendingRequests.delete(String(payload.requestId ?? ""));
			if (payload.error) pending.reject(new Error(String(payload.error)));
			else pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
			return;
		}

		if (payload.type !== SOCKET_REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: SOCKET_RESPONSE_TYPE,
			requestId: String(payload.requestId ?? ""),
			requestUserId: String(payload.requestUserId ?? ""),
		};

		try {
			const actor = await actorFromUuid(payload.actorUuid);
			const combat = payload.combatId
				? game.combats?.get(String(payload.combatId))
				: null;
			const combatant = payload.combatantId
				? combat?.combatants?.get(String(payload.combatantId))
				: null;
			const user = game.users?.get(String(payload.requestUserId ?? ""));
			if (!actor) throw new Error("Requested Actor is not available.");
			if (!user?.active) throw new Error("Requesting user is not active.");
			response.result = await CombatAttackSheetStatus.commitRemaining(
				actor,
				combatant,
				payload.remaining,
				user,
			);
		} catch (error) {
			response.error = error instanceof Error ? error.message : String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

async function actorFromUuid(uuid) {
	const id = String(uuid ?? "").trim();
	if (!id) return null;
	try {
		const document = await globalThis.fromUuid(id);
		return document?.documentName === "Actor" ? document : document?.actor ?? null;
	} catch (_error) {
		return null;
	}
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function sameActor(first, second) {
	if (!first || !second) return false;
	if (first.uuid && second.uuid && first.uuid === second.uuid) return true;
	return Boolean(first.id && second.id && first.id === second.id);
}

function normalizedRemaining(value, allowance) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
		throw new Error("Remaining Attacks must be a finite integer.");
	}
	return Math.min(allowance, Math.max(0, numeric));
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new TypeError("A Foundry Actor is required.");
	}
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function attackEconomyChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${ECONOMY_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

function actorManualAttacksChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${ACTOR_REMAINING_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty(changes, path) !== undefined;
}

async function refreshActorSheet(actor) {
	if (!actor?.sheet?.rendered) return;
	try {
		await actor.sheet.render();
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to refresh Attack status on Actor sheet.",
			error,
		);
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
