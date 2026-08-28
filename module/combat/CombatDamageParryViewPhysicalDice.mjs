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
 * All authority, socket and recalculation logic remains in
 * CombatDamagePhysicalDiceIntegration / CombatDamageIntegration. This module
 * makes the derived Damage card faithfully mirror the current source state.
 * That is important because parry adjudication updates the parry flag and the
 * resolved DamagePacket in two consecutive Document updates; an older derived
 * render must never win visually over the newer damage resolution.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => decorateDedicatedDamageView(message, html));
});

function decorateDedicatedDamageView(viewMessage, html) {
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
		!damageState?.packet?.id
	) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!(card instanceof HTMLElement)) return;

	synchronizeDedicatedDamagePresentation(card, rollState, damageState);
	decorateDedicatedParryDie(card, sourceMessage, rollState);
}

function synchronizeDedicatedDamagePresentation(card, rollState, damageState) {
	const resolution = damageState?.resolution ?? {};
	const finalAmount = nonNegativeInteger(resolution.finalAmount);
	const headerAmount = card.querySelector(":scope > .wfrp1e-damage-card__header .wfrp1e-damage-card__amount");
	if (headerAmount) headerAmount.textContent = String(finalAmount);

	const finalRow = findRow(card, localize("Final damage", "Końcowe obrażenia"));
	const finalHost = finalRow?.querySelector?.(":scope > strong");
	if (finalHost) finalHost.textContent = String(finalAmount);

	/* Parry is resolved before the ordinary defensive reductions. The packet's
	 * raw amount is generated damage, while toughness.before is the actual amount
	 * which reaches Toughness after a successful parry. */
	const beforeToughnessRow = findRow(
		card,
		localize("Before Toughness", "Przed Wytrzymałością"),
	);
	const beforeToughnessHost = beforeToughnessRow?.querySelector?.(":scope > strong");
	const beforeToughness = Number(resolution?.breakdown?.toughness?.before);
	if (beforeToughnessHost && Number.isFinite(beforeToughness)) {
		beforeToughnessHost.textContent = String(nonNegativeInteger(beforeToughness));
	}

	/* The editable damage total is authoritative in combatDamageRoll. Keep the
	 * value in the input after every derived-card rerender instead of allowing a
	 * stale HTML render to clear or replace it. */
	const damageInput = card.querySelector("[data-wfrp-damage-dice-total]");
	if (damageInput instanceof HTMLInputElement && document.activeElement !== damageInput) {
		damageInput.value = String(nonNegativeInteger(rollState?.diceTotal));
	}

	/* Unified roll notation:
	 * - an input constrained to the physical die uses [current face] = input;
	 * - a total which may legally exceed the die uses [maximum face] → input.
	 * Ordinary melee damage is a d6, while the editable summed damage value is
	 * intentionally unbounded because Additional Damage can raise the total. */
	const dice = Array.isArray(rollState?.damageDice) ? rollState.damageDice : [];
	if (dice.length === 1 && damageInput instanceof HTMLInputElement) {
		const badge = card.querySelector(
			".wfrp1e-damage-card__roll-row .wfrp1e-damage-roll__dice .wfrp1e-damage-die",
		);
		const operator = card.querySelector(
			".wfrp1e-damage-card__roll-row .wfrp1e-damage-roll__operator",
		);
		if (badge instanceof HTMLElement) {
			const maximum = finiteInputMaximum(damageInput);
			const canExceedDie = maximum === null || maximum > 6;
			updateD6Badge(badge, canExceedDie ? 6 : Number(damageInput.value));
			if (operator) operator.textContent = canExceedDie ? "→" : "=";
		}
	}
}

function decorateDedicatedParryDie(card, sourceMessage, rollState) {
	if (
		rollState?.parry?.succeeded !== true ||
		!isD6(rollState?.parry?.reduction)
	) return;

	const row = findRow(card, localize("Parry", "Parowanie"));
	if (!row) return;
	const labelHost = row.querySelector?.(":scope > span");
	const valueHost = row.querySelector?.(":scope > strong");
	if (!valueHost) return;

	const current = Number(rollState.parry.reduction);
	const generated = isD6(rollState.parry.reductionOriginal)
		? Number(rollState.parry.reductionOriginal)
		: current;
	const editable = canEditCombatParryReduction(sourceMessage, game.user);
	const itemName = String(rollState.parry?.itemName ?? "").trim();

	if (labelHost) {
		labelHost.textContent = itemName
			? `${localize("Parry", "Parowanie")} (${itemName})`
			: localize("Parry", "Parowanie");
	}

	valueHost.textContent = "";
	const editor = document.createElement("span");
	editor.className = "wfrp1e-combat-damage-die-editor wfrp1e-damage-roll";
	editor.dataset.wfrpDedicatedParryD6 = "";
	if (generated !== current) {
		editor.title = localize(
			`Foundry generated ${generated}; the adjudicated parry d6 is ${current}.`,
			`Foundry wygenerował ${generated}; rozstrzygający wynik K6 parowania to ${current}.`,
		);
	}

	const badgeHost = document.createElement("span");
	badgeHost.className = "wfrp1e-damage-roll__dice";
	const badge = createD6Badge(current);
	badgeHost.append(badge);

	const equals = document.createElement("span");
	equals.className = "wfrp1e-damage-roll__operator";
	equals.textContent = "=";

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = "6";
	input.step = "1";
	input.inputMode = "numeric";
	input.value = String(current);
	input.className = "wfrp1e-damage-roll__total wfrp1e-combat-damage-die-editor__input";
	input.dataset.wfrpDedicatedParryD6Input = "";
	input.dataset.lastValidValue = String(current);
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
		void commitParry(sourceMessage, input, badge).catch(reportCommitError);
	});

	editor.append(badgeHost, equals, input);
	valueHost.append(editor);

	/* Put the reduction where it is mechanically applied, immediately before the
	 * post-parry "Before Toughness" subtotal. */
	const beforeToughnessRow = findRow(
		card,
		localize("Before Toughness", "Przed Wytrzymałością"),
	);
	if (beforeToughnessRow && row !== beforeToughnessRow.previousElementSibling) {
		beforeToughnessRow.before(row);
	}
}

async function commitParry(sourceMessage, input, badge) {
	const previousValue = lastValidParryValue(sourceMessage, input);
	const value = Number(input.value);
	if (!isD6(value)) {
		restoreParryEditor(input, badge, previousValue);
		ui.notifications.warn(localize(
			"Parry reduction d6 must be an integer from 1 to 6.",
			"Wynik K6 redukcji parowania musi być liczbą całkowitą od 1 do 6.",
		));
		return;
	}
	if (value === previousValue) {
		restoreParryEditor(input, badge, value);
		return;
	}

	input.readOnly = true;
	input.setAttribute("aria-readonly", "true");
	try {
		const returnedState = await requestCombatParryReductionUpdate(sourceMessage, value);
		const freshRollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY) ?? returnedState;
		const current = isD6(freshRollState?.parry?.reduction)
			? Number(freshRollState.parry.reduction)
			: value;
		restoreParryEditor(input, badge, current);

		/* Force the derived card to reread the now-authoritative packet. This is
		 * also the safety net for consecutive source updates arriving out of order. */
		requestAnimationFrame(() => void ui.chat?.render?.({ force: true }));
	} catch (error) {
		restoreParryEditor(input, badge, previousValue);
		throw error;
	} finally {
		if (input.isConnected) {
			input.readOnly = !canEditCombatParryReduction(sourceMessage, game.user);
			input.setAttribute("aria-readonly", input.readOnly ? "true" : "false");
		}
	}
}

function lastValidParryValue(sourceMessage, input) {
	const stored = Number(input?.dataset?.lastValidValue);
	if (isD6(stored)) return stored;
	const source = Number(
		sourceMessage?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY)?.parry?.reduction,
	);
	return isD6(source) ? source : 1;
}

function restoreParryEditor(input, badge, value) {
	if (input?.isConnected) {
		input.value = String(value);
		input.dataset.lastValidValue = String(value);
	}
	if (badge instanceof HTMLElement) updateD6Badge(badge, value);
}

function createD6Badge(value) {
	const badge = document.createElement("i");
	badge.className = "fa-solid wfrp1e-damage-die";
	badge.dataset.wfrpDedicatedParryD6Badge = "";
	updateD6Badge(badge, value);
	return badge;
}

function updateD6Badge(badge, value) {
	const number = Math.min(6, Math.max(1, Number(value) || 1));
	const names = ["one", "two", "three", "four", "five", "six"];
	for (const name of names) badge.classList.remove(`fa-dice-${name}`);
	badge.classList.add(`fa-dice-${names[number - 1]}`);
	badge.title = `d6: ${number}`;
	badge.setAttribute("aria-label", `d6: ${number}`);
}

function finiteInputMaximum(input) {
	const raw = String(input?.max ?? "").trim();
	if (!raw) return null;
	const number = Number(raw);
	return Number.isFinite(number) ? number : null;
}

function reportCommitError(error) {
	console.error("WFRP1ED | Unable to adjudicate dedicated Damage-card parry d6.", error);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to change the parry reduction die.",
			"Nie udało się zmienić wyniku kości redukcji parowania.",
		),
	);
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
