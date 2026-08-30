const LANGUAGE_TYPE = "language";

Hooks.once("ready", () => {
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
	heading.className = "race-section-heading";

	const title = document.createElement("h2");
	title.textContent = localize("Languages", "Języki");
	heading.append(title);

	if (editable) {
		const hint = document.createElement("span");
		hint.className = "race-language-heading-hint";
		hint.textContent = localize("Drop Language Items below", "Upuść Przedmioty Języka poniżej");
		heading.append(hint);
	}
	section.append(heading);

	const help = document.createElement("p");
	help.className = "race-sheet-hint";
	help.textContent = editable
		? localize(
			"Drag Language Items from the sidebar into this panel. Race Languages are references to Language Items; their Rules ID and name are not edited here.",
			"Przeciągnij Przedmioty Języka z panelu bocznego do tej sekcji. Języki Rasy są odwołaniami do Przedmiotów Języka; ich ID reguły i nazwy nie są edytowane tutaj.",
		)
		: localize(
			"Languages granted by this Race.",
			"Języki przyznawane przez tę Rasę.",
		);
	section.append(help);

	const list = document.createElement("div");
	list.className = "race-language-reference-list";
	const entries = languageEntries(race);

	if (!entries.length) {
		const empty = document.createElement("div");
		empty.className = "race-language-empty";
		empty.textContent = editable
			? localize("Drop a Language Item here.", "Upuść tutaj Przedmiot Języka.")
			: localize("No racial Languages.", "Brak języków rasowych.");
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

	const rules = document.createElement("span");
	rules.className = "race-language-reference-row__rules";
	rules.textContent = String(entry?.rulesId ?? "").trim() || localize("No Rules ID", "Brak ID reguły");
	row.append(rules);

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
	if (!(item instanceof foundry.documents.Item) || item.type !== LANGUAGE_TYPE) {
		return warnWrongDrop();
	}

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
	ui.notifications.warn(localize(
		"Drop a Language Item here.",
		"Upuść tutaj Przedmiot Języka.",
	));
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
