import {
	canEditCombatDamageDiceTotal,
	requestCombatDamageDiceTotalUpdate,
} from "./CombatDamageIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";

/*
 * Physical-dice UI for the ordinary one-die melee damage roll.
 *
 * CombatDamageIntegration already owns the authoritative adjudication path:
 * it preserves the generated dice as audit data, recomputes generated/final
 * damage, rebuilds the pending DamagePacket, and routes OWNER edits through the
 * GM socket. This module only exposes that existing path in the chat card.
 *
 * Additional Damage may create an exploding sequence of several d6 rolls. That
 * sequence has different semantics and is deliberately not flattened into this
 * one-die editor; it is handled as a separate physical-dice audit item.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateBaseDamageDie(message, html));
});

function decorateBaseDamageDie(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		!damageState?.packet?.id
	) return;

	const damageDice = Array.isArray(rollState.damageDice)
		? rollState.damageDice.map(Number).filter(Number.isFinite)
		: [];
	if (damageDice.length !== 1) return;

	const root = asElement(html);
	if (!root) return;

	for (const details of root.querySelectorAll?.(".combat-damage-context__resolved") ?? []) {
		const row = findRollRow(details);
		if (!row) continue;
		const valueHost = row.querySelector?.(":scope > strong");
		if (!valueHost || valueHost.querySelector?.("[data-wfrp-base-damage-d6]")) {
			continue;
		}

		const editable = canEditCombatDamageDiceTotal(message, game.user);
		const current = clampD6(rollState.diceTotal);
		const generated = clampD6(rollState.diceTotalOriginal ?? damageDice[0]);

		valueHost.textContent = "";
		const editor = document.createElement("span");
		editor.className = "wfrp1e-combat-damage-die-editor";
		editor.dataset.wfrpBaseDamageD6 = "";

		const dieLabel = document.createElement("span");
		dieLabel.className = "wfrp1e-combat-damage-die-editor__label";
		dieLabel.textContent = game.i18n.lang === "pl" ? "K6" : "d6";
		editor.append(dieLabel);

		if (generated !== current || rollState.diceTotalOverridden === true) {
			const audit = document.createElement("span");
			audit.className = "wfrp1e-combat-damage-die-editor__audit";
			audit.textContent = `${generated} →`;
			audit.title = localize(
				`Foundry generated ${generated}; the adjudicated physical-die result is shown in the input.`,
				`Foundry wygenerował ${generated}; w polu znajduje się rozstrzygający wynik fizycznej kości.`,
			);
			editor.append(audit);
		}

		const input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "6";
		input.step = "1";
		input.inputMode = "numeric";
		input.value = String(current);
		input.className = "wfrp1e-combat-damage-die-editor__input";
		input.dataset.wfrpBaseDamageD6Input = "";
		input.readOnly = !editable;
		input.setAttribute("aria-readonly", editable ? "false" : "true");
		input.title = editable
			? localize(
				"Enter the physical d6 result. Damage is recalculated immediately.",
				"Wpisz wynik fizycznej K6. Obrażenia zostaną natychmiast przeliczone.",
			)
			: localize(
				"This damage die is locked because its damage transaction already exists.",
				"Ta kość obrażeń jest zablokowana, ponieważ transakcja obrażeń już istnieje.",
			);

		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") input.blur();
		});
		input.addEventListener("change", () => {
			void commitBaseDamageDie(message, input, current);
		});

		editor.append(input);
		valueHost.append(editor);
	}
}

async function commitBaseDamageDie(message, input, previousValue) {
	const value = Number(input.value);
	if (!Number.isInteger(value) || value < 1 || value > 6) {
		input.value = String(previousValue);
		ui.notifications.warn(localize(
			"Damage d6 must be an integer from 1 to 6.",
			"Wynik K6 obrażeń musi być liczbą całkowitą od 1 do 6.",
		));
		return;
	}
	if (value === previousValue) return;

	input.readOnly = true;
	try {
		await requestCombatDamageDiceTotalUpdate(message, value);
	} catch (error) {
		input.value = String(previousValue);
		console.error("WFRP1ED | Unable to adjudicate physical melee damage d6.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the damage die.",
				"Nie udało się zmienić wyniku kości obrażeń.",
			),
		);
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditCombatDamageDiceTotal(message, game.user);
		}
	}
}

function findRollRow(details) {
	const expected = game.i18n.lang === "pl" ? "Rzut" : "Roll";
	return [...(details.querySelectorAll?.(".combat-damage-context__row") ?? [])]
		.find((row) => String(row.querySelector?.(":scope > span")?.textContent ?? "").trim() === expected) ?? null;
}

function clampD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6
		? number
		: 1;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
