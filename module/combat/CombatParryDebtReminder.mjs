import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ECONOMY_FLAG_KEY = "attackEconomy";
const DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";

/**
 * Presentation-only reminders for carried Parry costs.
 *
 * The attack economy remains authoritative. This module never mutates debt.
 * Before the Combatant's turn the marker shows pending debt. When that debt is
 * paid at turn start, Wfrp1edCombat keeps the paid amount in the separate
 * `parryDebtReminder` flag until the Combatant ends the turn, so a reduced A
 * value remains understandable throughout the actual attack window.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	const cell = element.querySelector(
		'.characteristics-row--current [data-characteristic="a"]',
	);
	if (!cell) return;

	cell.querySelector("[data-wfrp-parry-debt-marker]")?.remove();
	const combatant = combatantForActor(actor);
	if (!combatant) return;

	const snapshot = CombatAttackEconomy.snapshot(combatant);
	const pendingDebt = nonNegativeInteger(snapshot.parryDebt);
	const paidThisTurn = snapshot.turnStarted && !snapshot.turnCompleted
		? nonNegativeInteger(
			combatant.getFlag?.(FLAG_SCOPE, DEBT_REMINDER_FLAG_KEY),
		)
		: 0;
	const displayedDebt = paidThisTurn > 0 ? paidThisTurn : pendingDebt;
	if (displayedDebt <= 0) return;

	const marker = document.createElement("span");
	marker.classList.add("characteristic-current-attacks-debt-marker");
	marker.dataset.wfrpParryDebtMarker = "";
	marker.textContent = `−${displayedDebt}`;

	if (paidThisTurn > 0) {
		const pendingSuffix = pendingDebt > 0
			? localize(
				` Additional pending parry debt: ${pendingDebt}.`,
				` Dodatkowy oczekujący dług za parowanie: ${pendingDebt}.`,
			)
			: "";
		marker.title = localize(
			`Parry debt paid at the start of this turn: ${paidThisTurn} A. This explains the reduced Attacks value for the current turn. The reminder disappears when this Combatant ends the turn.${pendingSuffix}`,
			`Dług za parowanie spłacony na początku tej tury: ${paidThisTurn} A. To wyjaśnia obniżoną liczbę Ataków w bieżącej turze. Przypomnienie zniknie po zakończeniu tury tego uczestnika.${pendingSuffix}`,
		);
	} else {
		marker.title = localize(
			`Parry debt: ${pendingDebt}. This many Attacks will be lost from the next attack opportunity before any excess debt carries forward.`,
			`Dług za parowanie: ${pendingDebt}. Tyle Ataków zostanie odjętych od najbliższej możliwości ataku, a ewentualny nadmiar długu przejdzie dalej.`,
		);
	}

	marker.setAttribute("aria-label", marker.title);
	cell.append(marker);
});

/**
 * Foundry updates Combat.round once per round transition. Debt survives the
 * ordinary round reset, so it is safe to summarize it after that update.
 */
Hooks.on("updateCombat", (combat, changes) => {
	if (!game.user?.isGM || !Object.hasOwn(changes ?? {}, "round")) return;
	const round = nonNegativeInteger(combat?.round);
	if (round <= 1) return;

	const entries = [...(combat?.combatants ?? [])]
		.map((combatant) => {
			const raw = combatant.getFlag?.(FLAG_SCOPE, ECONOMY_FLAG_KEY) ?? {};
			const debt = nonNegativeInteger(raw.parryDebt);
			if (debt <= 0) return null;
			return {
				name: String(combatant.name ?? combatant.actor?.name ?? "—"),
				debt,
			};
		})
		.filter(Boolean);

	if (entries.length === 0) return;
	const details = entries
		.map((entry) => `${entry.name}: −${entry.debt} A`)
		.join(", ");
	ui.notifications.info(localize(
		`Parry debt carried into round ${round}: ${details}.`,
		`Dług za parowanie przeniesiony do rundy ${round}: ${details}.`,
	));
});

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started || !actor) return null;
	const exact = [...(combat.combatants ?? [])].filter(
		(entry) => entry.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];

	const sameId = [...(combat.combatants ?? [])].filter(
		(entry) => entry.actor?.id && actor.id && entry.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
