const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const DAMAGE_DETAILS_PUBLIC_FLAG_KEY = "combatDamageDetailsPublic";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";

/*
 * Final combat-damage presentation policy.
 *
 * Mechanics stay in CombatDamageIntegration / CombatDamagePhysicalDiceIntegration.
 * This layer only decides what is visible and where:
 * - the dedicated Damage card is the single damage presentation once it exists;
 * - attack and dedicated Damage cards use the same compact Parry d6 wording;
 * - Parry remains outside the folded diagnostic section so its physical-die
 *   control is immediately discoverable;
 * - players do not see opponent-only Strength/Toughness/armour diagnostics by
 *   default;
 * - the GM may publish/restrict the complete breakdown of one specific Damage
 *   card through the same per-message context-menu pattern used by Test cards;
 * - the entitlement survives pending/applied/reverted presentation changes and
 *   works in both the main Chat Log and Foundry's floating Chat Log.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const root = asElement(html);
		if (!root) return;
		requestAnimationFrame(() => {
			applyPresentation(message, root);
			setTimeout(() => applyPresentation(message, root), 0);
		});
	});

	Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
		addDamageVisibilityContextOptions(menuItems);
	});

	Hooks.on("updateChatMessage", (message, changes) => {
		if (!damageVisibilityChanged(changes)) return;
		requestAnimationFrame(() => refreshVisiblePresentation(message));
	});

	/* Damage application/reversion is Actor-authoritative. Re-apply presentation
	 * after the compact-history layer has had a chance to reshape the card. */
	Hooks.on("updateActor", (actor, changes) => {
		if (!damageApplicationsChanged(changes)) return;
		scheduleVisibleDamageRefresh(actor);
	});
});

function applyPresentation(message, root) {
	removeEmbeddedDamageDuplicate(message, root);
	normalizeAttackParryLabel(message, root);
	presentDedicatedDamage(message, root);
}

/*
 * Once a dedicated Damage ChatMessage exists, the Attack card must not retain a
 * second complete Damage section. Besides being duplicate state, that old audit
 * bypassed the dedicated card's per-message audience policy. Pending parry UI is
 * unaffected because there is no dedicated Damage card at that stage.
 */
function removeEmbeddedDamageDuplicate(message, root) {
	if (!message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) return;
	if (!dedicatedDamageViewForSource(message.id)) return;

	const wrapper = root.querySelector?.("[data-wfrp-combat-damage]");
	wrapper?.remove();
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

	/*
	 * Keep Parry beside Target / Hit location / Roll, never hidden in the inner
	 * diagnostic disclosure. The reference node may itself be nested inside an
	 * outer historical <details> after damage is applied, so insertion must use
	 * the folded node's actual parent rather than assuming `card` is its parent.
	 * This also avoids NotFoundError in Foundry's floating Chat Log.
	 */
	const parryRow = findRow(card, localize("Parry", "Parowanie"));
	const folded = card.querySelector?.("details[data-wfrp-damage-folded-details]");
	const foldParent = folded?.parentElement ?? null;
	if (
		parryRow instanceof HTMLElement &&
		folded instanceof HTMLDetailsElement &&
		foldParent instanceof HTMLElement &&
		parryRow.parentElement !== foldParent
	) {
		foldParent.insertBefore(parryRow, folded);
	}

	applyDetailAudiencePolicy(message, card, attack);
}

function applyDetailAudiencePolicy(message, card, attack) {
	const details = card.querySelector?.("details[data-wfrp-damage-folded-details]");
	const body = details?.querySelector?.(".wfrp1e-damage-card__details-body");
	const rows = body instanceof HTMLElement
		? [...body.querySelectorAll(":scope > .wfrp1e-damage-card__row")]
		: [...card.querySelectorAll(".wfrp1e-damage-card__row")].filter((row) =>
			isProtectedDetailLabel(rowLabel(row)),
		);

	for (const row of rows) row.hidden = false;
	if (details instanceof HTMLDetailsElement) details.hidden = false;

	/* GM always sees the complete audit. Public means the complete audit is
	 * deliberately exposed for this one Damage ChatMessage. */
	if (game.user?.isGM || damageDetailsArePublic(message)) return;

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
			/* Final damage is already visible in the Damage-card header. */
			row.hidden = true;
		}
	}

	if (details instanceof HTMLDetailsElement) {
		const detailRows = [...details.querySelectorAll(".wfrp1e-damage-card__row")];
		const visibleRows = detailRows.some((row) => !row.hidden);
		details.hidden = !visibleRows;
		if (!visibleRows) details.open = false;
	}
}

function addDamageVisibilityContextOptions(menuItems) {
	if (!game.user?.isGM || !Array.isArray(menuItems)) return;

	menuItems.push(
		{
			label: localize(
				"Damage details: share with players",
				"Szczegóły obrażeń: udostępnij graczom",
			),
			icon: '<i class="fa-solid fa-eye"></i>',
			visible: (target) => {
				const message = messageFromContextTarget(target);
				return isDedicatedDamageMessage(message) && !damageDetailsArePublic(message);
			},
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void setDamageDetailsPublic(message, true);
			},
		},
		{
			label: localize(
				"Damage details: restrict to GM & Actor owner",
				"Szczegóły obrażeń: tylko MG i właściciel Aktora",
			),
			icon: '<i class="fa-solid fa-eye-slash"></i>',
			visible: (target) => {
				const message = messageFromContextTarget(target);
				return isDedicatedDamageMessage(message) && damageDetailsArePublic(message);
			},
			onClick: (_event, target) => {
				const message = messageFromContextTarget(target);
				if (message) void setDamageDetailsPublic(message, false);
			},
		},
	);
}

async function setDamageDetailsPublic(message, makePublic) {
	try {
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only a GM can change Damage-card detail visibility.",
				"Tylko MG może zmieniać widoczność szczegółów karty Obrażeń.",
			));
		}
		if (!isDedicatedDamageMessage(message)) {
			throw new Error(localize(
				"This ChatMessage is not a dedicated Damage card.",
				"Ta wiadomość nie jest dedykowaną kartą Obrażeń.",
			));
		}

		const publicValue = makePublic === true;
		if (damageDetailsArePublic(message) === publicValue) return;

		await message.setFlag(
			FLAG_SCOPE,
			DAMAGE_DETAILS_PUBLIC_FLAG_KEY,
			publicValue,
		);
	} catch (error) {
		console.error("WFRP1ED | Unable to change Damage-card detail visibility.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to change Damage-card detail visibility.",
				"Nie udało się zmienić widoczności szczegółów karty Obrażeń.",
			),
		);
	}
}

function damageDetailsArePublic(message) {
	return message?.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_DETAILS_PUBLIC_FLAG_KEY,
	) === true;
}

function isDedicatedDamageMessage(message) {
	return Boolean(
		message?.id &&
		message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY)?.sourceAttackMessageId,
	);
}

function dedicatedDamageViewForSource(sourceMessageId) {
	const sourceId = String(sourceMessageId ?? "").trim();
	if (!sourceId) return null;
	for (const message of game.messages ?? []) {
		const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		if (String(view?.sourceAttackMessageId ?? "") === sourceId) return message;
	}
	return null;
}

function damageVisibilityChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const scoped = changes?.flags?.[FLAG_SCOPE];
	if (
		scoped &&
		typeof scoped === "object" &&
		(
			Object.hasOwn(scoped, DAMAGE_DETAILS_PUBLIC_FLAG_KEY) ||
			Object.hasOwn(scoped, `-=${DAMAGE_DETAILS_PUBLIC_FLAG_KEY}`)
		)
	) return true;

	return Object.keys(changes).some((key) =>
		String(key).includes(DAMAGE_DETAILS_PUBLIC_FLAG_KEY),
	);
}

function damageApplicationsChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const scoped = changes?.flags?.[FLAG_SCOPE];
	if (
		scoped &&
		typeof scoped === "object" &&
		(
			Object.hasOwn(scoped, DAMAGE_APPLICATIONS_FLAG_KEY) ||
			Object.hasOwn(scoped, `-=${DAMAGE_APPLICATIONS_FLAG_KEY}`)
		)
	) return true;

	const path = `flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined ||
		Object.keys(changes).some((key) => String(key).includes(DAMAGE_APPLICATIONS_FLAG_KEY));
}

function scheduleVisibleDamageRefresh(actor) {
	requestAnimationFrame(() => {
		refreshVisibleDamageCardsForActor(actor);
		setTimeout(() => refreshVisibleDamageCardsForActor(actor), 0);
	});
}

function refreshVisibleDamageCardsForActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	for (const message of game.messages ?? []) {
		const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		if (!view?.sourceAttackMessageId) continue;
		if (String(view.targetActorUuid ?? "") !== String(actor.uuid ?? "")) continue;
		for (const entry of visibleMessageElements(message.id)) {
			applyPresentation(message, entry);
		}
	}
}

function refreshVisiblePresentation(message) {
	if (!message?.id) return;
	for (const entry of visibleMessageElements(message.id)) {
		applyPresentation(message, entry);
	}
}

function visibleMessageElements(messageId) {
	const id = String(messageId ?? "").trim();
	if (!id) return [];
	return [...document.querySelectorAll(
		`[data-message-id="${cssEscape(id)}"]`,
	)];
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(
		entry?.dataset?.messageId ??
			target?.attr?.("data-message-id") ??
			target?.data?.("message-id") ??
			"",
	).trim();

	return messageId ? game.messages?.get(messageId) ?? null : null;
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

function isProtectedDetailLabel(label) {
	return ATTACKER_DETAIL_LABELS.has(label) ||
		DEFENDER_DETAIL_LABELS.has(label) ||
		FINAL_DAMAGE_LABELS.has(label);
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

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape ? CSS.escape(text) : text.replace(/["\\]/g, "\\$&");
}

function localize(en, pl) {
	return game.i18n.lang === "pl" ? pl : en;
}
