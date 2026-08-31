const PSYCHOLOGY_TYPE = "psychology";

Hooks.once("ready", () => {
	Hooks.on("renderApplicationV2", (application, element) => {
		const race = application?.document;
		if (race?.documentName !== "Item" || race.type !== "race") return;

		const root = asElement(element) ?? asElement(application.element);
		if (!(root instanceof HTMLElement)) return;

		const legacyAdd = root.querySelector('[data-action="addPsychology"]');
		const section = legacyAdd?.closest?.(".race-sheet-panel") ?? findPsychologySection(root);
		if (!(section instanceof HTMLElement)) return;

		renderPsychologyAuthoring(section, race, application.isEditable === true);
	});
});

function renderPsychologyAuthoring(section, race, editable) {
	section.classList.add("race-psychology-authoring");
	section.dataset.racePsychologyDropZone = "true";
	section.replaceChildren();

	const heading = document.createElement("div");
	heading.className = "race-section-heading";
	const title = document.createElement("h2");
	title.textContent = localize("Psychology", "Psychologia");
	heading.append(title);
	if (editable) {
		const hint = document.createElement("span");
		hint.className = "race-psychology-heading-hint";
		hint.textContent = localize("Drop Psychology Items below", "Upuść Przedmioty Psychologii poniżej");
		heading.append(hint);
	}
	section.append(heading);

	const help = document.createElement("p");
	help.className = "race-sheet-hint";
	help.textContent = editable
		? localize(
			"Drag Psychology Items from the sidebar into this panel. Race Psychology entries are references to reusable Psychology Items; edit their name, description and mechanical effects on the Psychology Item itself.",
			"Przeciągnij Przedmioty Psychologii z panelu bocznego do tej sekcji. Wpisy Psychologii Rasy są odwołaniami do wielokrotnego użytku; nazwę, opis i efekty mechaniczne edytuj na samym Przedmiocie Psychologii.",
		)
		: localize("Psychology granted by this Race.", "Psychologia przyznawana przez tę Rasę.");
	section.append(help);

	const list = document.createElement("div");
	list.className = "race-psychology-reference-list";
	const entries = psychologyEntries(race);
	if (!entries.length) {
		const empty = document.createElement("div");
		empty.className = "race-psychology-empty";
		empty.textContent = editable
			? localize("Drop a Psychology Item here.", "Upuść tutaj Przedmiot Psychologii.")
			: localize("No racial Psychology.", "Brak Psychologii rasowej.");
		list.append(empty);
	} else {
		entries.forEach((entry, index) => list.append(psychologyRow(entry, index, race, editable)));
	}
	section.append(list);
	if (editable) installDropListeners(section, race);
}

function psychologyRow(entry, index, race, editable) {
	const row = document.createElement("div");
	row.className = "race-psychology-reference-row";
	row.dataset.psychologyIndex = String(index);
	row.title = String(entry?.description ?? "").trim() || localize(
		"Double-click to open the referenced Psychology Item.",
		"Kliknij dwukrotnie, aby otworzyć powiązany Przedmiot Psychologii.",
	);

	const identity = document.createElement("div");
	identity.className = "race-psychology-reference-row__identity";
	const icon = document.createElement("i");
	icon.className = "fa-solid fa-brain";
	identity.append(icon);
	const name = document.createElement("strong");
	name.textContent = displayName(entry);
	identity.append(name);
	row.append(identity);

	const description = document.createElement("span");
	description.className = "race-psychology-reference-row__description";
	description.textContent = String(entry?.description ?? "").trim() || "—";
	row.append(description);

	if (editable) {
		const controls = document.createElement("div");
		controls.className = "race-psychology-reference-row__controls";
		const open = iconButton("fa-solid fa-arrow-up-right-from-square", localize("Open Psychology", "Otwórz Psychologię"));
		open.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void openPsychologyReference(entry).catch(reportError);
		});
		controls.append(open);
		const remove = iconButton("fa-solid fa-trash", localize("Remove from Race", "Usuń z Rasy"));
		remove.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void removePsychology(race, index).catch(reportError);
		});
		controls.append(remove);
		row.append(controls);
	}

	row.addEventListener("dblclick", (event) => {
		event.preventDefault();
		void openPsychologyReference(entry).catch(reportError);
	});
	return row;
}

function installDropListeners(section, race) {
	if (section.dataset.racePsychologyDropBound === "true") return;
	section.dataset.racePsychologyDropBound = "true";

	for (const eventName of ["dragenter", "dragover"]) {
		section.addEventListener(eventName, (event) => {
			const data = dragData(event);
			if (String(data?.type ?? "") !== "Item") return;
			event.preventDefault();
			section.classList.add("is-psychology-drag-over");
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});
	}

	section.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) return;
		section.classList.remove("is-psychology-drag-over");
	});

	section.addEventListener("drop", (event) => {
		const data = dragData(event);
		if (String(data?.type ?? "") !== "Item") return;
		event.preventDefault();
		event.stopImmediatePropagation();
		section.classList.remove("is-psychology-drag-over");
		void addPsychologyFromDrop(race, data).catch(reportError);
	}, true);
}

async function addPsychologyFromDrop(race, data) {
	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return warnWrongDrop();
	const item = await foundry.utils.fromUuid(uuid);
	if (!(item instanceof foundry.documents.Item) || item.type !== PSYCHOLOGY_TYPE) return warnWrongDrop();

	const reference = psychologyReference(item);
	const entries = psychologyEntries(race);
	if (entries.some((entry) => samePsychology(entry, reference))) {
		ui.notifications.warn(localize(
			`${item.name} is already assigned to this Race.`,
			`${item.name} jest już przypisany do tej Rasy.`,
		));
		return;
	}
	entries.push(reference);
	await race.update({ "system.psychology": entries });
}

async function removePsychology(race, index) {
	const entries = psychologyEntries(race);
	if (index < 0 || index >= entries.length) return;
	entries.splice(index, 1);
	await race.update({ "system.psychology": entries });
}

async function openPsychologyReference(reference) {
	const document = await resolvePsychologyReference(reference);
	if (document) {
		await document.sheet?.render({ force: true });
		return;
	}
	ui.notifications.warn(localize(
		"The referenced Psychology Item could not be found. Drop the Psychology Item onto the Race again to repair the reference.",
		"Nie znaleziono powiązanego Przedmiotu Psychologii. Upuść ponownie Przedmiot Psychologii na Rasę, aby naprawić odwołanie.",
	));
}

async function resolvePsychologyReference(reference) {
	const uuid = String(reference?.uuid ?? "").trim();
	if (uuid) {
		try {
			const document = await foundry.utils.fromUuid(uuid);
			if (document instanceof foundry.documents.Item && document.type === PSYCHOLOGY_TYPE) return document;
		} catch (_error) {
			// Fall through to stable identity lookup.
		}
	}
	const rulesId = normalize(reference?.rulesId);
	const name = normalize(reference?.name);
	return [...(game.items ?? [])].find((item) =>
		item?.type === PSYCHOLOGY_TYPE &&
		((rulesId && normalize(item.system?.rulesId) === rulesId) || (!rulesId && name && normalize(item.name) === name)),
	) ?? null;
}

function psychologyReference(item) {
	return {
		uuid: String(item.uuid ?? "").trim(),
		rulesId: String(item.system?.rulesId ?? "").trim(),
		name: String(item.name ?? "").trim(),
		description: String(item.system?.description ?? "").trim(),
	};
}

function samePsychology(a, b) {
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

function psychologyEntries(race) {
	const raw = race.system?.psychology?.toObject?.() ?? race.system?.psychology ?? [];
	return Array.isArray(raw) ? foundry.utils.deepClone(raw) : [];
}

function displayName(entry) {
	return String(entry?.name ?? entry?.rulesId ?? "").trim() || localize("Unnamed Psychology", "Psychologia bez nazwy");
}

function iconButton(iconClass, title) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "race-psychology-icon-button";
	button.title = title;
	button.setAttribute("aria-label", title);
	const icon = document.createElement("i");
	icon.className = iconClass;
	button.append(icon);
	return button;
}

function findPsychologySection(root) {
	for (const section of root.querySelectorAll(".race-sheet-panel")) {
		const heading = section.querySelector("h2")?.textContent?.trim();
		if (heading === "Psychology" || heading === "Psychologia") return section;
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
	console.error("WFRP1ED | Race Psychology authoring failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
