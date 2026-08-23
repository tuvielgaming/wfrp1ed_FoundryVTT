import { GMGameplayNotice } from "../chat/GMGameplayNotice.mjs";
import { AmmunitionInventory } from "../inventory/AmmunitionInventory.mjs";
import { WfrpCheckbox } from "../ui/WfrpCheckbox.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatRangedAttackResolution } from "./CombatRangedAttackResolution.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

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
			if (quantity(externalItem) <= 0) {
				throw new Error(localize("The selected ammunition stack is empty.", "Wybrany stos amunicji jest pusty."));
			}
		}

		const resolved = await originalExecute(actor, weapon, configuration, targetOptions);

		if (externalItem) {
			const live = actor.items?.get?.(externalItem.id);
			const before = quantity(live);
			if (before > 0) {
				await live.update({ "system.quantity": before - 1 });
				ammunition = AmmunitionInventory.ammunitionVariantSnapshot(live, before - 1);
			} else {
				const selectedName = String(externalItem.name ?? localize(
					"selected ammunition",
					"wybrana amunicja",
				));
				await GMGameplayNotice.warn({
					category: "ranged-ammunition-state-conflict",
					title: localize("Ammunition inventory", "Stan amunicji"),
					message: localize(
						`The selected ammunition changed while the shot was being resolved. The shot was kept, but no ammunition was deducted. The GM should adjudicate the inventory state for ${selectedName}.`,
						`Wybrana amunicja zmieniła się podczas rozstrzygania strzału. Strzał zachowano, ale amunicja nie została odjęta. MG powinien rozstrzygnąć stan ekwipunku dla „${selectedName}”.`,
					),
					summary: localize(
						"Ammunition changed while resolving the shot — details saved in private GM chat.",
						"Amunicja zmieniła się podczas rozstrzygania strzału — szczegóły zapisano w prywatnym czacie MG.",
					),
					actor,
					item: weapon,
				});
			}
		}

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
	const ammunitionSources = runtime.magazineCapacity > 0
		? AmmunitionInventory.magazineReloadStacks(actor, weapon)
		: AmmunitionInventory.accessibleStacks(actor, weapon);
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
		if (runtime.magazineCapacity > 0) {
			ammunitionSelect.title = localize(
				"Magazine reloads may use compatible ammunition from anywhere in this Actor's inventory.",
				"Przeładowanie magazynka może użyć zgodnej amunicji z dowolnego miejsca w ekwipunku tego Aktora.",
			);
		}
		for (const item of ammunitionSources) {
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
		const title = localize(
			"Reload the weapon's internal magazine instead of performing its ordinary reload action.",
			"Przeładuj wewnętrzny magazynek broni zamiast wykonywać jej zwykłą akcję przeładowania.",
		);
		const checkbox = WfrpCheckbox.create({
			name: "wfrpMagazineReloadChoice",
			checked: runtime.magazineReloadRemaining > 0,
			title,
			ariaLabel: localize("Reload magazine", "Przeładuj magazynek"),
		});
		magazineChoice = checkbox.root;
		magazineChoice.classList.add(
			"combat-item-sheet__check",
			"combat-ranged-magazine-choice",
		);
		magazineChoice.dataset.wfrpMagazineReloadChoice = "";
		const text = document.createElement("span");
		text.textContent = localize("Reload magazine", "Przeładuj magazynek");
		magazineChoice.append(text);
		body.append(magazineChoice);
		checkbox.input.addEventListener("change", refresh);
	}

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
				const ordinary = CombatRangedState.reloadAvailability(actor, weapon);
				if (ordinary.magazineProxy === true) {
					throw new Error(localize(
						"Select Reload magazine to refill this weapon's magazine.",
						"Zaznacz Przeładuj magazynek, aby uzupełnić magazynek tej broni.",
					));
				}
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
		const ordinaryAvailable = ordinaryReload.available && ordinaryReload.magazineProxy !== true;
		reload.disabled = !ordinaryAvailable;
		reload.title = ordinaryReload.magazineProxy === true
			? localize("Select Reload magazine to use this action.", "Zaznacz Przeładuj magazynek, aby użyć tej akcji.")
			: (ordinaryReload.reason || "");
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
