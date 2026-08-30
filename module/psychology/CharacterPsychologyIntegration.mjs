import { PsychologyHealthManagerWindow } from "./PsychologyHealthManagerWindow.mjs";

const PSYCHOLOGY_TYPE = "psychology";
const FLAG_SCOPE = "wfrp1ed";
const RACE_GRANT_FLAG = "racePsychologyGrant";

Hooks.once("ready", () => {
	ensurePsychologyPanelStyles();
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
		renderPsychologyPanel(section, actor, application.isEditable === true);
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

function renderPsychologyPanel(section, actor, editable) {
	section.classList.add("classic-psychology-sector");
	let panel = section.querySelector(":scope > .classic-psychology-panel");
	if (!(panel instanceof HTMLElement)) {
		panel = document.createElement("div");
		panel.className = "classic-psychology-panel";
		const health = section.querySelector(":scope > .classic-health-categories");
		if (health) section.insertBefore(panel, health);
		else section.prepend(panel);
	}
	panel.replaceChildren();
	panel.title = editable
		? localize("Drop a Psychology Item anywhere on this Character sheet.", "Upuść Przedmiot Psychologii w dowolnym miejscu tej karty Postaci.")
		: localize("Psychology and Health", "Psychika i Zdrowie");

	panel.append(managerLauncher(actor));

	const list = document.createElement("div");
	list.className = "classic-psychology-list";
	const items = psychologyItems(actor);
	if (!items.length) {
		const empty = document.createElement("div");
		empty.className = "classic-psychology-empty";
		empty.textContent = editable
			? localize("Drop Psychology", "Upuść Psychologię")
			: "—";
		list.append(empty);
	} else {
		for (const item of items) list.append(psychologyRow(item, actor));
	}
	panel.append(list);

	/* Keep the local target operational as a fallback. The sheet-level
	 * single-destination router normally handles Psychology first. */
	if (editable) installDropListeners(panel, actor);
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
	label.className = "classic-health-category__label";
	label.textContent = localize("Psychology & Health", "Psychika i Zdrowie");
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

function psychologyRow(item, actor) {
	const row = document.createElement("div");
	row.className = "classic-psychology-row";
	row.dataset.itemId = String(item.id ?? "");
	const raceGrant = Boolean(item.getFlag?.(FLAG_SCOPE, RACE_GRANT_FLAG));
	if (raceGrant) row.classList.add("is-race-granted");
	row.title = localize(
		`Open Psychology and Health Manager — ${item.name}`,
		`Otwórz menedżer Psychiki i Zdrowia — ${item.name}`,
	);

	const name = document.createElement("button");
	name.type = "button";
	name.className = "classic-psychology-row__name";
	name.textContent = String(item.name ?? "");
	name.addEventListener("click", (event) => {
		event.preventDefault();
		void PsychologyHealthManagerWindow.open(actor, { tab: "psychology" }).catch(reportError);
	});
	row.append(name);

	if (raceGrant) {
		const badge = document.createElement("span");
		badge.className = "classic-psychology-row__source";
		badge.textContent = localize("Race", "Rasa");
		badge.title = localize(
			"This Psychology entry is managed by the Character's Race.",
			"Ten wpis Psychologii jest zarządzany przez Rasę Postaci.",
		);
		row.append(badge);
	}
	return row;
}

function psychologyItems(actor) {
	return [...(actor.items ?? [])]
		.filter((item) => item?.type === PSYCHOLOGY_TYPE)
		.sort((a, b) => String(a.name ?? "").localeCompare(
			String(b.name ?? ""), game.i18n.lang, { sensitivity: "base" },
		));
}

function installDropListeners(panel, actor) {
	if (panel.dataset.psychologyDropBound === "true") return;
	panel.dataset.psychologyDropBound = "true";

	for (const eventName of ["dragenter", "dragover"]) {
		panel.addEventListener(eventName, (event) => {
			const data = dragData(event);
			if (String(data?.type ?? "") !== "Item") return;
			event.preventDefault();
			panel.classList.add("is-psychology-drag-over");
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});
	}

	panel.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && panel.contains(event.relatedTarget)) return;
		panel.classList.remove("is-psychology-drag-over");
	});

	panel.addEventListener("drop", (event) => {
		const data = dragData(event);
		if (String(data?.type ?? "") !== "Item") return;
		event.preventDefault();
		event.stopImmediatePropagation();
		panel.classList.remove("is-psychology-drag-over");
		void embedPsychologyFromDrop(actor, data).catch(reportError);
	}, true);
}

async function embedPsychologyFromDrop(actor, data) {
	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return warnWrongDrop();
	const source = await foundry.utils.fromUuid(uuid);
	if (!(source instanceof foundry.documents.Item) || source.type !== PSYCHOLOGY_TYPE) return warnWrongDrop();

	const identity = canonicalIdentity(source);
	if (psychologyItems(actor).some((item) => canonicalIdentity(item) === identity)) {
		ui.notifications.warn(localize(
			`${source.name} is already on this Character.`,
			`${source.name} jest już na tej Postaci.`,
		));
		return;
	}

	const dataObject = source.toObject();
	delete dataObject._id;
	delete dataObject.folder;
	delete dataObject.sort;
	delete dataObject.ownership;
	await actor.createEmbeddedDocuments("Item", [dataObject]);
}

function canonicalIdentity(item) {
	const rulesId = normalize(item?.system?.rulesId);
	return rulesId || normalize(item?.name);
}

function dragData(event) {
	try {
		return foundry.applications.ux.TextEditor.getDragEventData(event) ?? {};
	} catch (_error) {
		return {};
	}
}

function warnWrongDrop() {
	ui.notifications.warn(localize("Drop a Psychology Item here.", "Upuść tutaj Przedmiot Psychologii."));
}

function ensurePsychologyPanelStyles() {
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
		bottom: 44px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-height: 0;
		margin: 0;
		padding: 2px 3px;
		border: 1px solid transparent;
		border-radius: 2px;
		background: transparent;
		box-shadow: none;
		overflow: hidden;
		pointer-events: auto;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-health-launcher {
		flex: 0 0 auto;
		align-self: stretch;
		width: 100%;
		height: 21px;
		min-height: 21px;
		margin: 0;
		padding: 1px 4px;
		font-size: 8px;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-health-launcher .classic-health-category__count {
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		font-size: 7px;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-list {
		display: block;
		flex: 1 1 auto;
		width: 100%;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: thin;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 2px;
		font-size: 8px;
		font-style: italic;
		text-align: center;
		color: rgb(30 22 16 / 55%);
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 2px;
		min-height: 18px;
		padding: 1px 0;
		border-bottom: 1px solid rgb(0 0 0 / 15%);
		background: rgb(255 255 255 / 18%);
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-row:hover {
		background: rgb(255 255 255 / 40%);
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-row__name {
		display: block;
		min-width: 0;
		height: 16px;
		margin: 0;
		padding: 0 2px;
		border: 0;
		background: transparent;
		box-shadow: none;
		overflow: hidden;
		font-family: "Book Antiqua", "Times New Roman", serif;
		font-size: 8.5px;
		font-weight: 700;
		line-height: 16px;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #18120e;
	}
	.wfrp1ed-classic-sheet .sheet-overlay--psychology .classic-psychology-row__source {
		display: inline-flex;
		align-items: center;
		height: 13px;
		padding: 0 3px;
		border: 1px solid rgb(98 61 35 / 42%);
		border-radius: 4px;
		background: rgb(235 219 183 / 72%);
		font-size: 6.5px;
		font-weight: 700;
		line-height: 12px;
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

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function reportError(error) {
	console.error("WFRP1ED | Character Psychology interaction failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
