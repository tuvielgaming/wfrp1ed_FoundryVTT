import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackResultChat } from "./CombatAttackResultChat.mjs";
import { CombatRangedAttackResolution } from "./CombatRangedAttackResolution.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";
import { AmmunitionInventory } from "../inventory/AmmunitionInventory.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const selectedByWeapon = new Map();
let installed = false;

Hooks.once("init", () => install());
Hooks.on("renderApplicationV2", (application, element) => {
	decorateRangedAttackDialog(application, element);
	decorateRangedWeaponRuntime(application, element);
});

function install() {
	if (installed) return;
	installed = true;

	const originalConfigure = CombatAttackDialog.configure.bind(CombatAttackDialog);
	CombatAttackDialog.configure = async function configureWithAmmunition(actor, weapon) {
		const result = await originalConfigure(actor, weapon);
		if (!result || weapon?.system?.kind !== "ranged") return result;
		return Object.freeze({
			...result,
			ammunitionUuid: String(selectedByWeapon.get(String(weapon.uuid ?? "")) ?? ""),
		});
	};

	const originalExecute = CombatRangedAttackResolution.execute.bind(CombatRangedAttackResolution);
	CombatRangedAttackResolution.execute = async function executeWithAmmunition(actor, weapon, configuration, targetOptions) {
		const runtimeBefore = CombatRangedState.runtime(weapon);
		const internalMagazine = runtimeBefore.magazineCapacity > 0;
		let externalItem = null;
		let externalBefore = 0;
		let ammunition = internalMagazine ? runtimeBefore.magazineVariant ?? null : null;

		if (
			AmmunitionInventory.trackingEnabled() &&
			AmmunitionInventory.requiresExternalAmmunition(weapon) &&
			!internalMagazine
		) {
			externalItem = AmmunitionInventory.validateSelectedShot(
				actor,
				weapon,
				configuration?.ammunitionUuid,
			);
			externalBefore = quantity(externalItem);
			if (externalBefore <= 0) throw new Error(localize("The selected ammunition stack is empty.", "Wybrany stos amunicji jest pusty."));
			await externalItem.update({ "system.quantity": externalBefore - 1 });
			ammunition = AmmunitionInventory.ammunitionVariantSnapshot(externalItem, externalBefore - 1);
		}

		try {
			const resolved = await originalExecute(actor, weapon, configuration, targetOptions);
			if (resolved?.message && ammunition) {
				const state = foundry.utils.deepClone(
					resolved.message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY) ?? {},
				);
				state.ammunition = foundry.utils.deepClone(ammunition);
				state.updatedBy = String(game.user?.id ?? "");
				state.updatedAt = Date.now();
				await resolved.message.setFlag(FLAG_SCOPE, ATTACK_FLAG_KEY, state);
			}
			return resolved;
		} catch (error) {
			/* External ammunition is reserved before the ranged transaction so two
			 * clients cannot spend the same last arrow. If attack execution fails,
			 * restore that reservation rather than silently losing ammunition. */
			if (externalItem) {
				const live = actor.items?.get?.(externalItem.id);
				if (live) await live.update({ "system.quantity": externalBefore }).catch(() => {});
			}
			throw error;
		}
	};
}

function decorateRangedAttackDialog(_application, root) {
	if (!root?.classList?.contains("wfrp1ed-combat-attack-dialog")) return;
	const weaponUuid = String(root.dataset?.wfrpRangedWeaponUuid ?? "");
	const actorUuid = String(root.dataset?.wfrpRangedActorUuid ?? "");
	if (!weaponUuid || !actorUuid) return;
	const weapon = globalThis.fromUuidSync?.(weaponUuid);
	const actor = globalThis.fromUuidSync?.(actorUuid);
	if (weapon?.documentName !== "Item" || actor?.documentName !== "Actor") return;

	const body = root.querySelector(".combat-attack-dialog-body");
	const footer = root.querySelector("footer.form-footer, .form-footer");
	const oldReload = footer?.querySelector('button[data-action="ranged-reload"]');
	const roll = footer?.querySelector('button[data-action="roll"]');
	const cancel = footer?.querySelector('button[data-action="cancel"]');
	if (!body || !footer || !oldReload || !roll || !cancel) return;

	root.querySelector("[data-wfrp-ammunition-group]")?.remove();
	root.querySelector("[data-wfrp-magazine-reload-choice]")?.remove();

	const runtime = CombatRangedState.runtime(weapon);
	const accessible = AmmunitionInventory.accessibleStacks(actor, weapon);
	const requiresAmmo = AmmunitionInventory.requiresExternalAmmunition(weapon);
	let ammunitionSelect = null;

	if (AmmunitionInventory.trackingEnabled() && requiresAmmo) {
		const group = document.createElement("label");
		group.className = "form-group combat-ranged-ammunition-group";
		group.dataset.wfrpAmmunitionGroup = "";
		const label = document.createElement("span");
		label.textContent = runtime.magazineCapacity > 0
			? localize("Magazine ammunition", "Amunicja do magazynka")
			: localize("Ammunition", "Amunicja");
		ammunitionSelect = document.createElement("select");
		ammunitionSelect.name = "wfrpAmmunitionUuid";
		for (const item of accessible) {
			const option = document.createElement("option");
			option.value = String(item.uuid ?? "");
			option.textContent = `${item.name} — ${quantity(item)}`;
			ammunitionSelect.append(option);
		}
		const remembered = runtime.magazineReloadSourceUuid ||
			String(selectedByWeapon.get(weaponUuid) ?? "");
		if (remembered && [...ammunitionSelect.options].some((option) => option.value === remembered)) {
			ammunitionSelect.value = remembered;
		} else if (ammunitionSelect.options.length) {
			ammunitionSelect.selectedIndex = 0;
		}
		if (ammunitionSelect.value) selectedByWeapon.set(weaponUuid, ammunitionSelect.value);
		ammunitionSelect.addEventListener("change", () => {
			selectedByWeapon.set(weaponUuid, ammunitionSelect.value);
			refresh();
		});
		group.append(label, ammunitionSelect);
		body.append(group);
	}

	let magazineChoice = null;
	if (runtime.magazineCapacity > 0 && runtime.magazineReloadRounds > 0) {
		magazineChoice = document.createElement("label");
		magazineChoice.className = "combat-item-sheet__check combat-ranged-magazine-choice";
		magazineChoice.dataset.wfrpMagazineReloadChoice = "";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = runtime.magazineReloadRemaining > 0;
		const text = document.createElement("span");
		text.textContent = localize("Reload magazine", "Przeładuj magazynek");
		magazineChoice.append(checkbox, text);
		body.append(magazineChoice);
		checkbox.addEventListener("change", refresh);
	}

	/* Clone the button to remove the ordinary reload listener installed by the
	 * generic ranged lifecycle. This late integration owns the unified choice
	 * between weapon Reload and magazine refill. */
	const reload = oldReload.cloneNode(true);
	oldReload.replaceWith(reload);
	reload.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		reload.disabled = true;
		try {
			const magazineMode = magazineChoice?.querySelector("input")?.checked === true;
			if (magazineMode) {
				const result = await CombatRangedState.reloadMagazine(actor, weapon, {
					ammunitionUuid: ammunitionSelect?.value ?? "",
				});
				if (result?.completion) notifyMagazineCompletion(weapon, result.completion);
				else ui.notifications.info(localize(
					`${weapon.name}: magazine reload — ${result?.runtime?.magazineReloadRemaining ?? 0} round(s) remain.`,
					`${weapon.name}: przeładowanie magazynka — pozostało ${result?.runtime?.magazineReloadRemaining ?? 0} rund(y).`,
				));
			} else {
				const result = await CombatRangedState.reload(actor, weapon);
				const remaining = result?.runtime?.reloadRemaining ?? 0;
				ui.notifications.info(remaining > 0
					? localize(`Reloading ${weapon.name}: ${remaining} round(s) remain.`, `Przeładowywanie ${weapon.name}: pozostało ${remaining} rund(y).`)
					: localize(`${weapon.name} is ready to fire.`, `${weapon.name} jest gotowa do strzału.`));
			}
			cancel.click();
		} catch (error) {
			console.error("WFRP1ED | Ranged reload action failed.", error);
			ui.notifications.error(error?.message ?? String(error));
			refresh();
		}
	});

	function refresh() {
		const current = CombatRangedState.runtime(weapon);
		const magazineMode = magazineChoice?.querySelector("input")?.checked === true;
		if (magazineChoice) {
			const checkbox = magazineChoice.querySelector("input");
			checkbox.disabled = current.magazineReloadRemaining > 0;
		}

		if (magazineMode) {
			let availability;
			try { availability = CombatRangedState.magazineReloadAvailability(actor, weapon); }
			catch (error) { availability = { available: false, reason: error?.message ?? String(error) }; }
			const sourceRequired = AmmunitionInventory.trackingEnabled() &&
				AmmunitionInventory.requiresExternalAmmunition(weapon) &&
				!current.magazineReloadSourceUuid;
			const hasSource = !sourceRequired || Boolean(ammunitionSelect?.value);
			reload.disabled = !availability.available || !hasSource;
			reload.title = availability.reason || "";
			reload.querySelector("span").textContent = localize("Reload magazine", "Przeładuj magazynek");
			roll.disabled = true;
			if (ammunitionSelect) ammunitionSelect.disabled = current.magazineReloadRemaining > 0;
			return;
		}

		let fire;
		let ordinaryReload;
		try {
			fire = CombatRangedState.fireAvailability(actor, weapon);
			ordinaryReload = CombatRangedState.reloadAvailability(actor, weapon);
		} catch (error) {
			fire = { available: false, reason: error?.message ?? String(error) };
			ordinaryReload = { available: false, reason: fire.reason };
		}
		roll.disabled = !fire.available;
		reload.disabled = !ordinaryReload.available;
		reload.title = ordinaryReload.reason || "";
		reload.querySelector("span").textContent = localize("Reload", "Przeładuj");
		if (ammunitionSelect) {
			ammunitionSelect.disabled = current.magazineCapacity > 0;
			if (current.magazineCapacity === 0 && fire.available && !ammunitionSelect.value) roll.disabled = true;
		}
	}

	refresh();
}

function decorateRangedWeaponRuntime(application, root) {
	const weapon = application?.document;
	if (weapon?.documentName !== "Item" || weapon.type !== "weapon" || weapon.system?.kind !== "ranged") return;
	const runtime = CombatRangedState.runtime(weapon);
	if (runtime.magazineCapacity <= 0 || runtime.magazineReloadRounds <= 0) return;
	const panel = root?.querySelector?.("[data-wfrp-ranged-runtime-panel]");
	if (!panel || panel.querySelector("[data-wfrp-magazine-runtime]")) return;

	const section = document.createElement("div");
	section.className = "combat-ranged-magazine-runtime";
	section.dataset.wfrpMagazineRuntime = "";
	const label = document.createElement("strong");
	label.textContent = localize("Magazine reload", "Przeładowanie magazynka");
	const value = document.createElement("span");
	value.textContent = `${runtime.magazineReloadRemaining}/${runtime.magazineReloadRounds}`;
	section.append(label, value);

	if (runtime.magazineReloadRemaining > 0 && CombatRangedState.canUserAdjudicate(weapon)) {
		const actions = document.createElement("span");
		actions.className = "combat-ranged-magazine-runtime__actions";
		const finish = actionButton(localize("Finish", "Dokończ"), "fa-solid fa-check-double");
		const interrupt = actionButton(localize("Interrupt", "Przerwij"), "fa-solid fa-ban");
		finish.addEventListener("click", async (event) => {
			event.preventDefault();
			try {
				const result = await CombatRangedState.finishMagazineReload(weapon.actor ?? weapon.parent, weapon);
				notifyMagazineCompletion(weapon, result?.completion);
				void application.render({ force: true });
			} catch (error) { ui.notifications.error(error?.message ?? String(error)); }
		});
		interrupt.addEventListener("click", async (event) => {
			event.preventDefault();
			try {
				await CombatRangedState.interruptMagazineReload(weapon.actor ?? weapon.parent, weapon);
				ui.notifications.info(localize(
					`${weapon.name}: magazine reload interrupted; current ammunition was preserved.`,
					`${weapon.name}: przeładowanie magazynka przerwane; aktualna amunicja została zachowana.`,
				));
				void application.render({ force: true });
			} catch (error) { ui.notifications.error(error?.message ?? String(error)); }
		});
		actions.append(finish, interrupt);
		section.append(actions);
	}
	panel.append(section);
}

function actionButton(label, icon) {
	const button = document.createElement("button");
	button.type = "button";
	button.innerHTML = `<i class="${icon}"></i><span>${label}</span>`;
	return button;
}

function notifyMagazineCompletion(weapon, completion) {
	if (!completion) return;
	const runtime = CombatRangedState.runtime(weapon);
	if (completion.full) {
		ui.notifications.info(localize(
			`${weapon.name}: magazine reload complete — ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
			`${weapon.name}: przeładowanie magazynka zakończone — ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
		));
	} else {
		ui.notifications.warn(localize(
			`${weapon.name}: magazine reload finished, but ammunition was insufficient. Loaded ${completion.loaded}; magazine ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
			`${weapon.name}: przeładowanie magazynka zakończone, ale zabrakło amunicji. Załadowano ${completion.loaded}; magazynek ${runtime.magazineRemaining}/${runtime.magazineCapacity}.`,
		));
	}
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
