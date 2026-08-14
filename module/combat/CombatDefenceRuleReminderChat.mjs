import { PARRY_ATTACK_COST_MODE } from "./CombatParryRules.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";

/**
 * Outside Combat Tracker the defence transaction intentionally does not mutate
 * round resources. Keep the Core costs visible anyway so an abstract/manual
 * exchange still reminds the table what must be tracked by hand.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (!attack || attack.family !== "melee" || attack.targetMode !== "defender") {
		return;
	}

	const root = asElement(html);
	if (!root) return;
	requestAnimationFrame(() => {
		requestAnimationFrame(() => void decorate(message, root));
	});
});

async function decorate(message, root) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const defender = await actorFromAttackState(attack);
	if (!defender || combatantForActor(defender)) return;

	const select = await defenceSelect(root);
	if (!(select instanceof HTMLSelectElement)) return;
	if (select.dataset.wfrpRuleReminders === "true") return;

	const parryOptions = CombatEquipment.parryOptions(defender);
	const parryByUuid = new Map(
		parryOptions.map((choice) => [String(choice.itemUuid), choice]),
	);

	for (const option of select.options) {
		const response = String(option.dataset.response ?? "");
		if (response === "dodge") {
			option.textContent = `${option.textContent} — ${localize(
				"once per round",
				"raz na rundę",
			)}`;
			continue;
		}

		if (response !== "parry") continue;
		const itemUuid = String(option.dataset.itemUuid ?? "");
		const choice = parryByUuid.get(itemUuid);
		if (!choice) continue;

		option.textContent = `${option.textContent} — ${parryCostReminder(
			choice.attackCostMode,
		)}`;
	}

	select.dataset.wfrpRuleReminders = "true";
	select.title = localize(
		"Outside Combat Tracker these are rule reminders only. The system does not automatically spend Attacks, create parry debt, or remember the once-per-round Dodge Blow use.",
		"Poza Monitorem Walki są to wyłącznie przypomnienia zasad. System nie zużywa automatycznie Ataków, nie tworzy długu za parowanie ani nie zapamiętuje użycia Uników raz na rundę.",
	);
}

function parryCostReminder(mode) {
	switch (mode) {
		case PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS:
			return localize(
				"cost: all following Attacks",
				"koszt: wszystkie kolejne Ataki",
			);
		case PARRY_ATTACK_COST_MODE.ONE_ATTACK:
		default:
			return localize("cost: 1 Attack", "koszt: 1 Atak");
	}
}

async function defenceSelect(root) {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const select = root.querySelector?.(
			"[data-wfrp-combat-defence] select[data-defence-choice]",
		);
		if (select) return select;
		await nextFrame();
	}
	return null;
}

function nextFrame() {
	return new Promise((resolve) => requestAnimationFrame(resolve));
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
	const exact = [...(combat.combatants ?? [])].filter(
		(entry) => entry.actor?.uuid === actor.uuid,
	);
	if (exact.length === 1) return exact[0];
	const sameId = [...(combat.combatants ?? [])].filter(
		(entry) => entry.actor?.id && actor.id && entry.actor.id === actor.id,
	);
	return sameId.length === 1 ? sameId[0] : null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
