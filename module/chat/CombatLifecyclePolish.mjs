const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";

/**
 * Final presentation pass for the compact Polish-first combat lifecycle.
 *
 * Mechanics remain owned by their combat/damage/critical modules. This layer
 * only removes duplicated/positive status prose, folds diagnostic detail and
 * relocates the already-bound parry-reduction control to the defender's Parry
 * card so Chat reads as Attack -> Defence -> Damage -> Critical.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const root = asElement(html);
	if (!root) return;

	presentAdditionalDamageIdentity(message, root);
	foldDedicatedDamageDetails(message, root);

	/*
	 * Several combat/critical decorators are registered before this final pass.
	 * Run once after the current render cycle so we work with their finished DOM
	 * and move existing controls rather than reimplementing their mechanics.
	 */
	requestAnimationFrame(() => {
		presentAdditionalDamageIdentity(message, root);
		foldDedicatedDamageDetails(message, root);
		removePositiveResolutionNotices(message, root);
		removeDuplicateDetailedFatalControls(message, root);
		relocatePendingParryControl(message);
	});
});

function presentAdditionalDamageIdentity(message, root) {
	const marker = message?.getFlag?.(
		FLAG_SCOPE,
		ADDITIONAL_DAMAGE_FLAG_KEY,
	);
	if (!marker) return;

	const label = localize("Additional Damage", "Obrażenia dodatkowe");
	const identityValue = root.querySelector?.("[data-wfrp-test-display-name]");
	if (identityValue) identityValue.textContent = label;

	/* Compatibility with an undecorated/older TestResult card. */
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

	/*
	 * Target, hit location and the editable damage roll stay visible. Strength,
	 * armour, Toughness, Additional Damage and other audit rows are folded.
	 */
	const detailsRows = rows.slice(3);
	const details = document.createElement("details");
	details.className = "wfrp1e-damage-card__details";
	details.dataset.wfrpDamageFoldedDetails = "";

	const summary = document.createElement("summary");
	summary.textContent = localize("Damage details", "Szczegóły obrażeń");
	details.append(summary);

	const body = document.createElement("div");
	body.className = "wfrp1e-damage-card__details-body";
	for (const row of detailsRows) body.append(row);
	details.append(body);

	const status = card.querySelector("[data-wfrp-damage-result-status]");
	card.insertBefore(details, status ?? null);
}

/**
 * Apply button present = pending action. No button = already resolved.
 * Keep explicit invalidation/revert warnings, but remove redundant prose such as
 * "damage resolved — ready to apply" or "critical result applied — resolved".
 */
function removePositiveResolutionNotices(message, root) {
	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (view) {
		const card = root.matches?.("[data-wfrp-combat-damage-result-card]")
			? root
			: root.querySelector?.("[data-wfrp-combat-damage-result-card]");
		const status = card?.querySelector?.("[data-wfrp-damage-result-status]");
		if (status && !isInvalidationNotice(status)) status.remove();
	}

	/* Source Attack damage audit/status prose is redundant with the Damage card. */
	for (const status of root.querySelectorAll?.(
		".combat-damage-context__status",
	) ?? []) {
		if (!isInvalidationNotice(status)) status.remove();
	}

	/*
	 * A resolved detailed-critical marker on the source Damage/Attack card adds no
	 * information once the resolve control has disappeared. The separate critical
	 * result card is the authoritative presentation.
	 */
	for (const resolved of root.querySelectorAll?.(
		".wfrp1e-critical-result__resolved",
	) ?? []) {
		if (!isInvalidationNotice(resolved)) resolved.remove();
	}

	/*
	 * Once a non-fatal Critical Wound is materialized, remove its positive status
	 * and "Open wound" convenience panel from the result card. The wound remains
	 * available from the Actor; the absence of Apply Critical Wound now means the
	 * result is resolved, matching the same visual language as Damage.
	 */
	for (const panel of root.querySelectorAll?.(
		"[data-wfrp-critical-wound-application]",
	) ?? []) {
		if (panel.querySelector(".wfrp1e-fate-intervention__spent")) {
			panel.remove();
		}
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

	const sourcePanel = attackEntry.querySelector(
		"[data-wfrp-combat-damage] .combat-damage-context__pending-parry",
	);
	if (!sourcePanel) return;

	const defencePanel = defenceEntry.querySelector(
		"[data-wfrp-combat-defence-context]",
	) ?? defenceEntry.querySelector(".wfrp1e-test-card");
	if (!defencePanel) return;

	defencePanel.querySelector(
		"[data-wfrp-relocated-parry-reduction]",
	)?.remove();

	sourcePanel.dataset.wfrpRelocatedParryReduction = "";
	sourcePanel.classList.add("is-relocated-to-defence");
	defencePanel.append(sourcePanel);

	const wrapper = attackEntry.querySelector("[data-wfrp-combat-damage]");
	if (wrapper && !wrapper.children.length) wrapper.remove();
}

function removeDuplicateDetailedFatalControls(message, root) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (
		state?.kind !== "detailed" ||
		state?.resolution?.outcome !== "killed"
	) return;

	const card = root.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	/*
	 * FatalCriticalIntegration owns the mechanics for every fatal result, while
	 * DetailedFatalCriticalPresentation adapts those mechanics to this template.
	 * Remove only duplicate generic panels and leave the detailed lifecycle panel.
	 */
	for (const panel of card.querySelectorAll(
		"[data-wfrp-fatal-application], [data-wfrp-fate-intervention]",
	)) {
		if (panel.matches("[data-wfrp-detailed-fatal-lifecycle]")) continue;
		if (panel.closest("[data-wfrp-detailed-fatal-lifecycle]")) continue;
		panel.remove();
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
