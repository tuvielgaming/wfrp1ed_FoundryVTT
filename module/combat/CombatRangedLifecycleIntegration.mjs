import {
	WEAPON_KIND,
	rangeDisplayValue,
} from "../data-models/item/WeaponData.mjs";
import { CombatAttackDialog } from "./CombatAttackDialog.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { COMBAT_ATTACK_TARGET_MODE } from "./CombatAttackResolution.mjs";
import { CombatEquipmentState } from "./CombatEquipmentState.mjs";
import { CombatRangedAttackResolution } from "./CombatRangedAttackResolution.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";
import { PendingRangedCombatAttack } from "./PendingRangedCombatAttack.mjs";

let installed = false;
let openingRangedContext = null;
let originalCanLaunch = null;
let originalLaunch = null;

Hooks.once("init", () => install());

Hooks.on("renderApplicationV2", (application, element) => {
	decorateRangedWeaponItem(application, element);
	decorateClassicRangedRows(application, element);
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
		if (weapon?.system?.kind !== WEAPON_KIND.RANGED) {
			const lock = CombatRangedState.actionLock(actor);
			if (lock.locked) throw new Error(lock.reason);
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

		/*
		 * Do not open a modal which can only offer Cancel. If neither firing nor
		 * reloading is legal in this turn, surface the actual ranged-state reason
		 * immediately. A repeating weapon may still reopen the dialog while it has
		 * shots left; a weapon awaiting a legal Reload action still opens it too.
		 */
		const fire = CombatRangedState.fireAvailability(actor, weapon);
		const reload = CombatRangedState.reloadAvailability(actor, weapon);
		if (!fire.available && !reload.available) {
			throw new Error(
				fire.reason || reload.reason || localize(
					"No ranged action is available for this weapon this turn.",
					"Ta broń nie ma dostępnej akcji dystansowej w tej turze.",
				),
			);
		}

		openingRangedContext = { actor, weapon };
		let configuration;
		try {
			configuration = await CombatAttackDialog.configure(actor, weapon);
		} finally {
			openingRangedContext = null;
		}

		if (!configuration) return null;

		if (configuration.targetMode === COMBAT_ATTACK_TARGET_MODE.NONE) {
			return CombatRangedAttackResolution.execute(
				actor,
				weapon,
				configuration,
				{
					targetMode: COMBAT_ATTACK_TARGET_MODE.NONE,
					target: null,
				},
			);
		}

		if (configuration.target) {
			return CombatRangedAttackResolution.execute(
				actor,
				weapon,
				configuration,
				{
					targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
					target: configuration.target,
				},
			);
		}

		return PendingRangedCombatAttack.create(actor, weapon, configuration);
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
		{
			min: 0,
			max: runtime.reloadRounds + (runtime.automaticCountdown ? 1 : 0),
			disabled: !editable,
		},
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

function decorateClassicRangedRows(application, root) {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		!root?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	for (const row of root.querySelectorAll(".ranged-table-body .ranged-row[data-item-id]")) {
		const weapon = actor.items?.get?.(String(row.dataset.itemId ?? ""));
		if (
			weapon?.type !== "weapon" ||
			weapon.system?.kind !== WEAPON_KIND.RANGED
		) continue;

		decorateRangeCells(row, weapon);
		decorateReloadCell(row, weapon);

		if (!CombatAttackLauncher.canLaunch(weapon)) continue;

		row.classList.add("rollable", "combat-sheet-attack-rollable");
		row.tabIndex = 0;
		row.title = localize(
			`Left-click to use ${weapon.name}. Double-click to open.`,
			`Lewy klik: użyj ${weapon.name}. Dwuklik: otwórz.`,
		);
		if (row.dataset.wfrpRangedLifecycleBound === "true") continue;
		row.dataset.wfrpRangedLifecycleBound = "true";

		/* Keyboard access is handled here. Pointer attacks are centrally delayed
		 * by CombatItemInteractionConsistency so double-click can open the Item. */
		row.addEventListener("keydown", (event) => {
			if (event.shiftKey || (event.key !== "Enter" && event.key !== " ")) return;
			if (event.target instanceof HTMLInputElement) return;
			event.preventDefault();
			event.stopPropagation();
			void launchRanged(actor, weapon);
		});
	}
}

function decorateRangeCells(row, weapon) {
	const range = weapon.system?.range ?? {};
	const values = [
		[".ranged-cell--short-range", range.short],
		[".ranged-cell--long-range", range.long],
		[".ranged-cell--maximum-range", range.max],
	];
	for (const [selector, value] of values) {
		const cell = row.querySelector(selector);
		if (cell) cell.textContent = rangeDisplayValue(value);
	}
}

function decorateReloadCell(row, weapon) {
	const cell = row.querySelector(".ranged-cell--reload");
	if (!(cell instanceof HTMLElement)) return;

	const runtime = CombatRangedState.runtime(weapon);
	const wrapper = document.createElement("span");
	wrapper.className = "ranged-reload-runtime";
	wrapper.title = runtime.readyToFire
		? localize(
			`Ready to fire. Reload remaining: ${runtime.reloadRemaining}/${runtime.reloadRounds}.`,
			`Gotowa do strzału. Pozostałe przeładowanie: ${runtime.reloadRemaining}/${runtime.reloadRounds}.`,
		)
		: localize(
			`Not ready to fire. Reload remaining: ${runtime.reloadRemaining}/${runtime.reloadRounds}.`,
			`Nieprzygotowana do strzału. Pozostałe przeładowanie: ${runtime.reloadRemaining}/${runtime.reloadRounds}.`,
		);

	if (game.user?.isGM) {
		const input = document.createElement("input");
		input.type = "number";
		input.className = "ranged-reload-runtime__input";
		input.min = "0";
		input.max = String(runtime.reloadRounds + (runtime.automaticCountdown ? 1 : 0));
		input.step = "1";
		input.value = String(runtime.reloadRemaining);
		input.inputMode = "numeric";
		input.autocomplete = "off";
		input.setAttribute(
			"aria-label",
			localize("Reload remaining", "Pozostałe przeładowanie"),
		);
		for (const eventName of ["pointerdown", "click", "dblclick", "keydown"]) {
			input.addEventListener(eventName, (event) => event.stopPropagation());
		}
		input.addEventListener("change", () => {
			void updateRuntimeField(weapon, input, {
				reloadRemaining: integerValue(input.value),
			});
		});
		wrapper.append(input);
	} else {
		const value = document.createElement("span");
		value.className = "ranged-reload-runtime__value";
		value.textContent = String(runtime.reloadRemaining);
		wrapper.append(value);
	}

	const maximum = document.createElement("span");
	maximum.className = "ranged-reload-runtime__maximum";
	maximum.textContent = `/${runtime.reloadRounds}`;
	wrapper.append(maximum);
	cell.replaceChildren(wrapper);
}

async function launchRanged(actor, weapon) {
	try {
		await CombatAttackLauncher.launch(actor, weapon);
	} catch (error) {
		console.error("WFRP1ED | Unable to launch ranged weapon workflow.", error);
		ui.notifications.error(error?.message ?? String(error));
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
		const actor = weapon.actor ?? weapon.parent;
		if (actor?.sheet?.rendered) void actor.sheet.render();
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

	let warning = root.querySelector("[data-wfrp-ranged-readiness-warning]");
	if (!warning) {
		warning = document.createElement("div");
		warning.className = "combat-ranged-readiness-warning";
		warning.dataset.wfrpRangedReadinessWarning = "";
		footer.parentElement?.insertBefore(warning, footer);
	}

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
	const warning = root.querySelector("[data-wfrp-ranged-readiness-warning]");
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
		if (warning) warning.hidden = true;
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

	if (warning) {
		const preparationRequired = fire.runtime.reloadRemaining > 0 ||
			fire.runtime.readyToFire !== true;
		warning.hidden = !preparationRequired;
		warning.textContent = preparationRequired
			? localize(
				"Weapon not ready to fire (Reload).",
				"Broń nieprzygotowana do strzału (Przeładuj).",
			)
			: "";
	}
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
