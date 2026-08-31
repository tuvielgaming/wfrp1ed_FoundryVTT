const ROUTES = Object.freeze({
	race: Object.freeze({
		language: "race-language",
		psychology: "race-psychology",
	}),
	character: Object.freeze({
		psychology: "character-psychology",
		disease: "character-disease",
		criticalWound: "character-critical-wound",
	}),
});

Hooks.once("ready", () => {
	ensureRouterStyles();
	Hooks.on("renderApplicationV2", (application, element) => {
		const document = application?.document;
		const root = asElement(element) ?? asElement(application.element);
		if (!(root instanceof HTMLElement) || application.isEditable !== true) return;

		if (document?.documentName === "Item" && document.type === "race") {
			installRouter(root, document, "race");
			return;
		}

		if (document?.documentName === "Actor" && document.type === "character") {
			const sheet = root.classList.contains("wfrp1ed-classic-sheet")
				? root
				: root.querySelector(".wfrp1ed-classic-sheet");
			if (sheet instanceof HTMLElement) installRouter(sheet, document, "character");
		}
	});
});

function installRouter(surface, owner, ownerKind) {
	if (surface.dataset.wfrpSingleDestinationRouter === "true") return;
	surface.dataset.wfrpSingleDestinationRouter = "true";

	for (const eventName of ["dragenter", "dragover"]) {
		surface.addEventListener(eventName, (event) => {
			const item = draggedItemSync(event);
			const route = routeFor(ownerKind, item?.type);
			if (!route) return;
			event.preventDefault();
			setHighlight(surface, ownerKind, item.type, true);
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		}, true);
	}

	surface.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && surface.contains(event.relatedTarget)) return;
		clearHighlight(surface);
	}, true);

	surface.addEventListener("drop", (event) => {
		const item = draggedItemSync(event);
		const route = routeFor(ownerKind, item?.type);
		if (!route) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		clearHighlight(surface);
		void dispatchRoute(route, owner, item).catch(reportError);
	}, true);
}

function routeFor(ownerKind, itemType) {
	return ROUTES?.[ownerKind]?.[String(itemType ?? "")] ?? "";
}

async function dispatchRoute(route, owner, source) {
	switch (route) {
		case "race-language":
			await addRaceReference(owner, source, "languages", "language");
			return;
		case "race-psychology":
			await addRaceReference(owner, source, "psychology", "psychology");
			return;
		case "character-psychology":
			await embedUniqueItem(owner, source, "psychology");
			return;
		case "character-disease":
			await embedUniqueItem(owner, source, "disease");
			return;
		case "character-critical-wound":
			await embedItem(owner, source, "criticalWound");
			return;
		default:
			return;
	}
}

async function addRaceReference(race, source, path, expectedType) {
	if (!(source instanceof foundry.documents.Item) || source.type !== expectedType) return;
	const raw = race.system?.[path]?.toObject?.() ?? race.system?.[path] ?? [];
	const entries = Array.isArray(raw) ? foundry.utils.deepClone(raw) : [];
	const reference = {
		uuid: String(source.uuid ?? "").trim(),
		rulesId: String(source.system?.rulesId ?? "").trim(),
		name: String(source.name ?? "").trim(),
		...(expectedType === "psychology" ? { description: String(source.system?.description ?? "").trim() } : {}),
	};
	if (entries.some((entry) => sameReference(entry, reference))) {
		ui.notifications.warn(localize(`${source.name} is already assigned to this Race.`, `${source.name} jest już przypisany do tej Rasy.`));
		return;
	}
	entries.push(reference);
	await race.update({ [`system.${path}`]: entries });
}

async function embedUniqueItem(actor, source, expectedType) {
	if (!(source instanceof foundry.documents.Item) || source.type !== expectedType) return;
	const identity = itemIdentity(source);
	if ([...(actor.items ?? [])].some((item) => item.type === expectedType && itemIdentity(item) === identity)) {
		ui.notifications.warn(localize(`${source.name} is already on this Character.`, `${source.name} jest już na tej Postaci.`));
		return;
	}
	await createEmbeddedCopy(actor, source);
}

async function embedItem(actor, source, expectedType) {
	if (!(source instanceof foundry.documents.Item) || source.type !== expectedType) return;
	await createEmbeddedCopy(actor, source);
}

async function createEmbeddedCopy(actor, source) {
	if (source.parent === actor) return;
	const data = source.toObject();
	delete data._id;
	delete data.folder;
	delete data.sort;
	delete data.ownership;
	await actor.createEmbeddedDocuments("Item", [data]);
}

function sameReference(a, b) {
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

function itemIdentity(item) {
	return normalize(item?.system?.rulesId) || normalize(item?.name);
}

function draggedItemSync(event) {
	let data;
	try { data = foundry.applications.ux.TextEditor.getDragEventData(event) ?? {}; }
	catch (_error) { return null; }
	if (String(data?.type ?? "") !== "Item") return null;
	const uuid = String(data?.uuid ?? "").trim();
	if (!uuid) return null;
	const resolver = foundry.utils?.fromUuidSync ?? globalThis.fromUuidSync;
	if (typeof resolver !== "function") return null;
	try {
		const item = resolver(uuid);
		return item instanceof foundry.documents.Item ? item : null;
	} catch (_error) { return null; }
}

function setHighlight(surface, ownerKind, itemType, active) {
	clearHighlight(surface);
	if (!active) return;
	surface.classList.add("wfrp-single-destination-drag");
	surface.dataset.wfrpSingleDestinationType = String(itemType ?? "");
	if (ownerKind === "race") {
		const selector = itemType === "language" ? ".race-language-authoring" : ".race-psychology-authoring";
		surface.querySelector(selector)?.classList.add("wfrp-single-destination-target");
	} else if (ownerKind === "character") {
		const selector = itemType === "criticalWound"
			? ".classic-health-categories"
			: ".classic-psychology-panel";
		surface.querySelector(selector)?.classList.add("wfrp-single-destination-target");
	}
}

function clearHighlight(surface) {
	surface.classList.remove("wfrp-single-destination-drag");
	delete surface.dataset.wfrpSingleDestinationType;
	for (const target of surface.querySelectorAll(".wfrp-single-destination-target")) target.classList.remove("wfrp-single-destination-target");
}

function ensureRouterStyles() {
	if (document.getElementById("wfrp1ed-single-destination-drop-style")) return;
	const style = document.createElement("style");
	style.id = "wfrp1ed-single-destination-drop-style";
	style.textContent = `
	[data-wfrp-single-destination-router="true"] { transition: box-shadow 100ms ease, background-color 100ms ease; }
	[data-wfrp-single-destination-router="true"].wfrp-single-destination-drag {
		box-shadow: inset 0 0 0 3px rgb(150 10 24 / 70%) !important;
		background-color: rgb(130 0 15 / 3%);
	}
	.race-language-authoring.wfrp-single-destination-target,
	.race-psychology-authoring.wfrp-single-destination-target,
	.classic-psychology-panel.wfrp-single-destination-target {
		outline: 2px dashed #a10f20 !important;
		outline-offset: -2px;
		background-color: rgb(145 0 18 / 10%) !important;
		box-shadow: inset 0 0 0 1px rgb(161 15 32 / 40%) !important;
	}
	.classic-health-categories.wfrp-single-destination-target {
		padding: 3px !important;
		border: 2px dashed #a10f20 !important;
		border-radius: 6px;
		background: rgb(145 0 18 / 10%) !important;
	}
	`;
	document.head.append(style);
}

function asElement(value) { return value instanceof HTMLElement ? value : value?.[0] instanceof HTMLElement ? value[0] : null; }
function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }
function reportError(error) {
	console.error("WFRP1ED | Single-destination Item drop failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
