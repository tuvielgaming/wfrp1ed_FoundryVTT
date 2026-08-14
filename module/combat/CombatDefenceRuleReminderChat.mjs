import { PARRY_ATTACK_COST_MODE } from "./CombatParryRules.mjs";
import { CombatEquipment } from "./CombatEquipment.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";

/**
 * Normalize defence-option presentation independently from the underlying
 * resource implementation.
 *
 * Parry choices show one concise cost only. Debt remains an internal detail of
 * the Core/default economy and is never appended to the selector label. The
 * optional round contract shows Shield as "All Attacks / Full Defence".
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
	if (!defender) return;

	const managed = Boolean(combatantForActor(defender));
	const select = await defenceSelect(root);
	if (!(select instanceof HTMLSelectElement)) return;
	if (select.dataset.wfrpRuleReminders === "true") return;

	const parryOptions = CombatEquipment.parryOptions(defender);
	const parryByUuid = new Map(
		parryOptions.map((choice) => [String(choice.itemUuid), choice]),
	);

	for (const option of select.options) {
		const response = String(option.dataset.response ?? "");
		if (response === "none") {
			option.textContent = responseLabel("none");
			continue;
		}

		if (response === "dodge") {
			option.textContent = managed
				? responseLabel("dodge")
				: `${responseLabel("dodge")} — ${localize(
					"once per round",
					"raz na rundę",
				)}`;
			continue;
		}

		if (response !== "parry") continue;
		const itemUuid = String(option.dataset.itemUuid ?? "");
		const choice = parryByUuid.get(itemUuid);
		if (!choice) continue;

		const bonus = Number(choice.totalBonus ?? 0);
		const signed = bonus >= 0 ? `+${bonus}` : String(bonus);
		option.textContent = [
			`${responseLabel("parry")} — ${choice.itemName} (${signed})`,
			parryCostLabel(choice.attackCostMode),
		].join(" — ");
	}

	select.dataset.wfrpRuleReminders = "true";
	select.title = WfrpRuleSettings.usesRoundDefenceContract()
		? localize(
			"Round contract: weapon parry costs 1 Attack this round; Shield gives Full Defence and sets this round's Attacks to 0. Parry attempts are tracked separately up to A. No debt carries forward.",
			"Kontrakt rundy: parowanie bronią kosztuje 1 Atak w tej rundzie; tarcza daje Pełną obronę i ustawia Ataki tej rundy na 0. Próby parowania są liczone osobno do limitu A. Żaden dług nie przechodzi dalej.",
		)
		: localize(
			"Core/default parry costs are shown without the internal debt breakdown.",
			"Koszt parowania według zasad domyślnych jest pokazany bez wewnętrznego rozbicia na dług.",
		);
}

function parryCostLabel(mode) {
	switch (mode) {
		case PARRY_ATTACK_COST_MODE.ALL_REMAINING_ATTACKS:
			return WfrpRuleSettings.usesRoundDefenceContract()
				? localize(
					"All Attacks / Full Defence",
					"Wszystkie Ataki / Pełna obrona",
				)
				: localize(
					"All following Attacks",
					"Wszystkie kolejne Ataki",
				);
		case PARRY_ATTACK_COST_MODE.ONE_ATTACK:
		default:
			return localize("Cost 1 A", "Koszt 1 A");
	}
}

function responseLabel(response) {
	switch (response) {
		case "parry": return localize("Parry", "Parowanie");
		case "dodge": return localize("Dodge Blow", "Uniki");
		case "none": return localize("No defence", "Brak obrony");
		default: return String(response ?? "—");
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
