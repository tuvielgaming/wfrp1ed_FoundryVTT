const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_FLAG_KEY = "combatDefenceResult";

/**
 * Compact identity treatment shared by generic Tests and combat Tests.
 *
 * The generic TestResult card keeps ownership of target breakdown, modifier
 * adjudication, editable d100 and margin. This layer only changes the visual
 * identity header and, for attacks, removes duplicated combat metadata which is
 * already obvious from the selected Weapon and Combatant state.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!card) return;

	decorateIdentity(message, card);
	compactAttackContext(message, card);
});

function decorateIdentity(message, card) {
	const header = card.querySelector(".wfrp1e-test-card__header");
	if (!header || header.dataset.wfrpIdentityDecorated === "true") return;

	const originalTitle = header.querySelector("h2");
	if (!originalTitle) return;

	const actor = actorForMessage(message);
	const displayName = testDisplayName(message, originalTitle.textContent);
	const identity = document.createElement("div");
	identity.classList.add("wfrp1e-test-card__identity");

	const portrait = document.createElement("img");
	portrait.classList.add("wfrp1e-test-card__portrait");
	portrait.src = String(actor?.img ?? "icons/svg/mystery-man.svg");
	portrait.alt = String(actor?.name ?? "");
	portrait.loading = "lazy";

	const fields = document.createElement("div");
	fields.classList.add("wfrp1e-test-card__identity-fields");

	const testRow = document.createElement("div");
	testRow.classList.add("wfrp1e-test-card__identity-row");
	const label = document.createElement("span");
	label.textContent = localize("Test", "Test");
	const value = document.createElement("strong");
	value.dataset.wfrpTestDisplayName = "";
	value.textContent = displayName;
	testRow.append(label, value);
	fields.append(testRow);

	identity.append(portrait, fields);
	originalTitle.replaceWith(identity);
	header.classList.add("has-test-identity");
	header.dataset.wfrpIdentityDecorated = "true";
}

function compactAttackContext(message, card) {
	const attackState = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (!attackState) return;

	const panel = card.querySelector("[data-wfrp-combat-attack-context]");
	if (!panel) return;

	panel.classList.add("is-compact");
	panel.querySelector(".combat-attack-context__heading")?.remove();

	for (const row of panel.querySelectorAll(".combat-attack-context__row")) {
		const label = String(row.querySelector(":scope > span")?.textContent ?? "")
			.trim()
			.toLowerCase();
		if (label === "attacks spent" || label === "zużyte ataki") {
			row.remove();
		}
	}
}

function testDisplayName(message, fallback) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.weapon?.name) {
		return String(attack.weapon.name);
	}

	const defence = message?.getFlag?.(FLAG_SCOPE, DEFENCE_FLAG_KEY);
	if (defence?.response === "dodge") {
		return localize("Dodge Blow", "Uniki");
	}
	if (defence?.response === "parry") {
		const itemName = String(defence.itemName ?? "").trim();
		return itemName
			? `${localize("Parry", "Parowanie")} — ${itemName}`
			: localize("Parry", "Parowanie");
	}

	return String(fallback ?? localize("Test", "Test"));
}

function actorForMessage(message) {
	const speaker = message?.speaker ?? {};
	const sceneId = String(speaker.scene ?? "").trim();
	const tokenId = String(speaker.token ?? "").trim();
	if (sceneId && tokenId) {
		const token = game.scenes?.get(sceneId)?.tokens?.get(tokenId);
		if (token?.actor?.documentName === "Actor") return token.actor;
	}

	const actorId = String(speaker.actor ?? "").trim();
	if (actorId) {
		const actor = game.actors?.get(actorId);
		if (actor?.documentName === "Actor") return actor;
	}

	return null;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
