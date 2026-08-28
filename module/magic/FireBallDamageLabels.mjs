const FLAG_SCOPE = "wfrp1ed";
const VIEW_FLAG_KEY = "fireBallDamageResultView";

/**
 * Keep Fire Ball's dedicated Damage card explicit about what each die means.
 *
 * Older persisted damage cards may still contain DamageChat's generic Target /
 * Source labels. Apply the spell-specific labels at render time as well as for
 * newly rebuilt cards so existing chat history becomes clear immediately.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY)) return;
	requestAnimationFrame(() => relabelFireBallDamageCard(html));
});

function relabelFireBallDamageCard(html) {
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement)) return;

	const rows = [...card.querySelectorAll(":scope > .wfrp1e-damage-card__row")];
	const rollRows = rows.filter((row) => row.querySelector("input[data-fire-ball-damage-die]"));
	for (const row of rollRows) {
		const input = row.querySelector("input[data-fire-ball-damage-die]");
		const label = row.querySelector(":scope > span:first-child");
		if (!(input instanceof HTMLInputElement) || !(label instanceof HTMLElement)) continue;
		if (input.dataset.fireBallDamageDie === "d10") {
			label.textContent = localize("Fire Ball", "Kula Ognia");
		} else if (input.dataset.fireBallDamageDie === "d8") {
			label.textContent = localize("Ignition", "Podpalenie");
		}
	}
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
