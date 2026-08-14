import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";
import { CombatRoundTurnState } from "./CombatRoundTurnState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ECONOMY_FLAG_KEY = "attackEconomy";
const DEBT_REMINDER_FLAG_KEY = "parryDebtReminder";

/**
 * Presentation-only reminders for the Core/default carried Parry cost model.
 *
 * The optional round contract has no debt by definition. When that world rule
 * is active this module is completely silent, including for stale legacy flags
 * which may still exist on Combatants created under the default interpretation.
 *
 * A paid debt reminder belongs to the Combatant's real WFRP turn completion,
 * not merely to the currently focused attack window. It therefore survives the
 * round boundary and initiative postponement/reordering, and disappears only
 * after the Combatant completes the affected turn with Next Turn.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	if (WfrpRuleSettings.usesRoundDefenceContract()) return;

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
	const pendingDebt = Math.min(
		snapshot.allowance,
		nonNegativeInteger(snapshot.parryDebt),
	);
	const paidReminder = CombatRoundTurnState.isCompleted(combatant)
		? 0
		: Math.min(
			snapshot.allowance,
			nonNegativeInteger(
				combatant.getFlag?.(FLAG_SCOPE, DEBT_REMINDER_FLAG_KEY),
			),
		);
	const displayedDebt = paidReminder > 0 ? paidReminder : pendingDebt;
	if (displayedDebt <= 0) return;

	const marker = document.createElement("span");
	marker.classList.add("characteristic-current-attacks-debt-marker");
	marker.dataset.wfrpParryDebtMarker = "";
	marker.textContent = `−${displayedDebt}`;

	if (paidReminder > 0) {
		const pendingSuffix = pendingDebt > 0
			? localize(
				` Additional pending parry debt: ${pendingDebt}.`,
				` Dodatkowy oczekujący dług za parowanie: ${pendingDebt}.`,
			)
			: "";
		marker.title = localize(
			`Parry debt paid for this turn: ${paidReminder} A. This explains the reduced Attacks value. The reminder disappears only when this Combatant completes the turn with Next Turn.${pendingSuffix}`,
			`Dług za parowanie spłacony dla tej tury: ${paidReminder} A. To wyjaśnia obniżoną liczbę Ataków. Przypomnienie zniknie dopiero po zakończeniu tury tego uczestnika przyciskiem Następna tura.${pendingSuffix}`,
		);
	} else {
		marker.title = localize(
			`Parry debt: ${pendingDebt}. This many Attacks will be lost from the next attack opportunity. Parry debt is capped at the character's A allowance.`,
			`Dług za parowanie: ${pendingDebt}. Tyle Ataków zostanie odjętych od najbliższej możliwości ataku. Dług za parowanie jest ograniczony do wartości A postaci.`,
		);
	}

	marker.setAttribute("aria-label", marker.title);
	cell.append(marker);
});

/** Summarize debt carried into a new round only for the default interpretation. */
Hooks.on("updateCombat", (combat, changes) => {
	if (WfrpRuleSettings.usesRoundDefenceContract()) return;
	if (!game.user?.isGM || !Object.hasOwn(changes ?? {}, "round")) return;
	const round = nonNegativeInteger(combat?.round);
	if (round <= 1) return;

	const entries = [...(combat?.combatants ?? [])]
		.map((combatant) => {
			const raw = combatant.getFlag?.(FLAG_SCOPE, ECONOMY_FLAG_KEY) ?? {};
			const allowance = CombatAttackEconomy.allowance(combatant);
			const debt = Math.min(
				allowance,
				nonNegativeInteger(raw.parryDebt),
			);
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
