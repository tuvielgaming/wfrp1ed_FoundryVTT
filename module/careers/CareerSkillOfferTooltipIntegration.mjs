import { CareerProgression } from "./CareerProgression.mjs";

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	const root = asElement(element) ?? asElement(application.element);
	if (!(root instanceof HTMLElement)) return;
	const sheet = root.classList.contains("wfrp1ed-classic-sheet")
		? root
		: root.querySelector(".wfrp1ed-classic-sheet");
	if (!(sheet instanceof HTMLElement)) return;

	for (const button of sheet.querySelectorAll("[data-career-skill-offer]")) {
		const key = String(button.dataset.careerSkillOffer ?? "");
		const offer = key ? CareerProgression.skillOffer(actor, key) : null;
		if (!offer) continue;

		const purchaseHint = localize(
			`Ctrl/Cmd + click: buy. ${offer.careerName} — ${offer.cost} XP`,
			`Ctrl/Cmd + klik: kup. ${offer.careerName} — ${offer.cost} PD`,
		);
		button.title = purchaseHint;
		button.setAttribute("aria-label", `${offer.name}. ${purchaseHint}`);
	}
});

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
