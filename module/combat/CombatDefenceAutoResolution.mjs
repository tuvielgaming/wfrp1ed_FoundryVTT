import { TestResultChat } from "../tests/TestResultChat.mjs";
import { CombatDefenceOpportunity } from "./CombatDefenceOpportunity.mjs";
import { CombatDefenceTransaction } from "./CombatDefenceTransaction.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const AUTO_FLAG_KEY = "combatDefenceAutoResolution";

const resolvingMessages = new Set();

/**
 * Automatically resolve a successful melee hit as `No defence` when the
 * defender has no currently legal Parry or Dodge Blow response.
 *
 * This is deliberately a thin orchestration layer around the authoritative
 * CombatDefenceOpportunity and CombatDefenceTransaction contracts. It does not
 * invent another defence state or bypass GM authority.
 *
 * Managed Combat:
 * - the current round's Parry/Dodge resources determine availability;
 * - when both are exhausted/unavailable, no user confirmation is required.
 *
 * Unmanaged combat:
 * - the same shortcut is used only when the Actor has neither a legal parry
 *   Item nor an available Dodge Blow response;
 * - no round resources are invented outside Combat Tracker.
 */
Hooks.on("updateChatMessage", (message) => {
	void maybeAutoResolve(message);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGM()) return;
	for (const message of game.messages ?? []) {
		void maybeAutoResolve(message);
	}
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	const auto = message?.getFlag?.(FLAG_SCOPE, AUTO_FLAG_KEY);
	if (!auto) return;

	const root = asElement(html);
	if (!root) return;
	void decorateResolvedSummary(root, auto);
});

async function maybeAutoResolve(message) {
	if (!isPrimaryActiveGM()) return;
	if (!message?.id || resolvingMessages.has(message.id)) return;

	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const test = message.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!attack || !test) return;
	if (attack.family !== "melee" || attack.targetMode !== "defender") return;
	if (attack.defence?.status) return;
	if (!currentTestOutcome(test).success) return;

	const defender = await actorFromAttackState(attack);
	if (!defender) return;

	const resolved = opportunityFor(
		defender,
		attack.seenComing !== false,
	);
	if (hasActionableDefence(resolved.opportunity)) return;

	resolvingMessages.add(message.id);
	try {
		/*
		 * `none` is a real response in the existing transaction. Committing it here
		 * means later hit-location/damage code sees exactly the same resolved state
		 * as if the defender had selected No defence manually.
		 */
		await CombatDefenceTransaction.commitResponse(
			message,
			"none",
			"",
			game.user,
		);

		await message.setFlag(FLAG_SCOPE, AUTO_FLAG_KEY, {
			version: 1,
			reason: "no-available-defence",
			managedByCombat: Boolean(resolved.combatant),
			defenderUuid: String(defender.uuid ?? ""),
			defenderName: String(defender.name ?? ""),
			resolvedAt: Date.now(),
		});
	} catch (error) {
		/*
		 * Another legitimate response may win a race between the attack update and
		 * this automatic check. If a defence now exists, that response is already
		 * authoritative and there is nothing to report as an error.
		 */
		const latest = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (!latest?.defence?.status) {
			console.error(
				"WFRP1ED | Unable to auto-resolve unavailable defence.",
				error,
			);
		}
	} finally {
		resolvingMessages.delete(message.id);
	}
}

function hasActionableDefence(opportunity) {
	return (opportunity?.responses ?? []).some((response) =>
		response?.id !== "none" && response?.available === true,
	);
}

function opportunityFor(defender, seenComing) {
	const combatant = combatantForActor(defender);
	const opportunity = combatant
		? CombatDefenceOpportunity.melee(combatant, { seenComing })
		: CombatDefenceOpportunity.unmanagedMelee(defender, { seenComing });
	return { combatant, opportunity };
}

async function decorateResolvedSummary(root, auto) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const defence = root.querySelector?.("[data-wfrp-combat-defence]");
		const status = defence?.querySelector?.(".combat-defence-status");
		if (status) {
			status.textContent = auto.managedByCombat
				? localize(
					"The defender has no remaining Parry or Dodge Blow capability this round. Defence was resolved automatically; the blow continues to damage resolution.",
					"Obrońca nie ma już w tej rundzie dostępnego Parowania ani Uników. Obrona została rozstrzygnięta automatycznie; cios przechodzi do rozstrzygania obrażeń.",
				)
				: localize(
					"The defender has no available Parry or Dodge Blow option. Defence was resolved automatically; the blow continues to damage resolution.",
					"Obrońca nie ma dostępnego Parowania ani Uników. Obrona została rozstrzygnięta automatycznie; cios przechodzi do rozstrzygania obrażeń.",
				);
			defence.dataset.wfrpDefenceAutoResolved = "true";
			return;
		}
		await nextFrame();
	}
}

function currentTestOutcome(state) {
	return TestResultChat._templateContext(state).result;
}

async function actorFromAttackState(attackState) {
	const uuid = String(attackState?.target?.uuid ?? "").trim();
	if (!uuid || typeof globalThis.fromUuid !== "function") return null;

	try {
		const document = await globalThis.fromUuid(uuid);
		if (document?.documentName === "Actor") return document;
		if (document?.actor?.documentName === "Actor") return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function combatantForActor(actor) {
	const combat = game.combat;
	if (!combat?.started || !actor) return null;

	const combatants = [...(combat.combatants ?? [])];
	const exact = combatants.filter(
		(entry) => entry.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];

	const sameId = combatants.filter(
		(entry) => entry.actor?.id && actor.id && entry.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function isPrimaryActiveGM() {
	if (!game.user?.isGM) return false;
	return primaryActiveGM()?.id === game.user.id;
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user.active && user.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function nextFrame() {
	return new Promise((resolve) => requestAnimationFrame(resolve));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
