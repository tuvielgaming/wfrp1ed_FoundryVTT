import { CombatAttackEconomy } from "./CombatAttackEconomy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ECONOMY_FLAG_KEY = "attackEconomy";

/**
 * Presentation-only reminders for carried Parry costs.
 *
 * The attack economy remains authoritative. This module never mutates debt: it
 * only marks a Classic A cell while debt is still pending and gives the GM one
 * grouped notification when Foundry advances into a new combat round.
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
	const debt = nonNegativeInteger(snapshot.parryDebt);
	if (debt <= 0) return;

	const marker = document.createElement("span");
	marker.classList.add("characteristic-current-attacks-debt-marker");
	marker.dataset.wfrpParryDebtMarker = "";
	marker.textContent = `−${debt}`;
	marker.title = localize(
		`Parry debt: ${debt}. This many Attacks will be lost from the next attack opportunity before any excess debt carries forward.`,
		`Dług za parowanie: ${debt}. Tyle Ataków zostanie odjętych od najbliższej możliwości ataku, a ewentualny nadmiar długu przejdzie dalej.`,
	);
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
