import {
	actorForTestMessage,
	canSeeFullTestDetails,
} from "../tests/TestResultAudienceVisibility.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_FLAG_KEY = "combatDefenceResult";
const TARGET_CONTEXT_FLAG_KEY = "testTargetContext";

/**
 * Compact identity treatment shared by generic Tests and combat Tests.
 *
 * The generic TestResult card keeps ownership of target breakdown, modifier
 * adjudication, editable d100 and margin. This layer owns the safe public
 * identity summary: Actor portrait, what Test/action was used, and the target
 * Actor name when one exists. Mechanical target values never enter this layer.
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

	const actor = actorForTestMessage(message);
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
	fields.append(identityRow(localize("Test", "Test"), displayName, {
		valueData: "wfrpTestDisplayName",
	}));

	const targetName = targetDisplayName(message);
	if (targetName) {
		fields.append(identityRow(localize("Target", "Cel"), targetName));
	}

	identity.append(portrait, fields);
	originalTitle.replaceWith(identity);
	header.classList.add("has-test-identity");
	header.dataset.wfrpIdentityDecorated = "true";
}

function identityRow(labelText, valueText, { valueData = "" } = {}) {
	const row = document.createElement("div");
	row.classList.add("wfrp1e-test-card__identity-row");
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	if (valueData) value.dataset[valueData] = "";
	value.textContent = String(valueText ?? "—");
	row.append(label, value);
	return row;
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
		if (!canSeeFullTestDetails(message)) {
			return localize("Parry", "Parowanie");
		}
		const itemName = String(defence.itemName ?? "").trim();
		return itemName
			? `${localize("Parry", "Parowanie")} — ${itemName}`
			: localize("Parry", "Parowanie");
	}

	return String(fallback ?? localize("Test", "Test"));
}

function targetDisplayName(message) {
	const generic = message?.getFlag?.(FLAG_SCOPE, TARGET_CONTEXT_FLAG_KEY);
	const genericName = String(generic?.name ?? "").trim();
	if (genericName) return genericName;

	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.targetMode === "defender") {
		return String(attack.target?.name ?? "").trim();
	}

	return "";
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
