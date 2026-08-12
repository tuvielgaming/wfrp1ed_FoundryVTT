import { LayoutManager } from "./LayoutManager.mjs";

const PHYSICAL_ITEM_TYPES = new Set([
	"weapon",
	"armour",
	"equipment",
]);

/**
 * Restore Foundry v14's native DocumentSheetV2 image-edit action on the custom
 * physical Item sheets and expose the Actor portrait on the Classic sheet.
 *
 * The underlying image remains the normal Document `img` property. No parallel
 * WFRP image field is introduced.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const root = findRoot(element);
	if (!root) return;

	if (isPhysicalItemSheet(application)) {
		activatePhysicalItemImage(application, root);
	}

	if (isClassicActorSheet(application)) {
		insertClassicActorPortrait(application, root);
	}
});

function activatePhysicalItemImage(application, root) {
	const image = root.querySelector(".combat-item-sheet__image");
	if (!(image instanceof HTMLImageElement)) return;

	image.alt = application.document?.name ?? "";

	if (!application.isEditable) return;

	/*
	 * DocumentSheetV2 owns the native `editImage` action. `data-edit` is the
	 * canonical document property used by the handler; `data-field` is supplied
	 * as a compatibility hint for Foundry ApplicationV2 image-edit patterns.
	 */
	image.dataset.action = "editImage";
	image.dataset.edit = "img";
	image.dataset.field = "img";
	image.classList.add("wfrp1ed-document-image--editable");
	image.title = localize(
		"Change image",
		"Zmień obraz",
	);
}

function insertClassicActorPortrait(application, root) {
	const page = root.querySelector(
		'.classic-sheet-page[data-page="2"]',
	);
	if (!(page instanceof HTMLElement)) return;

	if (page.querySelector("[data-wfrp1ed-actor-portrait]")) {
		return;
	}

	const geometry = LayoutManager.section(
		"classic",
		2,
		"experience",
	);

	const overlay = document.createElement("section");
	overlay.classList.add(
		"sheet-overlay",
		"sheet-overlay--experience-portrait",
	);
	overlay.dataset.section = "experiencePortrait";
	overlay.dataset.wfrp1edActorPortrait = "";
	overlay.style.setProperty("--section-x", `${geometry.x}px`);
	overlay.style.setProperty("--section-y", `${geometry.y}px`);
	overlay.style.setProperty("--section-width", `${geometry.width}px`);
	overlay.style.setProperty("--section-height", `${geometry.height}px`);

	const portrait = application.isEditable
		? document.createElement("button")
		: document.createElement("div");

	portrait.classList.add("classic-actor-portrait");

	if (portrait instanceof HTMLButtonElement) {
		portrait.type = "button";
		portrait.dataset.action = "editImage";
		portrait.dataset.edit = "img";
		portrait.dataset.field = "img";
		portrait.title = localize(
			"Change character image",
			"Zmień obraz postaci",
		);
	}

	const image = document.createElement("img");
	image.src = String(application.document?.img ?? "");
	image.alt = String(application.document?.name ?? "");
	image.draggable = false;

	portrait.append(image);
	overlay.append(portrait);
	page.append(overlay);
}

function findRoot(element) {
	return element instanceof HTMLElement
		? element
		: null;
}

function isPhysicalItemSheet(application) {
	return (
		application?.document?.documentName === "Item" &&
		PHYSICAL_ITEM_TYPES.has(application.document.type)
	);
}

function isClassicActorSheet(application) {
	if (application?.document?.documentName !== "Actor") {
		return false;
	}

	const classes = application.options?.classes ?? [];
	return Array.from(classes).includes("classic-actor-sheet");
}

function localize(english, polish) {
	return game.i18n.lang === "pl"
		? polish
		: english;
}
