const LANGUAGE_TYPE = "language";

Hooks.once("ready", () => {
	ensureLanguageStyles();
	Hooks.on("renderApplicationV2", (application, element) => {
		const race = application?.document;
		if (race?.documentName !== "Item" || race.type !== "race") return;

		const root = asElement(element) ?? asElement(application.element);
		if (!(root instanceof HTMLElement)) return;

		const legacyAdd = root.querySelector('[data-action="addLanguage"]');
		const section = legacyAdd?.closest?.(".race-sheet-panel") ?? findLanguageSection(root);
		if (!(section instanceof HTMLElement)) return;

		renderLanguageAuthoring(section, race, application.isEditable === true);
	});
});

function renderLanguageAuthoring(section, race, editable) {
	section.classList.add("race-language-authoring");
	section.dataset.raceLanguageDropZone = "true";
	section.replaceChildren();

	const heading = document.createElement("div");
	heading.className = "race-section-heading race-language-heading";

	const title = document.createElement("h2");
	title.textContent = localize("Languages", "Języki");
	heading.append(title);

	if (editable) {
		const hint = document.createElement("span");
		hint.className = "race-language-heading-hint";
		hint.textContent = localize("Drop Language Items here", "Upuść tutaj Przedmioty Języka");
		heading.append(hint);
	}
	section.append(heading);

	const help = document.createElement("p");
	help.className = "race-sheet-hint race-language-help";
	help.textContent = editable
		? localize(
			"Drag Language Items from the sidebar into this panel. Race Languages are references to reusable Language Items; edit their name and description on the Language Item.",
			"Przeciągnij Przedmioty Języka z panelu bocznego do tej sekcji. Języki Rasy są odwołaniami do wielokrotnego użytku; nazwę i opis edytuj na Przedmiocie Języka.",
		)
		: localize("Languages granted by this Race.", "Języki przyznawane przez tę Rasę.");
	section.append(help);

	const list = document.createElement("div");
	list.className = "race-language-reference-list";
	const entries = languageEntries(race);

	if (!entries.length) {
		const empty = document.createElement("div");
		empty.className = "race-language-empty";
		empty.innerHTML = `<i class="fa-solid fa-language"></i><span>${editable
			? escapeHtml(localize("Drop a Language Item here.", "Upuść tutaj Przedmiot Języka."))
			: escapeHtml(localize("No racial Languages.", "Brak języków rasowych."))}</span>`;
		list.append(empty);
	} else {
		entries.forEach((entry, index) => list.append(languageRow(entry, index, race, editable)));
	}
	section.append(list);

	if (editable) installDropListeners(section, race);
}

function languageRow(entry, index, race, editable) {
	const row = document.createElement("div");
	row.className = "race-language-reference-row";
	row.dataset.languageIndex = String(index);
	row.title = localize(
		"Double-click to open the referenced Language Item.",
		"Kliknij dwukrotnie, aby otworzyć powiązany Przedmiot Języka.",
	);

	const identity = document.createElement("div");
	identity.className = "race-language-reference-row__identity";

	const icon = document.createElement("i");
	icon.className = "fa-solid fa-language";
	identity.append(icon);

	const name = document.createElement("strong");
	name.textContent = displayName(entry);
	identity.append(name);
	row.append(identity);

	if (editable) {
		const controls = document.createElement("div");
		controls.className = "race-language-reference-row__controls";

		const open = iconButton("fa-solid fa-arrow-up-right-from-square", localize("Open Language", "Otwórz Język"));
		open.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void openLanguageReference(entry).catch(reportError);
		});
		controls.append(open);

		const remove = iconButton("fa-solid fa-trash", localize("Remove from Race", "Usuń z Rasy"));
		remove.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void removeLanguage(race, index).catch(reportError);
		});
		controls.append(remove);
		row.append(controls);
	}

	row.addEventListener("dblclick", (event) => {
		event.preventDefault();
		void openLanguageReference(entry).catch(reportError);
	});
	return row;
}

function installDropListeners(section, race) {
	if (section.dataset.raceLanguageDropBound === "true") return;
	section.dataset.raceLanguageDropBound = "true";

	for (const eventName of ["dragenter", "dragover"]) {
		section.addEventListener(eventName, (event) => {
			const data = dragData(event);
			if (String(data?.type ?? "") !== "Item") return;
			event.preventDefault();
			section.classList.add("is-language-drag-over");
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});
	}

	section.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) return;
		section.classList.remove("is-language-drag-over");
	});

	section.addEventListener("drop", (event) => {
		const data = dragData(event);
		if (String(data?.type ?? "") !== "Item") return;
		event.preventDefault();
		event.stopImmediatePropagation();
		section.classList.remove("is-language-drag-over");
		void addLanguageFromDrop(race, data).catch(reportError);
	}, true);
}

async function addLanguageFromDrop(race, data) {
	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return warnWrongDrop();

	const item = await foundry.utils.fromUuid(uuid);
	if (!(item instanceof foundry.documents.Item) || item.type !== LANGUAGE_TYPE) return warnWrongDrop();

	const reference = languageReference(item);
	const entries = languageEntries(race);
	if (entries.some((entry) => sameLanguage(entry, reference))) {
		ui.notifications.warn(localize(
			`${item.name} is already assigned to this Race.`,
			`${item.name} jest już przypisany do tej Rasy.`,
		));
		return;
	}

	entries.push(reference);
	await race.update({ "system.languages": entries });
}

async function removeLanguage(race, index) {
	const entries = languageEntries(race);
	if (index < 0 || index >= entries.length) return;
	entries.splice(index, 1);
	await race.update({ "system.languages": entries });
}

async function openLanguageReference(reference) {
	const uuid = String(reference?.uuid ?? "").trim();
	if (uuid) {
		try {
			const document = await foundry.utils.fromUuid(uuid);
			if (document instanceof foundry.documents.Item && document.type === LANGUAGE_TYPE) {
				await document.sheet?.render({ force: true });
				return;
			}
		} catch (_error) {
			// Fall through to stable identity lookup for an old/moved reference.
		}
	}

	const rulesId = normalize(reference?.rulesId);
	const name = normalize(reference?.name);
	const fallback = [...(game.items ?? [])].find((item) =>
		item?.type === LANGUAGE_TYPE &&
		((rulesId && normalize(item.system?.rulesId) === rulesId) || (!rulesId && name && normalize(item.name) === name)),
	);
	if (fallback) {
		await fallback.sheet?.render({ force: true });
		return;
	}

	ui.notifications.warn(localize(
		"The referenced Language Item could not be found. Drop the Language Item onto the Race again to repair the reference.",
		"Nie znaleziono powiązanego Przedmiotu Języka. Upuść ponownie Przedmiot Języka na Rasę, aby naprawić odwołanie.",
	));
}

function languageReference(item) {
	return {
		uuid: String(item.uuid ?? "").trim(),
		rulesId: String(item.system?.rulesId ?? "").trim(),
		name: String(item.name ?? "").trim(),
	};
}

function sameLanguage(a, b) {
	const aRules = normalize(a?.rulesId);
	const bRules = normalize(b?.rulesId);
	if (aRules && bRules) return aRules === bRules;

	const aUuid = String(a?.uuid ?? "").trim();
	const bUuid = String(b?.uuid ?? "").trim();
	if (aUuid && bUuid) return aUuid === bUuid;

	const aName = normalize(a?.name);
	const bName = normalize(b?.name);
	return Boolean(aName && bName && aName === bName);
}

function languageEntries(race) {
	const raw = race.system?.languages?.toObject?.() ?? race.system?.languages ?? [];
	return Array.isArray(raw) ? foundry.utils.deepClone(raw) : [];
}

function displayName(entry) {
	return String(entry?.name ?? entry?.rulesId ?? "").trim() || localize("Unnamed Language", "Język bez nazwy");
}

function iconButton(iconClass, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "race-language-icon-button";
	button.title = title;
	button.setAttribute("aria-label", title);
	const icon = document.createElement("i");
	icon.className = iconClass;
	button.append(icon);
	return button;
}

function findLanguageSection(root) {
	for (const section of root.querySelectorAll(".race-sheet-panel")) {
		const heading = section.querySelector("h2")?.textContent?.trim();
		if (heading === "Languages" || heading === "Języki") return section;
	}
	return null;
}

function dragData(event) {
	try {
		return foundry.applications.ux.TextEditor.getDragEventData(event) ?? {};
	} catch (_error) {
		return {};
	}
}

function warnWrongDrop() {
	ui.notifications.warn(localize("Drop a Language Item here.", "Upuść tutaj Przedmiot Języka."));
}

function ensureLanguageStyles() {
	if (document.getElementById("wfrp1ed-race-language-authoring-style")) return;
	const style = document.createElement("style");
	style.id = "wfrp1ed-race-language-authoring-style";
	style.textContent = `
	.race-item-sheet .race-language-authoring {
		transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
	}
	.race-item-sheet .race-language-heading { margin-bottom: 5px; }
	.race-item-sheet .race-language-heading-hint {
		flex: 0 0 auto;
		font-size: 11px;
		font-style: italic;
		font-weight: 600;
		color: #6a5742;
	}
	.race-item-sheet .race-language-help {
		margin: 0 0 7px;
		padding: 5px 8px;
		border-left: 3px solid rgb(104 72 40 / 34%);
		background: rgb(255 251 239 / 30%);
		font-size: 11px;
		font-style: normal;
		line-height: 1.3;
	}
	.race-item-sheet .race-language-reference-list {
		display: flex;
		flex-direction: column;
		min-height: 36px;
		padding: 3px;
		border: 1px dashed rgb(91 65 39 / 46%);
		border-radius: 3px;
		background: rgb(255 252 241 / 22%);
	}
	.race-item-sheet .race-language-reference-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 48px;
		align-items: center;
		gap: 8px;
		min-height: 30px;
		padding: 3px 5px 3px 8px;
		border-bottom: 1px solid rgb(66 54 39 / 23%);
		background: transparent;
		color: #261e17;
	}
	.race-item-sheet .race-language-reference-row:last-child { border-bottom: 0; }
	.race-item-sheet .race-language-reference-row:hover { background: rgb(255 250 235 / 46%); }
	.race-item-sheet .race-language-reference-row__identity {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}
	.race-item-sheet .race-language-reference-row__identity > i {
		flex: 0 0 auto;
		width: 14px;
		text-align: center;
		color: #62462e;
	}
	.race-item-sheet .race-language-reference-row__identity > strong {
		overflow: hidden;
		font-size: 13px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.race-item-sheet .race-language-reference-row__controls {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 2px;
		width: 48px;
	}
	.race-item-sheet .race-language-icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px !important;
		height: 22px;
		min-height: 22px !important;
		margin: 0;
		padding: 0 !important;
		border: 1px solid rgb(91 65 39 / 36%);
		border-radius: 3px;
		background: rgb(248 238 213 / 58%);
		box-shadow: none;
		font-size: 10px;
		color: #3f3429;
	}
	.race-item-sheet .race-language-icon-button:hover,
	.race-item-sheet .race-language-icon-button:focus-visible {
		background: rgb(255 249 230 / 100%);
		border-color: rgb(91 65 39 / 68%);
		color: #17120e;
	}
	.race-item-sheet .race-language-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 42px;
		font-size: 11px;
		font-style: italic;
		color: #67533e;
	}
	.race-item-sheet .race-language-empty > i { color: #74543a; }
	.race-item-sheet .race-language-authoring.is-language-drag-over {
		border-color: #8c1f1f !important;
		background: rgb(133 24 24 / 8%) !important;
		box-shadow: inset 0 0 0 1px rgb(140 31 31 / 48%);
	}
	.race-item-sheet .race-language-authoring.is-language-drag-over .race-language-reference-list {
		border-color: #8c1f1f;
		background: rgb(133 24 24 / 8%);
	}
	`;
	document.head.append(style);
}

function escapeHtml(value) {
	const div = document.createElement("div");
	div.textContent = String(value ?? "");
	return div.innerHTML;
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
	console.error("WFRP1ED | Race Language authoring failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
