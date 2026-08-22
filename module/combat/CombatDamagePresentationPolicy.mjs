const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const SHOW_OTHER_DETAILS_SETTING_KEY = "showDamageDetailsForOtherPlayers";

/*
 * Final combat-damage presentation policy.
 *
 * Mechanics stay in CombatDamageIntegration / CombatDamagePhysicalDiceIntegration.
 * This layer only decides what is visible and where:
 * - attack and dedicated Damage cards use the same compact Parry d6 wording;
 * - Parry remains outside the folded diagnostic section so its physical-die
 *   control is immediately discoverable;
 * - by default players do not see opponent-only Strength/Toughness/armour
 *   diagnostics. A world setting lets the GM expose the complete breakdown.
 */
Hooks.once("init", () => {
	game.settings.register(game.system.id, SHOW_OTHER_DETAILS_SETTING_KEY, {
		name: localize(
			"Show full damage details to other players",
			"Pokaż pełne szczegóły obrażeń innym graczom",
		),
		hint: localize(
			"When disabled, players only see detailed damage values that belong to Actors they own. Opponent Strength, Toughness, armour and related breakdown values stay hidden. The GM always sees the full breakdown.",
			"Gdy wyłączone, gracze widzą tylko szczegółowe wartości obrażeń należące do postaci, których są właścicielami. Siła, Wytrzymałość, pancerz przeciwnika i powiązane wartości pozostają ukryte. MG zawsze widzi pełne szczegóły.",
		),
		scope: "world",
		config: true,
		type: Boolean,
		default: false,
		onChange: () => void ui.chat?.render?.({ force: true }),
	});

	Hooks.on("renderChatMessageHTML", (message, html) => {
		const root = asElement(html);
		if (!root) return;
		requestAnimationFrame(() => {
			applyPresentation(message, root);
			setTimeout(() => applyPresentation(message, root), 0);
		});
	});
});

function applyPresentation(message, root) {
	normalizeAttackParryLabel(message, root);
	presentDedicatedDamage(message, root);
}

function normalizeAttackParryLabel(message, root) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (
		attack?.family !== "melee" ||
		rollState?.parry?.succeeded !== true ||
		!damageState?.packet?.id
	) return;

	const editor = root.querySelector?.("[data-wfrp-parry-reduction-d6]");
	const meta = editor?.querySelector?.(".wfrp1e-combat-damage-die-editor__meta");
	if (!(meta instanceof HTMLElement)) return;

	const absorbed = nonNegativeInteger(
		damageState?.resolution?.breakdown?.parry?.absorbed,
	);
	const itemName = String(rollState?.parry?.itemName ?? "").trim();
	meta.textContent = `→ ${absorbed}${itemName ? ` (${itemName})` : ""}`;
}

function presentDedicatedDamage(message, root) {
	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view?.sourceAttackMessageId) return;

	const sourceMessage = game.messages?.get(String(view.sourceAttackMessageId));
	if (!sourceMessage) return;
	const attack = sourceMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family !== "melee") return;

	const card = root.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!(card instanceof HTMLElement)) return;

	/* Keep Parry beside Target / Hit location / Roll, never hidden in Details. */
	const parryRow = findRow(card, localize("Parry", "Parowanie"));
	const folded = card.querySelector?.("details[data-wfrp-damage-folded-details]");
	if (parryRow && folded && parryRow.parentElement !== card) {
		card.insertBefore(parryRow, folded);
	}

	applyDetailAudiencePolicy(card, attack);
}

function applyDetailAudiencePolicy(card, attack) {
	const details = card.querySelector?.("details[data-wfrp-damage-folded-details]");
	if (!(details instanceof HTMLDetailsElement)) return;
	const body = details.querySelector?.(".wfrp1e-damage-card__details-body");
	if (!(body instanceof HTMLElement)) return;

	const rows = [...body.querySelectorAll(":scope > .wfrp1e-damage-card__row")];
	for (const row of rows) row.hidden = false;
	details.hidden = false;

	if (game.user?.isGM || showAllDetailsToPlayers()) return;

	const attacker = actorFromUuidSync(attack?.attacker?.uuid);
	const defender = actorFromUuidSync(attack?.target?.uuid);
	const ownsAttacker = hasOwnerPermission(attacker, game.user);
	const ownsDefender = hasOwnerPermission(defender, game.user);

	for (const row of rows) {
		const label = rowLabel(row);
		if (ATTACKER_DETAIL_LABELS.has(label)) {
			row.hidden = !ownsAttacker;
			continue;
		}
		if (DEFENDER_DETAIL_LABELS.has(label)) {
			row.hidden = !ownsDefender;
			continue;
		}
		if (FINAL_DAMAGE_LABELS.has(label)) {
			/* The final amount is already visible in the Damage-card header. */
			row.hidden = true;
		}
	}

	const visibleRows = rows.some((row) => !row.hidden);
	details.hidden = !visibleRows;
	if (!visibleRows) details.open = false;
}

const ATTACKER_DETAIL_LABELS = new Set([
	"Strength",
	"Siła",
	"Weapon modifier",
	"Modyfikator broni",
	"Additional Damage",
	"Obrażenia dodatkowe",
	"Before Toughness",
	"Przed Wytrzymałością",
]);

const DEFENDER_DETAIL_LABELS = new Set([
	"Toughness",
	"Wytrzymałość",
	"Armour",
	"Pancerz",
]);

const FINAL_DAMAGE_LABELS = new Set([
	"Final damage",
	"Końcowe obrażenia",
]);

function showAllDetailsToPlayers() {
	try {
		return game.settings.get(game.system.id, SHOW_OTHER_DETAILS_SETTING_KEY) === true;
	} catch (_error) {
		return false;
	}
}

function findRow(card, expectedLabel) {
	return [...(card.querySelectorAll?.(".wfrp1e-damage-card__row") ?? [])]
		.find((row) => rowLabel(row) === expectedLabel) ?? null;
}

function rowLabel(row) {
	return String(row?.querySelector?.(":scope > span")?.textContent ?? "").trim();
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function hasOwnerPermission(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
