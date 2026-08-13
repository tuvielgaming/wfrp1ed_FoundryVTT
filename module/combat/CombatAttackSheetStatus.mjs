import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ECONOMY_FLAG_KEY = "attackEconomy";
const OWNER_EDIT_FLAG_KEY = "allowOwnerAttackEdit";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "combat-attack-manual-request";
const SOCKET_RESPONSE_TYPE = "combat-attack-manual-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRequests = new Map();

/**
 * Classic-sheet presentation and explicit GM adjudication for the temporary
 * Combatant Attacks resource.
 *
 * Actor A remains the permanent allowance. Manual editing is deliberately a
 * current attack-window correction only: it adjusts this Combatant's current
 * `spent` value and never writes future parry debt or permanent Actor A. The
 * next attack window is therefore initialized normally by CombatAttackEconomy.
 */
export class CombatAttackSheetStatus {
	static canUserEdit(combatant, user = game.user) {
		const actor = combatant?.actor;
		if (!actor || !user) return false;
		if (user.isGM) return true;
		if (!isExplicitPlayerOwner(actor, user)) return false;
		return actor.getFlag?.(FLAG_SCOPE, OWNER_EDIT_FLAG_KEY) === true;
	}

	static async setRemaining(combatant, remaining) {
		assertCombatant(combatant);
		const value = normalizedRemaining(
			remaining,
			CombatAttackEconomy.allowance(combatant),
		);

		if (game.user?.isGM) {
			return this.commitRemaining(combatant, value, game.user);
		}

		if (!this.canUserEdit(combatant, game.user)) {
			throw new Error(localize(
				"Manual editing of remaining Attacks is locked by the GM.",
				"Ręczna edycja pozostałych Ataków jest zablokowana przez MG.",
			));
		}

		const gm = primaryActiveGM();
		if (!gm) {
			throw new Error(localize(
				"A GM must be connected to edit remaining Attacks.",
				"MG musi być połączony, aby edytować pozostałe Ataki.",
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
				combatId: String(combatant.parent?.id ?? ""),
				combatantId: String(combatant.id ?? ""),
				remaining: value,
			});
		});
	}

	static async toggleOwnerEdit(actor) {
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only a GM can change the remaining-Attacks edit permission.",
				"Tylko MG może zmienić uprawnienie do edycji pozostałych Ataków.",
			));
		}

		const enabled = actor?.getFlag?.(FLAG_SCOPE, OWNER_EDIT_FLAG_KEY) === true;
		const next = !enabled;
		if (next && explicitPlayerOwners(actor).length === 0) {
			throw new Error(localize(
				`${actor.name} has no explicitly assigned player OWNER. Assign one before enabling manual Attack editing.`,
				`${actor.name} nie ma jawnie przypisanego właściciela-gracza. Przypisz właściciela przed włączeniem ręcznej edycji Ataków.`,
			));
		}

		await actor.setFlag(FLAG_SCOPE, OWNER_EDIT_FLAG_KEY, next);
		return next;
	}

	static decorate(application, element) {
		const actor = application?.document;
		if (
			actor?.documentName !== "Actor" ||
			!element?.querySelector?.(".wfrp1ed-classic-sheet")
		) return;

		const combatant = combatantForActor(actor);
		if (!combatant) return;

		const cell = element.querySelector(
			'.characteristics-row--current [data-characteristic="a"]',
		);
		if (!cell) return;

		const snapshot = CombatAttackEconomy.snapshot(combatant);
		const display = displayState(snapshot);
		const permanent = cell.querySelector(".characteristic-current-profile");
		if (permanent) permanent.hidden = true;

		cell.querySelector("[data-wfrp-current-attacks]")?.remove();
		const wrapper = document.createElement("span");
		wrapper.classList.add("characteristic-current-attacks");
		wrapper.dataset.wfrpCurrentAttacks = "";
		wrapper.title = statusTitle(snapshot, display.projected);

		const editable =
			snapshot.attackWindowOpen &&
			this.canUserEdit(combatant);

		if (editable) {
			const input = document.createElement("input");
			input.type = "number";
			input.classList.add("characteristic-current-attacks-input");
			input.value = String(display.value);
			input.min = "0";
			input.max = String(snapshot.allowance);
			input.step = "1";
			input.inputMode = "numeric";
			input.autocomplete = "off";
			input.title = localize(
				"Edit remaining Attacks for this attack window.",
				"Edytuj pozostałe Ataki w tym oknie ataku.",
			);
			input.setAttribute("aria-label", input.title);
			input.addEventListener("change", () => {
				void updateRemaining(combatant, input);
			});
			wrapper.append(input, separator(), maximum(snapshot.allowance));
		} else {
			const value = document.createElement("span");
			value.classList.add("characteristic-current-attacks-readonly");
			value.textContent = `${display.value}/${snapshot.allowance}`;
			wrapper.append(value);
		}

		if (game.user?.isGM) wrapper.append(permissionButton(actor));
		cell.append(wrapper);
	}

	/** GM-authoritative commit used by direct GM edits and socket requests. */
	static async commitRemaining(combatant, remaining, requestingUser) {
		assertCombatant(combatant);
		if (!this.canUserEdit(combatant, requestingUser)) {
			throw new Error(localize(
				"This user is not allowed to edit remaining Attacks.",
				"Ten użytkownik nie może edytować pozostałych Ataków.",
			));
		}
		if (!game.user?.isGM) {
			throw new Error("Manual Attack economy commits require GM authority.");
		}

		const snapshot = CombatAttackEconomy.snapshot(combatant);
		if (!snapshot.attackWindowOpen) {
			throw new Error(localize(
				"Remaining Attacks can only be edited during this Combatant's active attack window.",
				"Pozostałe Ataki można edytować tylko podczas aktywnego okna ataku tego uczestnika.",
			));
		}

		const desired = normalizedRemaining(remaining, snapshot.allowance);
		const raw = combatant.getFlag(FLAG_SCOPE, ECONOMY_FLAG_KEY) ?? {};
		const state = {
			round: nonNegativeInteger(raw.round ?? snapshot.round),
			spent: snapshot.allowance - desired,
			parryDebt: nonNegativeInteger(raw.parryDebt),
			parriesThisRound: nonNegativeInteger(raw.parriesThisRound),
			turnStarted: true,
			turnCompleted: false,
		};

		await combatant.update({
			[`flags.${FLAG_SCOPE}.${ECONOMY_FLAG_KEY}`]: state,
		});
		return CombatAttackEconomy.snapshot(combatant);
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
	if (!ownerEditPermissionChanged(changes)) return;
	void refreshActorSheet(actor);
});

async function updateRemaining(combatant, input) {
	try {
		const raw = String(input?.value ?? "").trim();
		const requested = raw === "" || raw === "+" || raw === "-" ? 0 : Number(raw);
		if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
			throw new Error(localize(
				"Enter a whole number of remaining Attacks.",
				"Wprowadź całkowitą liczbę pozostałych Ataków.",
			));
		}

		const allowance = CombatAttackEconomy.allowance(combatant);
		const value = Math.min(allowance, Math.max(0, requested));
		if (value !== requested) {
			input.value = String(value);
			ui.notifications.warn(localize(
				`Remaining Attacks must be between 0 and A (${allowance}). The value was set to ${value}.`,
				`Pozostałe Ataki muszą mieścić się w zakresie od 0 do A (${allowance}). Wartość ustawiono na ${value}.`,
			));
		}

		await CombatAttackSheetStatus.setRemaining(combatant, value);
		input.value = String(value);
	} catch (error) {
		console.error("WFRP1ED | Unable to edit remaining Attacks.", error);
		ui.notifications.error(error?.message ?? String(error));
		input.value = String(displayState(CombatAttackEconomy.snapshot(combatant)).value);
	}
}

function permissionButton(actor) {
	const enabled = actor.getFlag?.(FLAG_SCOPE, OWNER_EDIT_FLAG_KEY) === true;
	const button = document.createElement("button");
	button.type = "button";
	button.classList.add(
		"characteristic-current-attacks-permission",
		enabled ? "is-enabled" : "is-locked",
	);
	button.title = enabled
		? localize(
			"Player owner may edit temporary Attacks — click to lock player editing.",
			"Właściciel-gracz może edytować tymczasowe Ataki — kliknij, aby zablokować edycję gracza.",
		)
		: localize(
			"Player editing is locked — click to let the player owner edit temporary Attacks.",
			"Edycja gracza jest zablokowana — kliknij, aby pozwolić właścicielowi-graczowi edytować tymczasowe Ataki.",
		);
	button.setAttribute("aria-label", button.title);
	button.setAttribute("aria-pressed", String(enabled));
	const icon = document.createElement("i");
	icon.className = enabled ? "fa-solid fa-lock-open" : "fa-solid fa-lock";
	button.append(icon);
	button.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		try {
			await CombatAttackSheetStatus.toggleOwnerEdit(actor);
		} catch (error) {
			console.error("WFRP1ED | Unable to change Attack edit permission.", error);
			ui.notifications.warn(error?.message ?? String(error));
		}
	});
	return button;
}

function displayState(snapshot) {
	if (snapshot.turnCompleted) {
		return {
			value: snapshot.projectedNextTurnAttacks,
			projected: true,
		};
	}
	return {
		value: snapshot.turnStarted
			? snapshot.currentAttackRemaining
			: snapshot.projectedNextTurnAttacks,
		projected: false,
	};
}

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started) return null;

	const active = combat.combatant;
	if (
		active?.actor?.uuid === actor.uuid ||
		(active?.actor?.id && active.actor.id === actor.id)
	) return active;

	const exact = [...combat.combatants].filter(
		(combatant) => combatant.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];

	const sameActorId = [...combat.combatants].filter(
		(combatant) => combatant.actor?.id && combatant.actor.id === actor.id,
	);
	return sameActorId.length === 1 ? sameActorId[0] : null;
}

function statusTitle(snapshot, projected) {
	const lines = [
		projected
			? localize(
				`Next attack window: ${snapshot.projectedNextTurnAttacks}/${snapshot.allowance}`,
				`Następne okno ataku: ${snapshot.projectedNextTurnAttacks}/${snapshot.allowance}`,
			)
			: localize(
				`Remaining Attacks: ${snapshot.remaining}/${snapshot.allowance}`,
				`Pozostałe Ataki: ${snapshot.remaining}/${snapshot.allowance}`,
			),
		localize(
			`Projected next turn: ${snapshot.projectedNextTurnAttacks}/${snapshot.allowance}`,
			`Prognoza na następną turę: ${snapshot.projectedNextTurnAttacks}/${snapshot.allowance}`,
		),
		localize(
			`Parry debt: ${snapshot.parryDebt}`,
			`Dług za parowanie: ${snapshot.parryDebt}`,
		),
	];
	return lines.join("\n");
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
			if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
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
			const combat = game.combats?.get(String(payload.combatId ?? ""));
			const combatant = combat?.combatants?.get(String(payload.combatantId ?? ""));
			const user = game.users?.get(String(payload.requestUserId ?? ""));
			if (!combatant) throw new Error("Requested Combatant is not available.");
			if (!user?.active) throw new Error("Requesting user is not active.");
			response.result = await CombatAttackSheetStatus.commitRemaining(
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

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isExplicitPlayerOwner(actor, user) {
	if (!actor || !user || user.isGM) return false;
	const ownership = actor.ownership ?? actor._source?.ownership ?? {};
	return Number(ownership?.[user.id]) === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
}

function explicitPlayerOwners(actor) {
	return [...(game.users ?? [])].filter((user) => isExplicitPlayerOwner(actor, user));
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

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function attackEconomyChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${ECONOMY_FLAG_KEY}`;
	return Object.hasOwn(changes, path) || foundry.utils.getProperty(changes, path) !== undefined;
}

function ownerEditPermissionChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${OWNER_EDIT_FLAG_KEY}`;
	return Object.hasOwn(changes, path) || foundry.utils.getProperty(changes, path) !== undefined;
}

async function refreshActorSheet(actor) {
	if (!actor?.sheet?.rendered) return;
	try {
		await actor.sheet.render();
	} catch (error) {
		console.error("WFRP1ED | Unable to refresh Attack status on Actor sheet.", error);
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
