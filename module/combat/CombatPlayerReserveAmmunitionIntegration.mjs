import { GMGameplayNotice } from "../chat/GMGameplayNotice.mjs";
import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { AmmunitionInventory } from "../inventory/AmmunitionInventory.mjs";
import { WfrpCheckbox } from "../ui/WfrpCheckbox.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatRangedAttackResolution } from "./CombatRangedAttackResolution.mjs";
import { CombatRangedFireTransaction } from "./CombatRangedFireTransaction.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

const ACCESS_MODE = "reserve-adjudicated";
const SOCKET_CHANNEL = "system.wfrp1ed";
const FIRE_REQUEST_TYPE = "player-reserve-ammunition-fire-request";
const FIRE_RESPONSE_TYPE = "player-reserve-ammunition-fire-response";
const NOTICE_REQUEST_TYPE = "player-reserve-ammunition-notice-request";
const SOCKET_TIMEOUT_MS = 10000;

const reserveModeByWeapon = new Map();
const activeReserveShots = new Map();
const launcherBypassBudget = new Map();
const pendingFireRequests = new Map();

let executeBeforeGmReserveIntegration = null;
let installed = false;
let socketRegistered = false;

/*
 * Load-order contract:
 *
 * system.json loads this module after CombatRangedAmmunitionIntegration and
 * before CombatReserveAmmunitionAdjudicationIntegration. During init the normal
 * ammunition integration has therefore already wrapped ranged resolution, but
 * the GM-only reserve layer has not. Keep that pre-GM-reserve execution path so
 * a player reserve shot can use the verified ammunition deduction/provenance
 * layer without tripping the older GM-local guard.
 */
Hooks.once("init", () => {
	executeBeforeGmReserveIntegration = CombatRangedAttackResolution.execute.bind(
		CombatRangedAttackResolution,
	);
});

/* Install after all init wrappers, so these player-facing guards sit outside the
 * existing GM reserve implementation without changing its verified behavior. */
Hooks.once("setup", () => install());
Hooks.once("ready", () => registerSocket());
Hooks.on("renderApplicationV2", (_application, element) => {
	decoratePlayerReserveAdjudication(element);
});

function install() {
	if (installed) return;
	installed = true;

	wrapAttackConfiguration();
	wrapRangedLauncher();
	wrapFireAvailability();
	wrapSelectedAmmunitionValidation();
	wrapRangedFireTransaction();
	wrapRangedResolution();
}

function wrapAttackConfiguration() {
	const originalConfigure = CombatAttackDialog.configure.bind(CombatAttackDialog);
	CombatAttackDialog.configure = async function configureWithPlayerReserve(actor, weapon) {
		const key = weaponKey(weapon);
		if (key && !game.user?.isGM) reserveModeByWeapon.delete(key);

		const result = await originalConfigure(actor, weapon);
		if (
			game.user?.isGM ||
			!result ||
			weapon?.system?.kind !== WEAPON_KIND.RANGED
		) return result;

		const reserveAdjudicated = key && reserveModeByWeapon.get(key) === true;
		if (key) reserveModeByWeapon.delete(key);
		return Object.freeze({
			...result,
			ammunitionAccessMode: reserveAdjudicated ? ACCESS_MODE : "quick-access",
		});
	};
}

function wrapRangedLauncher() {
	const originalLaunch = CombatAttackLauncher.launch;
	CombatAttackLauncher.launch = async function launchWithPlayerReserve(actor, weapon) {
		if (game.user?.isGM || !canOfferReserveAdjudication(actor, weapon, game.user)) {
			return originalLaunch.call(this, actor, weapon);
		}

		const fire = safeFireAvailability(actor, weapon);
		if (!isReserveOnlyBlock(fire)) {
			return originalLaunch.call(this, actor, weapon);
		}

		/* Let the ordinary lifecycle open a dialog which would otherwise contain
		 * only Cancel. The one-use budget affects local dialog launch only; the GM
		 * later re-validates the actual reserve shot authoritatively. */
		const key = weaponKey(weapon);
		launcherBypassBudget.set(key, 1);
		try {
			return await originalLaunch.call(this, actor, weapon);
		} finally {
			launcherBypassBudget.delete(key);
		}
	};
}

function wrapFireAvailability() {
	const originalFireAvailability = CombatRangedState.fireAvailability.bind(CombatRangedState);
	CombatRangedState.fireAvailability = function fireAvailabilityWithPlayerReserve(actor, weapon) {
		const result = originalFireAvailability(actor, weapon);
		if (result?.available === true) return result;

		const key = weaponKey(weapon);
		const active = activeReserveShots.get(key);
		if (
			active &&
			isReserveOnlyBlock(result) &&
			reserveStack(actor, weapon, active.ammunitionUuid)
		) {
			return allowedReserveResult(result, active.ammunitionUuid, false);
		}

		const budget = Math.max(0, Number(launcherBypassBudget.get(key) ?? 0));
		if (budget > 0 && isReserveOnlyBlock(result)) {
			if (budget <= 1) launcherBypassBudget.delete(key);
			else launcherBypassBudget.set(key, budget - 1);
			return allowedReserveResult(result, "", true);
		}
		return result;
	};
}

function wrapSelectedAmmunitionValidation() {
	const originalValidate = AmmunitionInventory.validateSelectedShot.bind(AmmunitionInventory);
	AmmunitionInventory.validateSelectedShot = function validateSelectedShotWithPlayerReserve(
		actor,
		weapon,
		ammunitionUuid,
	) {
		const active = activeReserveShots.get(weaponKey(weapon));
		if (
			active &&
			String(active.ammunitionUuid ?? "") === String(ammunitionUuid ?? "")
		) {
			const selected = reserveStack(actor, weapon, ammunitionUuid);
			if (selected) return selected;
		}
		return originalValidate(actor, weapon, ammunitionUuid);
	};
}

function wrapRangedFireTransaction() {
	const originalFire = CombatRangedFireTransaction.fire.bind(CombatRangedFireTransaction);
	CombatRangedFireTransaction.fire = async function fireWithPlayerReserve(actor, weapon) {
		const active = activeReserveShots.get(weaponKey(weapon));
		if (!active || !reserveStack(actor, weapon, active.ammunitionUuid)) {
			return originalFire(actor, weapon);
		}

		/* A GM-local reserve shot is still handled by the already verified GM
		 * integration. A player reserve shot is committed on the active GM client
		 * through this module's narrow socket transaction. */
		if (game.user?.isGM) return originalFire(actor, weapon);
		return requestReserveFire(actor, weapon, active.ammunitionUuid);
	};
}

function wrapRangedResolution() {
	const finalExecute = CombatRangedAttackResolution.execute.bind(CombatRangedAttackResolution);
	CombatRangedAttackResolution.execute = async function executeWithPlayerReserve(
		actor,
		weapon,
		configuration,
		targetOptions,
	) {
		if (
			game.user?.isGM ||
			configuration?.ammunitionAccessMode !== ACCESS_MODE
		) {
			return finalExecute(actor, weapon, configuration, targetOptions);
		}
		if (typeof executeBeforeGmReserveIntegration !== "function") {
			throw new Error("Player reserve-ammunition resolution was not initialized correctly.");
		}
		assertReserveCapableWeapon(actor, weapon, game.user);

		const ammunitionUuid = String(configuration?.ammunitionUuid ?? "");
		const selectedReserve = reserveStack(actor, weapon, ammunitionUuid);
		if (!selectedReserve) {
			/* If the selected stack moved into Quick Access after the dialog was
			 * configured, resolve it through the normal verified ammunition path. */
			const nowAccessible = AmmunitionInventory.accessibleStacks(actor, weapon)
				.some((item) => String(item.uuid ?? "") === ammunitionUuid);
			if (nowAccessible) {
				return executeBeforeGmReserveIntegration(
					actor,
					weapon,
					{ ...configuration, ammunitionAccessMode: "quick-access" },
					targetOptions,
				);
			}
			throw new Error(localize(
				"The selected reserve ammunition is no longer available.",
				"Wybrana amunicja zapasowa nie jest już dostępna.",
			));
		}

		const fire = safeFireAvailability(actor, weapon);
		if (!reserveShotAllowed(fire)) {
			throw new Error(String(fire?.reason ?? localize(
				"This ranged shot is not currently allowed.",
				"Ten strzał z broni dystansowej nie jest obecnie dozwolony.",
			)));
		}

		const key = weaponKey(weapon);
		const token = foundry.utils.randomID();
		activeReserveShots.set(key, Object.freeze({ token, ammunitionUuid }));
		try {
			return await executeBeforeGmReserveIntegration(
				actor,
				weapon,
				configuration,
				targetOptions,
			);
		} finally {
			if (activeReserveShots.get(key)?.token === token) activeReserveShots.delete(key);
		}
	};
}

function decoratePlayerReserveAdjudication(root) {
	if (game.user?.isGM) return;
	if (!root?.classList?.contains?.("wfrp1ed-combat-attack-dialog")) return;

	const weaponUuid = String(root.dataset?.wfrpRangedWeaponUuid ?? "");
	const actorUuid = String(root.dataset?.wfrpRangedActorUuid ?? "");
	if (!weaponUuid || !actorUuid) return;
	const weapon = globalThis.fromUuidSync?.(weaponUuid);
	const actor = globalThis.fromUuidSync?.(actorUuid);
	if (!canOfferReserveAdjudication(actor, weapon, game.user)) return;

	const group = root.querySelector("[data-wfrp-ammunition-group]");
	const select = group?.querySelector?.("select[name='wfrpAmmunitionUuid']");
	const label = group?.querySelector?.("span");
	const roll = root.querySelector(
		"footer.form-footer button[data-action='roll'], .form-footer button[data-action='roll']",
	);
	if (!(select instanceof HTMLSelectElement) || !(roll instanceof HTMLButtonElement)) return;

	root.querySelector("[data-wfrp-player-reserve-ammunition-choice]")?.remove();
	const key = weaponKey(weapon);
	reserveModeByWeapon.set(key, false);
	let noticeSent = false;

	const title = localize(
		"Use only after the GM has adjudicated retrieving reserve ammunition. This authorizes one configured shot from the selected compatible reserve stack; the system does not decide retrieval time or complications.",
		"Użyj po rozstrzygnięciu przez MG przygotowania zapasowej amunicji. Zezwala to na jeden skonfigurowany strzał z wybranego zgodnego stosu zapasowego; system nie rozstrzyga czasu ani komplikacji przygotowania.",
	);
	const checkbox = WfrpCheckbox.create({
		name: "wfrpPlayerReserveAmmunitionAdjudicated",
		checked: false,
		title,
		ariaLabel: localize(
			"Use reserve ammunition for this shot after GM adjudication",
			"Użyj zapasowej amunicji dla tego strzału po rozstrzygnięciu MG",
		),
	});
	const choice = checkbox.root;
	choice.classList.add(
		"combat-item-sheet__check",
		"combat-ranged-magazine-choice",
		"combat-ranged-reserve-choice",
	);
	choice.dataset.wfrpPlayerReserveAmmunitionChoice = "";
	const text = document.createElement("span");
	text.textContent = localize(
		"Use reserve ammunition — GM adjudication",
		"Użyj zapasowej amunicji — rozstrzygnięcie MG",
	);
	choice.append(text);
	group.insertAdjacentElement("beforebegin", choice);

	const refillSelect = (items, { reserve = false } = {}) => {
		const previous = String(select.value ?? "");
		select.replaceChildren();
		for (const item of items) {
			const option = document.createElement("option");
			option.value = String(item.uuid ?? "");
			option.textContent = `${item.name} — ${quantity(item)}`;
			select.append(option);
		}
		if (previous && [...select.options].some((option) => option.value === previous)) {
			select.value = previous;
		} else if (select.options.length) {
			select.selectedIndex = 0;
		}
		if (label) {
			label.textContent = reserve
				? localize("Reserve ammunition (GM)", "Amunicja zapasowa (MG)")
				: localize("Ammunition", "Amunicja");
		}
		/* Keep CombatRangedAmmunitionIntegration's selected-ammunition state in
		 * sync after replacing the select options. */
		select.dispatchEvent(new Event("change", { bubbles: true }));
	};

	const refresh = () => {
		const reserveMode = checkbox.input.checked === true;
		reserveModeByWeapon.set(key, reserveMode);
		if (!reserveMode) {
			const fire = safeFireAvailability(actor, weapon);
			roll.disabled = !fire?.available || !select.value;
			roll.title = fire?.available
				? localize("Weapon ready to fire.", "Broń gotowa do strzału.")
				: String(fire?.reason ?? "");
			return;
		}

		const currentReserve = reserveStack(actor, weapon, select.value);
		const fire = safeFireAvailability(actor, weapon);
		const gm = primaryActiveGM();
		const canAdjudicate = Boolean(currentReserve && gm && reserveShotAllowed(fire));
		roll.disabled = !canAdjudicate;
		if (!gm) {
			roll.title = localize(
				"A connected GM is required to authorize a reserve-ammunition shot.",
				"Do strzału z zapasowej amunicji wymagany jest połączony MG.",
			);
		} else {
			roll.title = canAdjudicate
				? localize(
					"GM adjudication: this shot will consume the selected reserve ammunition.",
					"Rozstrzygnięcie MG: ten strzał zużyje wybraną amunicję zapasową.",
				)
				: String(fire?.reason ?? localize(
					"The selected reserve ammunition is unavailable.",
					"Wybrana amunicja zapasowa jest niedostępna.",
				));
		}
	};

	checkbox.input.addEventListener("change", () => {
		const reserveMode = checkbox.input.checked === true;
		reserveModeByWeapon.set(key, reserveMode);
		refillSelect(
			reserveMode
				? AmmunitionInventory.reserveStacks(actor, weapon)
				: AmmunitionInventory.accessibleStacks(actor, weapon),
			{ reserve: reserveMode },
		);
		refresh();

		if (reserveMode && !noticeSent) {
			noticeSent = true;
			if (!sendReserveNoticeRequest(actor, weapon)) {
				ui.notifications.warn(localize(
					"No active GM is available to receive the reserve-ammunition adjudication notice.",
					"Brak aktywnego MG, który mógłby otrzymać komunikat o rozstrzygnięciu zapasowej amunicji.",
				));
			}
		}
	});
	select.addEventListener("change", refresh);

	refresh();
}

function requestReserveFire(actor, weapon, ammunitionUuid) {
	const gm = primaryActiveGM();
	if (!gm) {
		throw new Error(localize(
			"A GM must be connected to authorize a reserve-ammunition shot.",
			"MG musi być połączony, aby zatwierdzić strzał z zapasowej amunicji.",
		));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pendingFireRequests.delete(requestId);
			reject(new Error("Reserve-ammunition fire request timed out."));
		}, SOCKET_TIMEOUT_MS);
		pendingFireRequests.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: FIRE_REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			actorUuid: String(actor?.uuid ?? ""),
			weaponUuid: String(weapon?.uuid ?? ""),
			ammunitionUuid: String(ammunitionUuid ?? ""),
		});
	});
}

function sendReserveNoticeRequest(actor, weapon) {
	if (!primaryActiveGM()) return false;
	game.socket.emit(SOCKET_CHANNEL, {
		type: NOTICE_REQUEST_TYPE,
		requestUserId: String(game.user?.id ?? ""),
		actorUuid: String(actor?.uuid ?? ""),
		weaponUuid: String(weapon?.uuid ?? ""),
	});
	return true;
}

function registerSocket() {
	if (socketRegistered) return;
	socketRegistered = true;
	game.socket.on(SOCKET_CHANNEL, async (message) => {
		if (!message || typeof message !== "object") return;

		if (message.type === FIRE_RESPONSE_TYPE) {
			handleFireResponse(message);
			return;
		}
		if (
			message.type !== FIRE_REQUEST_TYPE &&
			message.type !== NOTICE_REQUEST_TYPE
		) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		if (message.type === NOTICE_REQUEST_TYPE) {
			try {
				const context = await validatedPlayerRequest(message);
				await presentReserveNotice(context.actor, context.weapon, context.user);
			} catch (error) {
				console.error("WFRP1ED | Unable to present player reserve-ammunition notice.", error);
			}
			return;
		}

		const response = {
			type: FIRE_RESPONSE_TYPE,
			requestId: String(message.requestId ?? ""),
			requestUserId: String(message.requestUserId ?? ""),
		};
		try {
			const { user, actor, weapon } = await validatedPlayerRequest(message);
			const ammunitionUuid = String(message.ammunitionUuid ?? "");
			const selectedReserve = reserveStack(actor, weapon, ammunitionUuid);
			if (!selectedReserve) {
				throw new Error(localize(
					"The selected reserve ammunition is no longer available.",
					"Wybrana amunicja zapasowa nie jest już dostępna.",
				));
			}

			const fire = safeFireAvailability(actor, weapon);
			if (!reserveShotAllowed(fire)) {
				throw new Error(String(fire?.reason ?? localize(
					"This ranged shot is not currently allowed.",
					"Ten strzał z broni dystansowej nie jest obecnie dozwolony.",
				)));
			}

			const key = weaponKey(weapon);
			const token = foundry.utils.randomID();
			activeReserveShots.set(key, Object.freeze({ token, ammunitionUuid }));
			try {
				response.result = socketSafeAvailability(
					await CombatRangedState.commitShot(actor, weapon, user),
				);
			} finally {
				if (activeReserveShots.get(key)?.token === token) activeReserveShots.delete(key);
			}
		} catch (error) {
			response.error = error?.message ?? String(error);
		}
		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function handleFireResponse(message) {
	if (String(message.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
	const requestId = String(message.requestId ?? "");
	const pending = pendingFireRequests.get(requestId);
	if (!pending) return;
	pendingFireRequests.delete(requestId);
	clearTimeout(pending.timeout);
	if (message.error) pending.reject(new Error(String(message.error)));
	else pending.resolve(message.result ?? null);
}

async function validatedPlayerRequest(message) {
	const user = game.users?.get(String(message.requestUserId ?? ""));
	if (!user?.active || user.isGM) {
		throw new Error("Reserve-ammunition player request requires an active non-GM user.");
	}

	const weapon = await globalThis.fromUuid(String(message.weaponUuid ?? ""));
	if (weapon?.documentName !== "Item") {
		throw new Error("Requested reserve-ammunition Weapon is unavailable.");
	}
	const actor = weapon.actor ?? weapon.parent;
	if (String(actor?.uuid ?? "") !== String(message.actorUuid ?? "")) {
		throw new Error("Reserve-ammunition Actor/Weapon request does not match.");
	}
	assertReserveCapableWeapon(actor, weapon, user);
	if (!AmmunitionInventory.reserveStacks(actor, weapon).length) {
		throw new Error(localize(
			"No compatible reserve ammunition is available.",
			"Brak zgodnej zapasowej amunicji.",
		));
	}
	return { user, actor, weapon };
}

async function presentReserveNotice(actor, weapon, requestingUser) {
	const accessible = AmmunitionInventory.accessibleStacks(actor, weapon);
	const reserves = AmmunitionInventory.reserveStacks(actor, weapon);
	const reserveText = reserves.length
		? reserves.map((item) => `${item.name} ×${quantity(item)}`).join(", ")
		: localize("none", "brak");
	const accessibility = accessible.length
		? localize(
			"Readily accessible ammunition is also available, but reserve ammunition was selected for this configured shot.",
			"Łatwo dostępna amunicja również jest dostępna, ale dla tego skonfigurowanego strzału wybrano amunicję zapasową.",
		)
		: localize(
			"No compatible ammunition is currently in Quick Access.",
			"W łatwym dostępie nie ma obecnie zgodnej amunicji.",
		);
	const userName = String(requestingUser?.name ?? "").trim();
	const who = userName
		? localize(`Player ${userName} selected reserve ammunition. `, `Gracz ${userName} wybrał zapasową amunicję. `)
		: "";

	return GMGameplayNotice.warn({
		category: "ranged-reserve-ammunition-required",
		title: localize("Reserve ammunition", "Amunicja zapasowa"),
		message: localize(
			`${who}${accessibility} Compatible reserve ammunition: ${reserveText}. The GM decides any retrieval time or complications outside the automatic ammunition rules.`,
			`${who}${accessibility} Zgodna amunicja zapasowa: ${reserveText}. MG rozstrzyga ewentualny czas lub komplikacje jej przygotowania poza automatycznymi zasadami amunicji.`,
		),
		summary: localize(
			"Reserve ammunition selected — GM adjudication required.",
			"Wybrano amunicję zapasową — wymagane rozstrzygnięcie MG.",
		),
		actor,
		item: weapon,
	});
}

function canOfferReserveAdjudication(actor, weapon, user) {
	try {
		assertReserveCapableWeapon(actor, weapon, user);
	} catch (_error) {
		return false;
	}
	return AmmunitionInventory.reserveStacks(actor, weapon).length > 0;
}

function assertReserveCapableWeapon(actor, weapon, user) {
	if (actor?.documentName !== "Actor") {
		throw new Error("Reserve-ammunition adjudication requires an Actor.");
	}
	if (
		weapon?.documentName !== "Item" ||
		weapon.type !== "weapon" ||
		weapon.system?.kind !== WEAPON_KIND.RANGED ||
		weapon.parent?.uuid !== actor.uuid
	) {
		throw new Error("Reserve-ammunition adjudication requires an Actor-owned ranged Weapon.");
	}
	if (!canUserControlActor(actor, user)) {
		throw new Error(localize(
			"Only the GM or an OWNER of this Actor may use reserve ammunition.",
			"Tylko MG lub WŁAŚCICIEL tego Aktora może używać zapasowej amunicji.",
		));
	}
	if (!AmmunitionInventory.trackingEnabled()) {
		throw new Error("Reserve-ammunition adjudication requires ammunition tracking.");
	}
	if (!AmmunitionInventory.requiresExternalAmmunition(weapon)) {
		throw new Error("This ranged Weapon does not use external ammunition.");
	}
	const runtime = CombatRangedState.runtime(weapon);
	if (Number(runtime?.magazineCapacity ?? 0) > 0) {
		throw new Error("Reserve direct-shot adjudication is not used for internal-magazine weapons.");
	}
}

function canUserControlActor(actor, user) {
	if (user?.isGM) return true;
	const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
	return actor?.testUserPermission?.(user, ownerLevel) === true;
}

function isReserveOnlyBlock(fire) {
	return Boolean(
		fire &&
		fire.available !== true &&
		fire.ammunition?.allowed === false &&
		Array.isArray(fire.ammunition?.reserves) &&
		fire.ammunition.reserves.length > 0
	);
}

function reserveShotAllowed(fire) {
	return fire?.available === true || isReserveOnlyBlock(fire);
}

function allowedReserveResult(result, ammunitionUuid, launcherOnly) {
	const ammunition = result?.ammunition && typeof result.ammunition === "object"
		? {
			...result.ammunition,
			allowed: true,
			reason: "",
			adjudicatedReserve: launcherOnly !== true,
			adjudicationPending: launcherOnly === true,
			selectedReserveUuid: String(ammunitionUuid ?? ""),
		}
		: result?.ammunition;
	return Object.freeze({
		...result,
		available: true,
		reason: "",
		ammunition: ammunition ? Object.freeze(ammunition) : ammunition,
	});
}

function reserveStack(actor, weapon, ammunitionUuid) {
	const uuid = String(ammunitionUuid ?? "");
	if (!uuid) return null;
	return AmmunitionInventory.reserveStacks(actor, weapon).find(
		(item) => String(item.uuid ?? "") === uuid,
	) ?? null;
}

function safeFireAvailability(actor, weapon) {
	try {
		return CombatRangedState.fireAvailability(actor, weapon);
	} catch (error) {
		return Object.freeze({
			available: false,
			reason: error?.message ?? String(error),
		});
	}
}

function socketSafeAvailability(value) {
	return Object.freeze({
		available: value?.available === true,
		reason: String(value?.reason ?? ""),
		runtime: foundry.utils.deepClone(value?.runtime ?? null),
		turn: foundry.utils.deepClone(value?.turn ?? null),
		combatantId: String(value?.combatant?.id ?? value?.combatantId ?? ""),
	});
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function weaponKey(weapon) {
	return String(weapon?.uuid ?? "").trim();
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
		? polish
		: english;
}
