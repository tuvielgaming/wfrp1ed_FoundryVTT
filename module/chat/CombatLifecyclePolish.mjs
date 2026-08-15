import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const focusedLifecycleStages = new Set();

/**
 * Final presentation pass for the compact combat lifecycle.
 *
 * Mechanics remain owned by their combat/damage/critical modules. This layer
 * removes duplicated/positive state prose, folds diagnostic detail and moves the
 * already-bound Parry-reduction control into the defender's Parry context.
 *
 * Critical application also updates Actor/Item state after the original Chat
 * render has completed. Therefore this pass is repeated after those state hooks,
 * not only during the initial renderChatMessageHTML callback.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const root = asElement(html);
		if (!root) return;

		presentAdditionalDamageIdentity(message, root);
		foldDedicatedDamageDetails(message, root);
		scheduleFinalPass(message, root);
	});

	Hooks.on("updateActor", () => scheduleVisibleCriticalCleanup());
	Hooks.on("createItem", (item) => {
		if (item?.type === "criticalWound") scheduleVisibleCriticalCleanup();
	});
	Hooks.on("deleteItem", (item) => {
		if (item?.type === "criticalWound") scheduleVisibleCriticalCleanup();
	});
});

function scheduleFinalPass(message, root) {
	requestAnimationFrame(() => {
		runFinalPass(message, root);
		/* Direct Actor/Item decorators may run from the same animation frame. */
		setTimeout(() => runFinalPass(message, root), 0);
	});
}

function runFinalPass(message, root) {
	if (!root?.isConnected && !root?.matches?.("[data-message-id]")) return;
	presentAdditionalDamageIdentity(message, root);
	foldDedicatedDamageDetails(message, root);
	removePositiveResolutionNotices(message, root);
	removeDuplicateDetailedFatalControls(message, root);
	lockAppliedFatalCriticalRoll(message, root);
	relocatePendingParryControl(message);
	maybeFocusRevertedDamage(message);
}

function scheduleVisibleCriticalCleanup() {
	requestAnimationFrame(() => {
		cleanupVisibleCriticalCards();
		setTimeout(cleanupVisibleCriticalCards, 0);
	});
}

function cleanupVisibleCriticalCards() {
	for (const message of game.messages ?? []) {
		if (!message.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY)) continue;
		const entry = document.querySelector(
			`[data-message-id="${cssEscape(message.id)}"]`,
		);
		if (!entry) continue;
		removePositiveResolutionNotices(message, entry);
		removeDuplicateDetailedFatalControls(message, entry);
		lockAppliedFatalCriticalRoll(message, entry);
	}
}

function presentAdditionalDamageIdentity(message, root) {
	const marker = message?.getFlag?.(FLAG_SCOPE, ADDITIONAL_DAMAGE_FLAG_KEY);
	if (!marker) return;

	const label = localize("Additional Damage", "Obrażenia dodatkowe");
	const identityValue = root.querySelector?.("[data-wfrp-test-display-name]");
	if (identityValue) identityValue.textContent = label;
	const heading = root.querySelector?.(".wfrp1e-test-card__header h2");
	if (heading) heading.textContent = label;
}

function foldDedicatedDamageDetails(message, root) {
	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view) return;

	const card = root.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!card || card.querySelector("[data-wfrp-damage-folded-details]")) return;

	const rows = [...card.querySelectorAll(":scope > .wfrp1e-damage-card__row")];
	if (rows.length <= 3) return;

	/* Target, hit location and editable Roll stay visible. */
	const details = document.createElement("details");
	details.className = "wfrp1e-damage-card__details";
	details.dataset.wfrpDamageFoldedDetails = "";
	const summary = document.createElement("summary");
	summary.textContent = localize("Damage details", "Szczegóły obrażeń");
	details.append(summary);
	const body = document.createElement("div");
	body.className = "wfrp1e-damage-card__details-body";
	for (const row of rows.slice(3)) body.append(row);
	details.append(body);
	const status = card.querySelector("[data-wfrp-damage-result-status]");
	card.insertBefore(details, status ?? null);
}

/** Button present = pending action; no button = resolved. */
function removePositiveResolutionNotices(message, root) {
	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (view) {
		const card = root.matches?.("[data-wfrp-combat-damage-result-card]")
			? root
			: root.querySelector?.("[data-wfrp-combat-damage-result-card]");
		const status = card?.querySelector?.("[data-wfrp-damage-result-status]");
		if (status && !isInvalidationNotice(status)) status.remove();
	}

	for (const status of root.querySelectorAll?.(".combat-damage-context__status") ?? []) {
		if (!isInvalidationNotice(status)) status.remove();
	}
	for (const resolved of root.querySelectorAll?.(".wfrp1e-critical-result__resolved") ?? []) {
		if (!isInvalidationNotice(resolved)) resolved.remove();
	}

	/*
	 * Do not rely on the renderer's status text to decide whether a wound has been
	 * applied. Resolve the linked persistent Item directly; when it exists, the
	 * whole Apply/Open panel is redundant and must disappear.
	 */
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	const woundApplied = Boolean(linkedCriticalWound(message, state));
	for (const panel of root.querySelectorAll?.("[data-wfrp-critical-wound-application]") ?? []) {
		if (
			woundApplied ||
			panel.querySelector(".wfrp1e-fate-intervention__spent")
		) panel.remove();
	}
}

function isInvalidationNotice(element) {
	if (!(element instanceof HTMLElement)) return false;
	if (
		element.classList.contains("is-reverted") ||
		element.classList.contains("is-invalidated")
	) return true;
	const text = String(element.textContent ?? "").toUpperCase();
	return text.includes("REVERTED") ||
		text.includes("COFNIĘTO") ||
		text.includes("INVALIDATED") ||
		text.includes("UNIEWAŻNION");
}

/**
 * CombatDamageIntegration owns and binds the actual reduction button on the
 * source Attack card. Move that existing DOM node to the resolved Parry card;
 * this changes presentation only and preserves permissions/socket mechanics.
 *
 * Invalidated damage deliberately leaves its historical Chat cards in place.
 * Therefore the relocated control must also be removed explicitly when the
 * authoritative attack is no longer in the awaiting-parry stage; otherwise an
 * old live-looking button survives on a historical Parry card.
 */
function relocatePendingParryControl(message) {
	const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attackState?.defence?.testMessageId) {
		movePendingParryControl(
			message,
			game.messages?.get(String(attackState.defence.testMessageId)),
		);
		return;
	}

	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
	if (!defence?.attackMessageId) return;
	movePendingParryControl(
		game.messages?.get(String(defence.attackMessageId)),
		message,
	);
}

function movePendingParryControl(attackMessage, defenceMessage) {
	if (!attackMessage?.id || !defenceMessage?.id) return;
	const attackEntry = document.querySelector(
		`[data-message-id="${cssEscape(attackMessage.id)}"]`,
	);
	const defenceEntry = document.querySelector(
		`[data-message-id="${cssEscape(defenceMessage.id)}"]`,
	);
	if (!attackEntry || !defenceEntry) return;

	const rollState = attackMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const damageState = attackMessage.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const pending = Boolean(
		!damageState &&
		rollState?.status === "awaiting-parry" &&
		rollState?.parry?.succeeded === true,
	);
	const previous = defenceEntry.querySelector(
		"[data-wfrp-relocated-parry-reduction]",
	);

	/* A historical/invalidation render must never leave an actionable stale roll. */
	if (!pending) {
		previous?.remove();
		return;
	}

	const sourcePanel = attackEntry.querySelector(
		"[data-wfrp-combat-damage] .combat-damage-context__pending-parry",
	);
	if (!sourcePanel) {
		/* It may already have been moved during an earlier render of the same stage. */
		if (previous) maybeFocusPendingParry(attackMessage, defenceEntry, rollState);
		return;
	}

	const defencePanel = defenceEntry.querySelector(
		"[data-wfrp-combat-defence-result]",
	) ?? defenceEntry.querySelector(".wfrp1e-test-card");
	if (!defencePanel) return;

	previous?.remove();
	sourcePanel.dataset.wfrpRelocatedParryReduction = "";
	sourcePanel.classList.add("is-relocated-to-defence");
	defencePanel.append(sourcePanel);

	const wrapper = attackEntry.querySelector("[data-wfrp-combat-damage]");
	if (wrapper && !wrapper.children.length) wrapper.remove();

	maybeFocusPendingParry(attackMessage, defenceEntry, rollState);
}

/**
 * Keep the audit history instead of deleting invalidated ChatMessages, but take
 * the user to the older Parry card when it becomes the current interactive step.
 * A player is focused only for an Actor they own. The GM is focused only for a
 * GM-controlled defender, avoiding a competing scroll on player-owned Actors.
 */
function maybeFocusPendingParry(attackMessage, defenceEntry, rollState) {
	if (!(defenceEntry instanceof HTMLElement) || !game.user) return;

	const attack = attackMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const defender = actorFromUuidSync(attack?.target?.uuid);
	if (!(defender instanceof foundry.documents.Actor)) return;
	if (!isRelevantController(defender)) return;

	focusChatEntryOnce(
		defenceEntry,
		[
			"parry",
			String(attackMessage.id ?? ""),
			String(rollState?.rolledAt ?? rollState?.updatedAt ?? ""),
			String(rollState?.initialDie ?? ""),
		].join(":"),
	);
}

/**
 * Damage invalidation keeps the old result as an audit record. When that exposes
 * "Roll damage again" on the older source Attack message, center that message for
 * the Actor who is actually responsible for the next roll instead of forcing the
 * user to search backwards through Chat.
 */
function maybeFocusRevertedDamage(message) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	if (!attack || !damageState?.packet?.id) return;

	const defender = actorFromUuidSync(damageState.packet.targetActorUuid);
	if (!(defender instanceof foundry.documents.Actor)) return;
	const transaction = DamageApplication.transactionFor(
		defender,
		damageState.packet.id,
	);
	if (transaction?.state !== "reverted") return;

	const attacker = actorFromUuidSync(attack.attacker?.uuid);
	if (!(attacker instanceof foundry.documents.Actor)) return;
	if (!isRelevantController(attacker)) return;

	const entry = document.querySelector(
		`[data-message-id="${cssEscape(message.id)}"]`,
	);
	if (!(entry instanceof HTMLElement)) return;

	focusChatEntryOnce(
		entry,
		[
			"damage-reroll",
			String(message.id ?? ""),
			String(transaction.revertedAt ?? damageState.updatedAt ?? ""),
		].join(":"),
	);
}

function isRelevantController(actor) {
	if (!(actor instanceof foundry.documents.Actor) || !game.user) return false;
	if (game.user.isGM) return !actorOwnedByPlayer(actor);
	return hasOwnerPermission(actor, game.user);
}

function focusChatEntryOnce(entry, stageKey) {
	if (!(entry instanceof HTMLElement) || !stageKey) return;
	if (focusedLifecycleStages.has(stageKey)) return;
	focusedLifecycleStages.add(stageKey);
	pruneFocusHistory();

	requestAnimationFrame(() => {
		entry.scrollIntoView?.({
			behavior: "smooth",
			block: "center",
			inline: "nearest",
		});
	});
}

function pruneFocusHistory() {
	while (focusedLifecycleStages.size > 100) {
		const oldest = focusedLifecycleStages.values().next().value;
		if (oldest === undefined) return;
		focusedLifecycleStages.delete(oldest);
	}
}

function actorOwnedByPlayer(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return false;
	return [...(game.users ?? [])].some((user) =>
		!user?.isGM && hasOwnerPermission(actor, user),
	);
}

function hasOwnerPermission(actor, user) {
	if (!(actor instanceof foundry.documents.Actor) || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
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

function removeDuplicateDetailedFatalControls(message, root) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (state?.kind !== "detailed" || state?.resolution?.outcome !== "killed") return;
	const card = root.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	for (const panel of card.querySelectorAll(
		"[data-wfrp-fatal-application], [data-wfrp-fate-intervention]",
	)) {
		if (panel.matches("[data-wfrp-detailed-fatal-lifecycle]")) continue;
		if (panel.closest("[data-wfrp-detailed-fatal-lifecycle]")) continue;
		panel.remove();
	}
}

/** Once a fatal consequence is applied its d100 is immutable until rollback. */
function lockAppliedFatalCriticalRoll(message, root) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (state?.kind !== "detailed" || state?.resolution?.outcome !== "killed") return;
	const actor = actorForCriticalResult(state);
	const packetId = String(state.packetId ?? "");
	const fatal = actor?.getFlag?.(FLAG_SCOPE, FATAL_APPLICATIONS_FLAG_KEY)?.[packetId];
	if (fatal?.state !== "applied") return;

	const card = root.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root.querySelector?.("[data-wfrp-detailed-critical-card]");
	const host = card?.querySelector?.("[data-wfrp-detailed-roll]");
	if (!host) return;
	host.classList.remove("wfrp1e-critical-result__roll-editor");
	host.textContent = `${game.i18n.lang === "pl" ? "K100" : "d100"}: ${
		state.resolution?.roll?.total ?? "—"
	}`;
}

function linkedCriticalWound(message, state) {
	if (!state || state.kind !== "detailed") return null;
	const actor = actorForCriticalResult(state);
	if (!(actor instanceof foundry.documents.Actor)) return null;
	return [...(actor.items ?? [])].find((item) =>
		item?.type === "criticalWound" &&
		String(item.system?.resolution?.resultMessageId ?? "") === String(message.id ?? ""),
	) ?? null;
}

function actorForCriticalResult(state) {
	const source = game.messages?.get(String(state?.sourceMessageId ?? ""));
	const damage = source?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	try {
		const document = foundry.utils.fromUuidSync(
			String(damage?.packet?.targetActorUuid ?? ""),
		);
		return document instanceof foundry.documents.Actor
			? document
			: document?.actor instanceof foundry.documents.Actor
				? document.actor
				: null;
	} catch (_error) {
		return null;
	}
}

function cssEscape(value) {
	return globalThis.CSS?.escape
		? CSS.escape(String(value ?? ""))
		: String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
