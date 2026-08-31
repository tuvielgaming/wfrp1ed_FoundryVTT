import { PsychologyHealthManagerWindow } from "./PsychologyHealthManagerWindow.mjs";

Hooks.once("ready", () => {
	ensurePsychologyLauncherStyles();

	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;

		const root = asElement(element) ?? asElement(application.element);
		const sheet = root?.classList?.contains("wfrp1ed-classic-sheet")
			? root
			: root?.querySelector?.(".wfrp1ed-classic-sheet");
		if (!(sheet instanceof HTMLElement)) return;

		const section = sheet.querySelector('.sheet-overlay--psychology[data-section="psychology"]');
		if (!(section instanceof HTMLElement)) return;

		renderManagerLauncher(section, actor);
	});

	for (const hookName of ["createItem", "updateItem", "deleteItem"]) {
		Hooks.on(hookName, (item) => {
			const actor = item?.parent;
			if (actor?.documentName !== "Actor" || actor.type !== "character") return;
			if (!PsychologyHealthManagerWindow.categories().some((category) => category.itemType === item.type)) return;

			void PsychologyHealthManagerWindow.refresh(actor).catch(reportError);
			if (actor.sheet?.rendered) void actor.sheet.render({ force: true });
		});
	}
});

/**
 * The printed Psychology and Health sector is deliberately only a summary /
 * navigation surface. Detailed records are managed in the large manager window.
 */
function renderManagerLauncher(section, actor) {
	section.classList.add("classic-psychology-sector");

	let panel = section.querySelector(":scope > .classic-psychology-panel");
	if (!(panel instanceof HTMLElement)) {
		panel = document.createElement("div");
		panel.className = "classic-psychology-panel";
		const health = section.querySelector(":scope > .classic-health-categories");
		if (health) section.insertBefore(panel, health);
		else section.prepend(panel);
	}

	panel.replaceChildren(managerLauncher(actor));
	panel.title = localize(
		"Open Psychology and Health Manager",
		"Otwórz menedżer Psychiki i Zdrowia",
	);
}

function managerLauncher(actor) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-health-category classic-psychology-health-launcher";
	button.title = localize(
		"Open Psychology and Health Manager",
		"Otwórz menedżer Psychiki i Zdrowia",
	);
	button.setAttribute("aria-label", button.title);

	const icon = document.createElement("i");
	icon.className = "fas fa-brain";
	icon.setAttribute("aria-hidden", "true");
	button.append(icon);

	const label = document.createElement("span");
	label.className = "classic-health-category__label classic-health-category__label--two-lines";
	const lines = game.i18n.lang === "pl"
		? ["Psychika i", "Zdrowie"]
		: ["Psychology &", "Health"];
	for (const lineText of lines) {
		const line = document.createElement("span");
		line.textContent = lineText;
		label.append(line);
	}
	button.append(label);

	const count = PsychologyHealthManagerWindow.count(actor);
	const badge = document.createElement("span");
	badge.className = "classic-health-category__count";
	badge.textContent = String(count);
	badge.hidden = count === 0;
	button.append(badge);

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void PsychologyHealthManagerWindow.open(actor, { tab: "psychology" }).catch(reportError);
	});

	return button;
}

function ensurePsychologyLauncherStyles() {
	if (document.getElementById("wfrp1ed-character-psychology-layout-style")) return;

	const style = document.createElement("style");
	style.id = "wfrp1ed-character-psychology-layout-style";
	style.textContent = `
	.wfrp1ed-classic-sheet .sheet-overlay--psychology.classic-psychology-sector {
		position: absolute !important;
		pointer-events: none;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-panel {
		position: absolute;
		left: 6px;
		right: 6px;
		top: 70px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
		overflow: visible;
		pointer-events: auto;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-health-launcher {
		width: 100%;
		height: 38px;
		min-height: 38px;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-health-categories {
		pointer-events: auto;
	}
	`;
	document.head.append(style);
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function reportError(error) {
	console.error("WFRP1ED | Character Psychology interaction failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
