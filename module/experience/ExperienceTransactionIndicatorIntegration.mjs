import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";
import { ExperienceTransactionService } from "./ExperienceTransactionService.mjs";

const PURCHASE_CLASS = "is-experience-transaction-purchase";
const BADGE_CLASS = "experience-transaction-purchase-badge";

Hooks.on("renderApplicationV2", (application, element) => {
	if (!(application instanceof ClassicActorSheet)) return;
	const actor = application.document;
	if (
		actor?.documentName !== "Actor" ||
		actor.type !== "character" ||
		!(element instanceof HTMLElement) ||
		!element.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	markCharacteristicPurchases(actor, element);
	markCareerSkillPurchases(actor, element);
});

function markCharacteristicPurchases(actor, root) {
	const events = ExperienceTransactionService.activeEvents(actor, "characteristic-advance");
	if (!events.length) return;

	const counts = new Map();
	for (const event of events) {
		const key = normalizeCharacteristic(event.storageKey || event.characteristic);
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	for (const button of root.querySelectorAll('.characteristic-cell--advances[data-characteristic]')) {
		if (!(button instanceof HTMLElement)) continue;
		const key = normalizeCharacteristic(button.dataset.characteristic);
		const count = counts.get(key) ?? 0;
		if (count < 1) continue;

		button.classList.add(PURCHASE_CLASS);
		button.dataset.experienceTransactionPurchases = String(count);
		appendBadge(button, count, localize(
			count === 1
				? "Purchased in the current Experience transaction. Shift + click to undo this purchase."
				: `${count} advances were purchased here in the current Experience transaction. Shift + click to undo one purchase.`,
			count === 1
				? "Kupiono w bieżącej transakcji PD. Shift + kliknięcie cofa ten zakup."
				: `W bieżącej transakcji PD kupiono tu ${count} rozwinięcia. Shift + kliknięcie cofa jeden zakup.`,
		));
	}
}

function markCareerSkillPurchases(actor, root) {
	const events = ExperienceTransactionService.activeEvents(actor, "career-skill");
	if (!events.length) return;

	const refundableIds = new Set(events.map((event) => String(event.skillItemId ?? "")).filter(Boolean));
	for (const row of root.querySelectorAll('.skill-row[data-item-id]')) {
		if (!(row instanceof HTMLElement)) continue;
		const itemId = String(row.dataset.itemId ?? "");
		if (!refundableIds.has(itemId)) continue;

		row.classList.add(PURCHASE_CLASS);
		row.dataset.experienceTransactionPurchases = "1";
		appendBadge(row, 1, localize(
			"Purchased in the current Experience transaction. Shift + click the Skill name to undo this purchase.",
			"Kupiono w bieżącej transakcji PD. Shift + kliknięcie nazwy Umiejętności cofa ten zakup.",
		));
	}
}

function appendBadge(container, count, title) {
	if (container.querySelector(`.${BADGE_CLASS}`)) return;
	const badge = document.createElement("span");
	badge.className = BADGE_CLASS;
	badge.textContent = count > 1 ? `−${count}` : "−";
	badge.title = title;
	badge.setAttribute("aria-label", title);
	badge.setAttribute("aria-hidden", "true");
	container.append(badge);
}

function normalizeCharacteristic(value) {
	const key = String(value ?? "").trim().toLowerCase();
	return key === "sp" ? "m" : key;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
