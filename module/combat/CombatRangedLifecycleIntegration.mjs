import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

let installed = false;
let openingRangedContext = null;
let originalCanLaunch = null;
let originalLaunch = null;

Hooks.once("init", () => install());

Hooks.on("renderApplicationV2", (application, element) => {
	decorateRangedWeaponItem(application, element);
	decorateOpeningAttackDialog(application, element);
});

Hooks.on("updateItem", (item, changes) => {
	if (item?.type !== "weapon" || item.system?.kind !== WEAPON_KIND.RANGED) return;
	if (!rangedRuntimeChanged(changes)) return;
	refreshOpenRangedDialogs(item);
	if (item.sheet?.rendered) void item.sheet.render();
	const actor = item.actor ?? item.parent;
	if (actor?.sheet?.rendered) void actor.sheet.render();
});

Hooks.on("updateCombatant", (combatant, changes) => {
	if (!rangedTurnChanged(changes)) return;
	refreshOpenRangedDialogs();
	if (combatant?.actor?.sheet?.rendered) void combatant.actor.sheet.render();
});

function install() {
	if (installed) return;
	installed = true;

	originalCanLaunch = CombatAttackLauncher.canLaunch;
	originalLaunch = CombatAttackLauncher.launch;

	CombatAttackLauncher.canLaunch = function canLaunchMeleeOrRanged(weapon) {
		if (
			weapon?.type === "weapon" &&
			weapon.system?.kind === WEAPON_KIND.RANGED
		) {
			return CombatEquipmentState.isUsed(weapon);
		}
		return originalCanLaunch.call(this, weapon);
	};

	CombatAttackLauncher.launch = async function launchWithRangedLifecycle(actor, weapon) {
		const lock = CombatRangedState.actionLock(actor);
		if (lock.locked) throw new Error(lock.reason);

		if (weapon?.system?.kind !== WEAPON_KIND.RANGED) {
			return originalLaunch.call(this, actor, weapon);
		}

		if (!this.canLaunch(weapon)) {
			throw new Error(localize(
				"The ranged weapon must be equipped/held before it can be used.",
				"Broń dystansowa musi być używana/trzymana, aby można było jej użyć.",
			));
		}
		if (weapon.parent?.uuid !== actor?.uuid) {
			throw new Error("The selected ranged Weapon is not owned by this Actor.");
		}

		/* A participant may open the ranged dialog only on their active turn. */
		CombatRangedState.combatantForActor(actor, { requireActive: true });

		openingRangedContext = { actor, weapon };
		let configuration;
		try {
			configuration = await CombatAttackDialog.configure(actor, weapon);
		} finally {
			openingRangedContext = null;
		}

		if (!configuration) return null;

		/*
		 * This checkpoint wires the complete preparation/reload resource contract
		 * before the BS attack transaction itself. Do not silently route a ranged
		 * Roll into the verified melee resolution path.
		 */
		ui.notifications.info(localize(
			"The weapon is ready. Ballistic Skill firing resolution is the next ranged-combat checkpoint; no shot or ammunition was consumed.",
			"Broń jest gotowa. Rozstrzygnięcie strzału Umiejętnością Strzelecką jest następnym etapem walki dystansowej; nie zużyto strzału ani amunicji.",
		));
		return null;
	};
}

function decorateRangedWeaponItem(application, root) {
	const weapon = application?.document;
	if (
		weapon?.documentName !== "Item" ||
		weapon.type !== "weapon" ||
		weapon.system?.kind !== WEAPON_KIND.RANGED
	) return;

	const content = root?.querySelector?.(".combat-item-sheet__content");
	if (!content) return;
	content.querySelector("[data-wfrp-ranged-runtime-panel]")?.remove();

	const actor = weapon.actor ?? weapon.parent;
	const runtime = CombatRangedState.runtime(weapon);
	const editable = CombatRangedState.canUserAdjudicate(weapon);
	const panel = document.createElement("section");
	panel.className = "combat-item-sheet__panel";
	panel.dataset.wfrpRangedRuntimePanel = "";

	const heading = document.createElement("h3");
	heading.textContent = localize("Ranged weapon state", "Stan broni dystansowej");
	panel.append(heading);

	const hint = document.createElement("p");
	hint.className = "combat-item-sheet__hint";
	hint.textContent = localize(
		"Ready, remaining reload work and magazine ammunition are mutable play state. Manual corrections never reset another field automatically.",
		"Gotowość, pozostałe przeładowanie i amunicja w magazynku są zmiennym stanem gry. Ręczna korekta jednego pola nigdy nie zeruje automatycznie pozostałych.",
	);
	panel.append(hint);

	const grid = document.createElement("div");
	grid.className = runtime.magazineCapacity > 0
		? "combat-item-sheet__grid combat-item-sheet__grid--3"
		: "combat-item-sheet__grid combat-item-sheet__grid--2";

	const ready = document.createElement("label");
	ready.className = "combat-item-sheet__check";
	const readyInput = document.createElement("input");
	readyInput.type = "checkbox";
	readyInput.checked = runtime.readyToFire;
	readyInput.disabled = !editable || runtime.reloadRounds === 0;
	readyInput.title = localize(
		"Manual adjudication only. Changing Ready never changes the reload counter.",
		"Tylko ręczne rozstrzygnięcie. Zmiana Gotowości nigdy nie zmienia licznika przeładowania.",
	);
	const readyText = document.createElement("span");
	readyText.textContent = localize("Ready to Fire", "Gotowa do strzału");
	ready.append(readyInput, readyText);
	grid.append(ready);

	const reload = field(
		localize("Reload remaining", "Pozostałe przeładowanie"),
		runtime.reloadRemaining,
		{ min: 0, max: runtime.reloadRounds + (runtime.automaticCountdown ? 1 : 0), disabled: !editable },
	);
	grid.append(reload.root);

	let magazine = null;
	if (runtime.magazineCapacity > 0) {
		magazine = field(
			localize("Magazine ammunition", "Amunicja w magazynku"),
			runtime.magazineRemaining,
			{ min: 0, max: runtime.magazineCapacity, disabled: !editable },
		);
		grid.append(magazine.root);
	}

	panel.append(grid);
	const description = content.querySelector(".combat-item-sheet__description");
	if (description) content.insertBefore(panel, description);
	else content.append(panel);

	readyInput.addEventListener("change", () => {
		void updateRuntimeField(weapon, readyInput, {
			readyToFire: readyInput.checked,
		});
	});
	reload.input.addEventListener("change", () => {
		void updateRuntimeField(weapon, reload.input, {
			reloadRemaining: integerValue(reload.input.value),
		});
	});
	magazine?.input?.addEventListener("change", () => {
		void updateRuntimeField(weapon, magazine.input, {
			magazineRemaining: integerValue(magazine.input.value),
		});
	});

	if (actor?.documentName !== "Actor") {
		panel.title = localize(
			"Runtime state becomes authoritative when the Weapon belongs to an Actor.",
			"Stan runtime staje się autorytatywny, gdy broń należy do Aktora.",
		);
	}
}

async function updateRuntimeField(weapon, input, patch) {
	input.disabled = true;
	try {
		await CombatRangedState.editRuntime(weapon, patch);
	} catch (error) {
		console.error("WFRP1ED | Unable to adjudicate ranged weapon state.", error);
		ui.notifications.error(error?.message ?? String(error));
	} finally {
		if (weapon.sheet?.rendered) void weapon.sheet.render();
	}
}

function decorateOpeningAttackDialog(application, root) {
	if (!openingRangedContext) return;
	if (!root?.classList?.contains("wfrp1ed-combat-attack-dialog")) return;
	const { actor, weapon } = openingRangedContext;
	root.dataset.wfrpRangedWeaponUuid = String(weapon.uuid ?? "");
	root.dataset.wfrpRangedActorUuid = String(actor.uuid ?? "");

	const footer = root.querySelector("footer.form-footer, .form-footer");
	const roll = root.querySelector('button[data-action="roll"]');
	const cancel = root.querySelector('button[data-action="cancel"]');
	if (!footer || !roll || !cancel) return;

	footer.querySelector("[data-action='ranged-reload']")?.remove();
	const reload = document.createElement("button");
	reload.type = "button";
	reload.dataset.action = "ranged-reload";
	reload.innerHTML = `<i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>${localize("Reload", "Przeładuj")}</span>`;
	footer.insertBefore(reload, cancel);

	reload.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		reload.disabled = true;
		try {
			const result = await CombatRangedState.reload(actor, weapon);
			const remaining = result?.runtime?.reloadRemaining ?? 0;
			ui.notifications.info(remaining > 0
				? localize(
					`Reloading ${weapon.name}: ${remaining} round(s) remain. This turn is committed to reloading.`,
					`Przeładowywanie ${weapon.name}: pozostało ${remaining} rund(y). Ta tura jest poświęcona przeładowaniu.`,
				)
				: localize(
					`${weapon.name} is ready to fire. This turn was spent reloading.`,
					`${weapon.name} jest gotowa do strzału. Ta tura została poświęcona przeładowaniu.`,
				));
			cancel.click();
		} catch (error) {
			console.error("WFRP1ED | Unable to reload ranged weapon.", error);
			ui.notifications.error(error?.message ?? String(error));
			refreshDialog(root, actor, weapon);
		}
	});

	refreshDialog(root, actor, weapon);
}

function refreshOpenRangedDialogs(item = null) {
	for (const root of document.querySelectorAll(".wfrp1ed-combat-attack-dialog[data-wfrp-ranged-weapon-uuid]")) {
		const weaponUuid = root.dataset.wfrpRangedWeaponUuid;
		if (item && weaponUuid !== item.uuid) continue;
		const actorUuid = root.dataset.wfrpRangedActorUuid;
		const weapon = item?.uuid === weaponUuid
			? item
			: globalThis.fromUuidSync?.(weaponUuid);
		const actor = globalThis.fromUuidSync?.(actorUuid);
		if (weapon?.documentName !== "Item" || actor?.documentName !== "Actor") continue;
		refreshDialog(root, actor, weapon);
	}
}

function refreshDialog(root, actor, weapon) {
	const roll = root.querySelector('button[data-action="roll"]');
	const reload = root.querySelector('button[data-action="ranged-reload"]');
	if (!roll || !reload) return;

	let fire;
	let reloadState;
	try {
		fire = CombatRangedState.fireAvailability(actor, weapon);
		reloadState = CombatRangedState.reloadAvailability(actor, weapon);
	} catch (error) {
		roll.disabled = true;
		reload.disabled = true;
		roll.title = error?.message ?? String(error);
		reload.title = roll.title;
		return;
	}

	roll.disabled = !fire.available;
	roll.title = fire.available
		? localize("Weapon ready to fire.", "Broń gotowa do strzału.")
		: fire.reason;
	reload.disabled = !reloadState.available;
	reload.title = reloadState.available
		? localize("Spend this turn reloading the weapon.", "Poświęć tę turę na przeładowanie broni.")
		: reloadState.reason;
}

function field(label, value, { min = 0, max = 0, disabled = false } = {}) {
	const root = document.createElement("label");
	root.className = "combat-item-sheet__field";
	const text = document.createElement("span");
	text.textContent = label;
	const input = document.createElement("input");
	input.type = "number";
	input.step = "1";
	input.min = String(min);
	input.max = String(max);
	input.value = String(value ?? 0);
	input.disabled = disabled;
	root.append(text, input);
	return { root, input };
}

function rangedRuntimeChanged(changes) {
	return foundry.utils.getProperty(changes ?? {}, "flags.wfrp1ed.rangedRuntime") !== undefined ||
		Object.hasOwn(changes ?? {}, "flags.wfrp1ed.rangedRuntime");
}

function rangedTurnChanged(changes) {
	return foundry.utils.getProperty(changes ?? {}, "flags.wfrp1ed.rangedTurnState") !== undefined ||
		Object.hasOwn(changes ?? {}, "flags.wfrp1ed.rangedTurnState");
}

function integerValue(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
