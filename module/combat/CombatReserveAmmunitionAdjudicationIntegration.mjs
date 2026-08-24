import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { AmmunitionInventory } from "../inventory/AmmunitionInventory.mjs";
import { WfrpCheckbox } from "../ui/WfrpCheckbox.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatRangedAttackResolution } from "./CombatRangedAttackResolution.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";
import { PendingRangedCombatAttack } from "./PendingRangedCombatAttack.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const PENDING_ATTACK_FLAG_KEY = "pendingRangedCombatAttack";
const ACCESS_MODE = "reserve-adjudicated";

/*
 * Direct ranged fire normally consumes ammunition only from a matching Quick
 * Access Ammunition container. Compatible ammunition elsewhere remains reserve
 * and must never be consumed silently.
 *
 * This integration adds a deliberately explicit GM adjudication escape hatch:
 * a GM may choose one reserve stack for one configured direct shot. The system
 * does not decide the time/action/complication required to retrieve that
 * ammunition; the checkbox means the GM has already adjudicated that question.
 * It does not move the stack or make it generally accessible afterwards.
 *
 * The override is intentionally GM-local. Player-side reserve adjudication is
 * handled by CombatPlayerReserveAmmunitionIntegration; this layer keeps the
 * direct GM workflow authoritative and notification-free because the GM is
 * already the person making the ruling.
 */
const reserveModeByWeapon = new Map();
const activeReserveShots = new Map();
const launcherBypassBudget = new Map();
let installed = false;

Hooks.once("init", () => install());
Hooks.on("renderApplicationV2", (_application, element) => {
	decorateReserveAdjudication(element);
});

function install() {
	if (installed) return;
	installed = true;

	wrapAttackConfiguration();
	wrapPendingRangedAttack();
	wrapRangedLauncher();
	wrapFireAvailability();
	wrapSelectedAmmunitionValidation();
	wrapRangedResolution();
}

function wrapAttackConfiguration() {
	const originalConfigure = CombatAttackDialog.configure.bind(CombatAttackDialog);
	CombatAttackDialog.configure = async function configureWithReserveAdjudication(actor, weapon) {
		const key = weaponKey(weapon);
		if (key) reserveModeByWeapon.delete(key);
		const result = await originalConfigure(actor, weapon);
		const reserveAdjudicated = key && reserveModeByWeapon.get(key) === true;
		if (key) reserveModeByWeapon.delete(key);

		if (!result || weapon?.system?.kind !== WEAPON_KIND.RANGED) return result;
		return Object.freeze({
			...result,
			ammunitionAccessMode: reserveAdjudicated ? ACCESS_MODE : "quick-access",
		});
	};
}

/*
 * PendingRangedCombatAttack serializes only the core ranged-dialog fields. The
 * reserve approval is an integration-owned field, so persist it explicitly on
 * the pending ChatMessage after the core serializer has created the request.
 * This keeps the GM verdict alive across target selection and even across a
 * browser reload instead of relying on transient module memory.
 */
function wrapPendingRangedAttack() {
	const originalCreate = PendingRangedCombatAttack.create.bind(PendingRangedCombatAttack);
	PendingRangedCombatAttack.create = async function createWithReserveAdjudication(
		actor,
		weapon,
		configuration,
	) {
		const message = await originalCreate(actor, weapon, configuration);
		if (
			configuration?.ammunitionAccessMode !== ACCESS_MODE ||
			!message?.id
		) return message;

		const request = foundry.utils.deepClone(
			message.getFlag?.(FLAG_SCOPE, PENDING_ATTACK_FLAG_KEY) ?? {},
		);
		request.configuration = {
			...(request.configuration ?? {}),
			ammunitionAccessMode: ACCESS_MODE,
			reserveAdjudicatedBy: String(game.user?.id ?? ""),
			reserveAdjudicatedAt: Date.now(),
		};
		request.updatedBy = String(game.user?.id ?? "");
		request.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, PENDING_ATTACK_FLAG_KEY, request);
		return message;
	};
}

function wrapRangedLauncher() {
	const originalLaunch = CombatAttackLauncher.launch;
	CombatAttackLauncher.launch = async function launchWithReserveAdjudication(actor, weapon) {
		if (!canOfferReserveAdjudication(actor, weapon)) {
			return originalLaunch.call(this, actor, weapon);
		}

		const fire = safeFireAvailability(actor, weapon);
		if (!isReserveOnlyBlock(fire)) {
			return originalLaunch.call(this, actor, weapon);
		}

		/* CombatRangedLifecycleIntegration normally refuses to open a dialog which
		 * can only Cancel. Spend exactly one synthetic availability result so that
		 * its pre-dialog gate opens the UI. The GM is already the adjudicator here,
		 * so selecting reserve ammunition does not create a redundant GM notice. */
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
	CombatRangedState.fireAvailability = function fireAvailabilityWithReserveAdjudication(actor, weapon) {
		const result = originalFireAvailability(actor, weapon);
		if (result?.available === true) return result;
		if (!game.user?.isGM) return result;

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
	AmmunitionInventory.validateSelectedShot = function validateSelectedShotWithReserve(
		actor,
		weapon,
		ammunitionUuid,
	) {
		const active = activeReserveShots.get(weaponKey(weapon));
		if (
			game.user?.isGM &&
			active &&
			String(active.ammunitionUuid ?? "") === String(ammunitionUuid ?? "")
		) {
			const selected = reserveStack(actor, weapon, ammunitionUuid);
			if (selected) return selected;
		}
		return originalValidate(actor, weapon, ammunitionUuid);
	};
}

function wrapRangedResolution() {
	const originalExecute = CombatRangedAttackResolution.execute.bind(CombatRangedAttackResolution);
	CombatRangedAttackResolution.execute = async function executeWithReserveAdjudication(
		actor,
		weapon,
		configuration,
		targetOptions,
	) {
		if (configuration?.ammunitionAccessMode !== ACCESS_MODE) {
			return originalExecute(actor, weapon, configuration, targetOptions);
		}
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only the GM can adjudicate a direct shot using reserve ammunition outside Quick Access.",
				"Tylko MG może rozstrzygnąć bezpośredni strzał z użyciem zapasowej amunicji poza łatwym dostępem.",
			));
		}
		if (!canOfferReserveAdjudication(actor, weapon)) {
			throw new Error(localize(
				"Reserve-ammunition adjudication is not available for this weapon.",
				"Rozstrzygnięcie użycia zapasowej amunicji nie jest dostępne dla tej broni.",
			));
		}

		const ammunitionUuid = String(configuration?.ammunitionUuid ?? "");
		const selectedReserve = reserveStack(actor, weapon, ammunitionUuid);
		if (!selectedReserve) {
			/* If the Item was moved into Quick Access after the dialog was configured,
			 * it is no longer reserve. Let the ordinary path validate and consume it
			 * as normal readily accessible ammunition instead of rejecting the shot. */
			const nowAccessible = AmmunitionInventory.accessibleStacks(actor, weapon)
				.some((item) => String(item.uuid ?? "") === ammunitionUuid);
			if (nowAccessible) {
				return originalExecute(
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

		const key = weaponKey(weapon);
		const token = foundry.utils.randomID();
		activeReserveShots.set(key, Object.freeze({ token, ammunitionUuid }));
		try {
			const resolved = await originalExecute(actor, weapon, configuration, targetOptions);
			await tagAttackAsReserveAdjudicated(resolved?.message);
			return resolved;
		} finally {
			if (activeReserveShots.get(key)?.token === token) activeReserveShots.delete(key);
		}
	};
}

function decorateReserveAdjudication(root) {
	if (!game.user?.isGM) return;
	if (!root?.classList?.contains?.("wfrp1ed-combat-attack-dialog")) return;

	const weaponUuid = String(root.dataset?.wfrpRangedWeaponUuid ?? "");
	const actorUuid = String(root.dataset?.wfrpRangedActorUuid ?? "");
	if (!weaponUuid || !actorUuid) return;
	const weapon = globalThis.fromUuidSync?.(weaponUuid);
	const actor = globalThis.fromUuidSync?.(actorUuid);
	if (!canOfferReserveAdjudication(actor, weapon)) return;

	const reserves = AmmunitionInventory.reserveStacks(actor, weapon);
	if (!reserves.length) return;
	const group = root.querySelector("[data-wfrp-ammunition-group]");
	const select = group?.querySelector?.("select[name='wfrpAmmunitionUuid']");
	const label = group?.querySelector?.("span");
	const roll = root.querySelector("footer.form-footer button[data-action='roll'], .form-footer button[data-action='roll']");
	if (!(select instanceof HTMLSelectElement) || !(roll instanceof HTMLButtonElement)) return;

	root.querySelector("[data-wfrp-reserve-ammunition-choice]")?.remove();
	const key = weaponKey(weapon);
	reserveModeByWeapon.set(key, false);

	const title = localize(
		"GM adjudication only. This allows one shot to consume the selected compatible reserve stack without moving it into Quick Access. It does not spend a turn or decide the time/complication required to retrieve the ammunition; adjudicate that separately before enabling this shot.",
		"Tylko rozstrzygnięcie MG. Pozwala jednemu strzałowi zużyć wybrany zgodny stos zapasowej amunicji bez przenoszenia go do łatwego dostępu. Nie zużywa tury ani nie rozstrzyga czasu/komplikacji potrzebnej do przygotowania amunicji; rozstrzygnij to osobno przed zezwoleniem na strzał.",
	);
	const checkbox = WfrpCheckbox.create({
		name: "wfrpReserveAmmunitionAdjudicated",
		checked: false,
		title,
		ariaLabel: localize(
			"Allow reserve ammunition for this shot (GM adjudication)",
			"Zezwól na zapasową amunicję dla tego strzału (rozstrzygnięcie MG)",
		),
	});
	const choice = checkbox.root;
	choice.classList.add(
		"combat-item-sheet__check",
		"combat-ranged-magazine-choice",
		"combat-ranged-reserve-choice",
	);
	choice.dataset.wfrpReserveAmmunitionChoice = "";
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
		/* CombatRangedAmmunitionIntegration owns the selected-ammunition map. A
		 * real change event keeps that existing source of truth synchronized after
		 * we swap the select's option set. */
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
		const canAdjudicate = Boolean(currentReserve && reserveShotAllowed(fire));
		roll.disabled = !canAdjudicate;
		roll.title = canAdjudicate
			? localize(
				"GM adjudication: this shot will consume the selected reserve ammunition. Retrieval time/complication is not automated.",
				"Rozstrzygnięcie MG: ten strzał zużyje wybraną amunicję zapasową. Czas/komplikacja jej przygotowania nie są automatyzowane.",
			)
			: String(fire?.reason ?? localize(
				"The selected reserve ammunition is unavailable.",
				"Wybrana amunicja zapasowa jest niedostępna.",
			));
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
	});
	select.addEventListener("change", refresh);

	refresh();
}

function canOfferReserveAdjudication(actor, weapon) {
	if (!game.user?.isGM) return false;
	if (actor?.documentName !== "Actor") return false;
	if (
		weapon?.documentName !== "Item" ||
		weapon.type !== "weapon" ||
		weapon.system?.kind !== WEAPON_KIND.RANGED ||
		weapon.parent?.uuid !== actor.uuid
	) return false;
	if (!AmmunitionInventory.trackingEnabled()) return false;
	if (!AmmunitionInventory.requiresExternalAmmunition(weapon)) return false;
	let runtime;
	try { runtime = CombatRangedState.runtime(weapon); }
	catch (_error) { return false; }
	return Number(runtime?.magazineCapacity ?? 0) <= 0 &&
		AmmunitionInventory.reserveStacks(actor, weapon).length > 0;
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
	try { return CombatRangedState.fireAvailability(actor, weapon); }
	catch (error) {
		return Object.freeze({
			available: false,
			reason: error?.message ?? String(error),
		});
	}
}

async function tagAttackAsReserveAdjudicated(message) {
	if (!message?.id) return;
	const state = foundry.utils.deepClone(
		message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY) ?? {},
	);
	if (!state?.ammunition || typeof state.ammunition !== "object") return;
	state.ammunition.accessMode = ACCESS_MODE;
	state.ammunition.accessAdjudicatedBy = String(game.user?.id ?? "");
	state.ammunition.accessAdjudicatedAt = Date.now();
	state.updatedBy = String(game.user?.id ?? "");
	state.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, ATTACK_FLAG_KEY, state);
}

function weaponKey(weapon) {
	return String(weapon?.uuid ?? "").trim();
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
