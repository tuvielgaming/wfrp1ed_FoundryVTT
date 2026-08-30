import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const STYLE_ID = "wfrp1ed-career-skill-drop-hint-style";

install();

function install() {
	installStyle();
	if (CareerItemSheet.prototype.__wfrpCareerSkillDropHintInstalled === true) return;
	const originalRender = CareerItemSheet.prototype._onRender;
	CareerItemSheet.prototype._onRender = function careerSkillDropHintRender(context, options) {
		originalRender.call(this, context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement)) return;
		const hint = root.querySelector('[data-career-panel="skills"] .career-compact-drop-hint');
		if (!(hint instanceof HTMLElement)) return;
		hint.innerHTML = `<i class="fa-solid fa-arrow-down"></i><span>${escapeHtml(localize(
			"Drop a Skill anywhere on this Career sheet to add it to the free Skill list. Drop a package member here to detach it from its package.",
			"Upuść Umiejętność w dowolnym miejscu tej karty Profesji, aby dodać ją do listy wolnych Umiejętności. Upuść tutaj element pakietu, aby odłączyć go od pakietu.",
		))}</span>`;
	};
	Object.defineProperty(CareerItemSheet.prototype, "__wfrpCareerSkillDropHintInstalled", { value: true });
}

function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.career-item-sheet [data-career-panel="skills"] .career-compact-drop-hint {
			display: flex;
			align-items: flex-start;
			gap: 8px;
			margin: 0 0 8px;
			padding: 8px 10px;
			border: 1px solid rgb(91 65 39 / 30%);
			border-left: 3px solid rgb(122 0 25 / 36%);
			background: rgb(255 250 235 / 38%);
			font-size: 11px;
			font-style: normal;
			line-height: 1.35;
			color: #564838;
		}
		.career-item-sheet [data-career-panel="skills"] .career-compact-drop-hint i {
			margin-top: 2px;
			font-size: 10px;
			color: #6f1721;
			opacity: .85;
		}
		.career-item-sheet [data-career-panel="skills"] .career-compact-drop-hint.wfrp1ed-skill-drop-over {
			border-color: #8d1c24;
			background: rgb(141 28 36 / 10%) !important;
			color: #3e231f;
		}
	`;
	document.head.append(style);
}

function escapeHtml(value) {
	return foundry.utils.escapeHTML(String(value ?? ""));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
