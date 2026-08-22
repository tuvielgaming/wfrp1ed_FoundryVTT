import {
	canEditCombatParryReduction,
	requestCombatParryReductionUpdate,
} from "./CombatDamagePhysicalDiceIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";

/*
 * View adapter for the dedicated Damage card.
 *
 * All permission, GM-authority, socket and damage-recalculation logic lives in
 * CombatDamagePhysicalDiceIntegration. This module only renders the same parry
 * d6 editor in the dedicated card and delegates the edit to that canonical path.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateDedicatedParryDie(message, html));
});

function decorateDedicatedParryDie(viewMessage, html) {
	const view = viewMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.sourceAttackMessageId) return;

	const sourceMessage = game.messages?.get(String(view.sourceAttackMessageId));
	if (!sourceMessage) return;

	const attack = sourceMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.status !== "resolved" ||
		rollState?.parry?.succeeded !== true ||
		!isD6(rollState?.parry?.reduction) ||
		!damageState?.packet?.id
	) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!card) return;

	const row = findRow(card, localize("Parry", "Parowanie"));
	if (!row) return;
	const valueHost = row.querySelector?.(":scope > strong");
	if (!valueHost || valueHost.querySelector?.("[data-wfrp-dedicated-parry-d6]")) {
		return;
	}

	const current = Number(rollState.parry.reduction);
	const generated = isD6(rollState.parry.reductionOriginal)
		? Number(rollState.parry.reductionOriginal)
		: current;
	const editable = canEditCombatParryReduction(sourceMessage, game.user);
	const absorbed = nonNegativeInteger(
		damageState?.resolution?.breakdown?.parry?.absorbed,
	);
	const itemName = String(rollState.parry?.itemName ?? "").trim();

	valueHost.textContent = "";
	const editor = document.createElement("span");
	editor.className = "wfrp1e-combat-damage-die-editor";
	editor.dataset.wfrpDedicatedParryD6 = "";

	const label = document.createElement("span");
	label.className = "wfrp1e-combat-damage-die-editor__label";
	label.textContent = game.i18n.lang === "pl" ? "K6" : "d6";
	editor.append(label);

	if (generated !== current) {
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
	input.dataset.wfrpDedicatedParryD6Input = "";
	input.readOnly = !editable;
	input.setAttribute("aria-readonly", editable ? "false" : "true");
	input.title = editable
		? localize(
			"Enter the defender's physical d6 parry reduction. Pending damage is recalculated immediately.",
			"Wpisz wynik fizycznej K6 redukcji parowania obrońcy. Oczekujące obrażenia zostaną natychmiast przeliczone.",
		)
		: localize(
			"This parry die is locked because its damage transaction already exists or you do not own the defender.",
			"Ta kość parowania jest zablokowana, ponieważ transakcja obrażeń już istnieje albo nie jesteś właścicielem obrońcy.",
		);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") input.blur();
	});
	input.addEventListener("change", () => {
		void commitParry(sourceMessage, input, current);
	});
	editor.append(input);

	const meta = document.createElement("span");
	meta.className = "wfrp1e-combat-damage-die-editor__meta";
	meta.textContent = `→ ${absorbed}${itemName ? ` (${itemName})` : ""}`;
	meta.title = localize(
		"Amount actually stopped by the successful parry after the current adjudication.",
		"Liczba obrażeń faktycznie zatrzymanych przez udane parowanie po bieżącym rozstrzygnięciu.",
	);
	editor.append(meta);

	valueHost.append(editor);
}

async function commitParry(sourceMessage, input, previousValue) {
	const value = Number(input.value);
	if (!isD6(value)) {
		input.value = String(previousValue);
		ui.notifications.warn(localize(
			"Parry reduction d6 must be an integer from 1 to 6.",
			"Wynik K6 redukcji parowania musi być liczbą całkowitą od 1 do 6.",
		));
		return;
	}
	if (value === previousValue) return;

	input.readOnly = true;
	try {
		await requestCombatParryReductionUpdate(sourceMessage, value);
	} catch (error) {
		if (input.isConnected) input.value = String(previousValue);
		console.error("WFRP1ED | Unable to adjudicate dedicated Damage-card parry d6.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change the parry reduction die.",
				"Nie udało się zmienić wyniku kości redukcji parowania.",
			),
		);
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditCombatParryReduction(sourceMessage, game.user);
			input.setAttribute("aria-readonly", input.readOnly ? "true" : "false");
		}
	}
}

function findRow(card, expectedLabel) {
	return [...(card.querySelectorAll?.(".wfrp1e-damage-card__row") ?? [])]
		.find((row) => String(row.querySelector?.(":scope > span")?.textContent ?? "").trim() === expectedLabel) ?? null;
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
