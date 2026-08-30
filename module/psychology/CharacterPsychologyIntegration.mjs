const PSYCHOLOGY_TYPE = "psychology";
const FLAG_SCOPE = "wfrp1ed";
const RACE_GRANT_FLAG = "racePsychologyGrant";

Hooks.once("ready", () => {
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

	const heading = document.createElement("div");
	heading.className = "classic-psychology-panel__heading";
	const title = document.createElement("strong");
	title.textContent = localize("Psychology", "Psychologia");
	heading.append(title);
	const hint = document.createElement("span");
	hint.textContent = editable
		? localize("Drop Psychology", "Upuść Psychologię")
		: localize("Psychology", "Psychologia");
	heading.append(hint);
	panel.append(heading);

	const list = document.createElement("div");
	list.className = "classic-psychology-list";
	const items = [...(actor.items ?? [])].filter((item) => item?.type === PSYCHOLOGY_TYPE);
	if (!items.length) {
		const empty = document.createElement("div");
		empty.className = "classic-psychology-empty";
		empty.textContent = editable
			? localize("Drop a Psychology Item here.", "Upuść tutaj Przedmiot Psychologii.")
			: localize("No Psychology entries.", "Brak wpisów Psychologii.");
		list.append(empty);
	} else {
		for (const item of items) list.append(psychologyRow(item, editable));
	}
	panel.append(list);

	if (editable) installDropListeners(panel, actor);
}

function psychologyRow(item, editable) {
	const row = document.createElement("div");
	row.className = "classic-psychology-row";
	row.dataset.itemId = String(item.id ?? "");
	const raceGrant = Boolean(item.getFlag?.(FLAG_SCOPE, RACE_GRANT_FLAG));
	if (raceGrant) row.classList.add("is-race-granted");
	row.title = String(item.system?.description ?? "").trim() || item.name;

	const name = document.createElement("button");
	name.type = "button";
	name.className = "classic-psychology-row__name";
	name.textContent = String(item.name ?? "");
	name.addEventListener("click", (event) => {
		event.preventDefault();
		void item.sheet?.render({ force: true });
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

	if (editable && !raceGrant) {
		const remove = iconButton("fa-solid fa-trash", localize("Remove Psychology", "Usuń Psychologię"));
		remove.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void item.delete().catch(reportError);
		});
		row.append(remove);
	}
	return row;
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
	if ([...(actor.items ?? [])].some((item) => item.type === PSYCHOLOGY_TYPE && canonicalIdentity(item) === identity)) {
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

function iconButton(iconClass, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "classic-psychology-row__remove";
	button.title = title;
	button.setAttribute("aria-label", title);
	const icon = document.createElement("i");
	icon.className = iconClass;
	button.append(icon);
	return button;
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
