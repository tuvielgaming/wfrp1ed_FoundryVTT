const FLAG_SCOPE = "wfrp1ed";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";

/**
 * Final presentation pass for the compact Polish-first combat lifecycle.
 *
 * Mechanics remain owned by their combat/damage/critical modules. This layer
 * only removes duplicated controls and folds diagnostic detail so Chat reads as
 * Attack -> Defence -> Damage -> Critical instead of a wall of calculations.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const root = asElement(html);
	if (!root) return;

	presentAdditionalDamageIdentity(message, root);
	foldDedicatedDamageDetails(message, root);
	removeDuplicateDetailedFatalControls(message, root);
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
	if (rows.length <= 2) return;

	/* Keep only the at-a-glance identity: target and hit location. */
	const detailsRows = rows.slice(2);
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
	 * The generic adapter also sees data-wfrp-critical-card, so remove only its
	 * duplicate generic panels and leave the detailed lifecycle panel intact.
	 */
	for (const panel of card.querySelectorAll(
		"[data-wfrp-fatal-application], [data-wfrp-fate-intervention]",
	)) {
		if (panel.matches("[data-wfrp-detailed-fatal-lifecycle]")) continue;
		if (panel.closest("[data-wfrp-detailed-fatal-lifecycle]")) continue;
		panel.remove();
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
