import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";

const ATTACK_CLICK_DELAY_MS = 220;
const COMBAT_ROW_SELECTOR = ".melee-row, .ranged-row, .armour-row";
const pendingAttacks = new WeakMap();

/**
 * Make physical Item opening consistent across the Classic sheet:
 * - Equipment/Wealth already use double-click;
 * - melee/ranged/armour now use double-click as well;
 * - Shift+click is deliberately left unused for future interactions.
 *
 * Melee keeps its normal left-click attack. The attack is delayed by a short
 * double-click window so opening the Item cannot accidentally launch one or two
 * attacks before the browser emits dblclick.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor") return;

	const root = asElement(element);
	const sheet = classicSheetRoot(root);
	if (!(sheet instanceof HTMLElement)) return;

	installInteractionHandlers(sheet, actor);
	refreshInteractionTitles(sheet);
});

function installInteractionHandlers(sheet, actor) {
	if (sheet.dataset.wfrpCombatItemOpenConsistency === "true") return;
	sheet.dataset.wfrpCombatItemOpenConsistency = "true";

	sheet.addEventListener("click", (event) => {
		const row = combatRowFromEvent(event, sheet);
		if (!row || isInteractiveOrigin(event.target, row)) return;

		/* Explicitly consume Shift+click so the older row listener cannot use it
		 * to open the Item. The gesture is intentionally free for future QoL. */
		if (event.shiftKey) {
			event.preventDefault();
			event.stopImmediatePropagation();
			cancelPendingAttack(row);
			return;
		}

		if (!row.classList.contains("combat-sheet-attack-rollable")) return;

		event.preventDefault();
		event.stopImmediatePropagation();

		/* The second click of a double-click arrives before dblclick. Cancel the
		 * pending single-click attack and let the dblclick handler open the Item. */
		if (Number(event.detail) >= 2) {
			cancelPendingAttack(row);
			return;
		}

		cancelPendingAttack(row);
		const timer = setTimeout(() => {
			pendingAttacks.delete(row);
			const item = itemForRow(actor, row);
			if (!(item instanceof foundry.documents.Item)) return;
			void launchAttack(actor, item);
		}, ATTACK_CLICK_DELAY_MS);
		pendingAttacks.set(row, timer);
	}, true);

	sheet.addEventListener("dblclick", (event) => {
		const row = combatRowFromEvent(event, sheet);
		if (!row || isInteractiveOrigin(event.target, row)) return;

		event.preventDefault();
		event.stopImmediatePropagation();
		cancelPendingAttack(row);

		const item = itemForRow(actor, row);
		if (!(item instanceof foundry.documents.Item)) return;
		void item.sheet?.render?.({ force: true });
	}, true);
}

function refreshInteractionTitles(sheet) {
	for (const row of sheet.querySelectorAll(COMBAT_ROW_SELECTOR)) {
		if (!(row instanceof HTMLElement)) continue;
		const attackable = row.classList.contains("combat-sheet-attack-rollable");
		const title = attackable
			? localize(
				"Left-click to attack. Double-click to open Item details.",
				"Lewy klik: atak. Dwuklik: otwórz szczegóły przedmiotu.",
			)
			: localize(
				"Double-click to open Item details.",
				"Dwuklik: otwórz szczegóły przedmiotu.",
			);
		row.title = title;
		const nameCell = row.querySelector(
			".melee-cell--name, .ranged-cell--name, .armour-cell--name",
		);
		if (nameCell instanceof HTMLElement) nameCell.title = title;
	}
}

function combatRowFromEvent(event, sheet) {
	const target = event.target;
	if (!(target instanceof Element)) return null;
	const row = target.closest(COMBAT_ROW_SELECTOR);
	return row instanceof HTMLElement && sheet.contains(row) ? row : null;
}

function isInteractiveOrigin(target, row) {
	if (!(target instanceof Element)) return false;
	const control = target.closest("button, input, textarea, select, option, a");
	return Boolean(control && row.contains(control));
}

function itemForRow(actor, row) {
	const id = String(row.dataset.itemId ?? "").trim();
	return id ? actor.items?.get?.(id) ?? null : null;
}

function cancelPendingAttack(row) {
	const timer = pendingAttacks.get(row);
	if (timer) clearTimeout(timer);
	pendingAttacks.delete(row);
}

async function launchAttack(actor, item) {
	try {
		await CombatAttackLauncher.launch(actor, item);
	} catch (error) {
		console.error("WFRP1ED | Unable to launch combat attack.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to launch the combat attack.",
				"Nie udało się rozpocząć ataku.",
			),
		);
	}
}

function classicSheetRoot(root) {
	if (root?.matches?.(".wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
