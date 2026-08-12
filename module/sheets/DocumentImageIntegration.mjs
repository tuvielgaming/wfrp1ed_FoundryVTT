import { LayoutManager } from "./LayoutManager.mjs";

const PHYSICAL_ITEM_TYPES = new Set([
	"weapon",
	"armour",
	"equipment",
]);

const CLASSIC_PORTRAIT_X_OFFSET = 7;
const CLASSIC_PORTRAIT_FLAG = "classicPortrait";
const CLASSIC_PORTRAIT_DRAG_THRESHOLD = 4;
const CLASSIC_PORTRAIT_CENTER = Object.freeze({ x: 50, y: 50 });

Hooks.on("renderApplicationV2", (application, element) => {
	const root = element instanceof HTMLElement ? element : null;
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

	image.dataset.action = "editImage";
	image.dataset.edit = "img";
	image.dataset.field = "img";
	image.classList.add("wfrp1ed-document-image--editable");
	image.title = localize("Change image", "Zmień obraz");
}

function insertClassicActorPortrait(application, root) {
	const page = root.querySelector(
		'.classic-sheet-page[data-page="2"]',
	);
	if (!(page instanceof HTMLElement)) return;
	if (page.querySelector("[data-wfrp1ed-actor-portrait]")) return;

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
	overlay.style.setProperty(
		"--section-x",
		`${geometry.x + CLASSIC_PORTRAIT_X_OFFSET}px`,
	);
	overlay.style.setProperty("--section-y", `${geometry.y}px`);
	overlay.style.setProperty("--section-width", `${geometry.width}px`);
	overlay.style.setProperty("--section-height", `${geometry.height}px`);

	const image = document.createElement("img");
	image.classList.add("classic-actor-portrait");
	image.src = String(application.document?.img ?? "");
	image.alt = String(application.document?.name ?? "");
	image.draggable = false;
	applyPortraitPosition(
		image,
		readPortraitPosition(application.document),
	);

	if (application.isEditable) {
		image.dataset.action = "editImage";
		image.dataset.edit = "img";
		image.dataset.field = "img";
		image.classList.add("wfrp1ed-document-image--editable");
		image.title = localize(
			"Click: change image. Drag: reposition. Right-click: center.",
			"Kliknij: zmień obraz. Przeciągnij: przesuń kadr. Prawy klik: wyśrodkuj.",
		);
		activatePortraitFraming(application.document, image);
	}

	overlay.append(image);
	page.append(overlay);
}

function activatePortraitFraming(actor, image) {
	let drag = null;
	let suppressClick = false;

	image.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;

		const overflow = coverOverflow(image);
		if (!overflow || (!overflow.x && !overflow.y)) return;

		const position = readPortraitPosition(actor);
		drag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			position,
			current: position,
			overflow,
			moved: false,
		};

		try {
			image.setPointerCapture(event.pointerId);
		} catch (_error) {
			// Pointer capture is optional; normal pointer events still work.
		}
	});

	image.addEventListener("pointermove", (event) => {
		if (!drag || event.pointerId !== drag.pointerId) return;

		const dx = event.clientX - drag.startX;
		const dy = event.clientY - drag.startY;
		if (
			!drag.moved &&
			Math.hypot(dx, dy) < CLASSIC_PORTRAIT_DRAG_THRESHOLD
		) {
			return;
		}

		if (!drag.moved) {
			drag.moved = true;
			suppressClick = true;
			image.classList.add("classic-actor-portrait--framing");
		}

		drag.current = {
			x: shiftedPercent(drag.position.x, dx, drag.overflow.x),
			y: shiftedPercent(drag.position.y, dy, drag.overflow.y),
		};
		applyPortraitPosition(image, drag.current);
		event.preventDefault();
	});

	const finishDrag = (event) => {
		if (!drag || event.pointerId !== drag.pointerId) return;

		const completed = drag;
		drag = null;
		image.classList.remove("classic-actor-portrait--framing");

		try {
			image.releasePointerCapture(event.pointerId);
		} catch (_error) {
			// The browser may already have released pointer capture.
		}

		if (!completed.moved) return;
		if (event.type === "pointercancel") suppressClick = false;
		void persistPortraitPosition(actor, completed.current);
	};

	image.addEventListener("pointerup", finishDrag);
	image.addEventListener("pointercancel", finishDrag);

	image.addEventListener(
		"click",
		(event) => {
			if (!suppressClick) return;
			suppressClick = false;
			event.preventDefault();
			event.stopImmediatePropagation();
		},
		true,
	);

	image.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		event.stopPropagation();
		applyPortraitPosition(image, CLASSIC_PORTRAIT_CENTER);
		void persistPortraitPosition(actor, CLASSIC_PORTRAIT_CENTER);
	});
}

function coverOverflow(image) {
	const frameWidth = image.clientWidth;
	const frameHeight = image.clientHeight;
	const sourceWidth = image.naturalWidth;
	const sourceHeight = image.naturalHeight;

	if (
		frameWidth <= 0 ||
		frameHeight <= 0 ||
		sourceWidth <= 0 ||
		sourceHeight <= 0
	) {
		return null;
	}

	const scale = Math.max(
		frameWidth / sourceWidth,
		frameHeight / sourceHeight,
	);

	return {
		x: Math.max(0, sourceWidth * scale - frameWidth),
		y: Math.max(0, sourceHeight * scale - frameHeight),
	};
}

function readPortraitPosition(actor) {
	const framing =
		actor?.getFlag?.("wfrp1ed", CLASSIC_PORTRAIT_FLAG) ?? {};

	return {
		x: normalizedPercent(framing.positionX),
		y: normalizedPercent(framing.positionY),
	};
}

async function persistPortraitPosition(actor, position) {
	try {
		const previous =
			actor.getFlag?.("wfrp1ed", CLASSIC_PORTRAIT_FLAG) ?? {};

		await actor.setFlag(
			"wfrp1ed",
			CLASSIC_PORTRAIT_FLAG,
			{
				...previous,
				positionX: roundedPercent(position.x),
				positionY: roundedPercent(position.y),
			},
		);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to save Classic portrait framing.",
			error,
		);
		ui.notifications.error(
			localize(
				"Unable to save portrait framing.",
				"Nie można zapisać kadrowania portretu.",
			),
		);
	}
}

function shiftedPercent(start, deltaPixels, overflowPixels) {
	if (overflowPixels <= 0) return start;
	return clampPercent(start - deltaPixels / overflowPixels * 100);
}

function applyPortraitPosition(image, position) {
	image.style.objectPosition = `${position.x}% ${position.y}%`;
}

function normalizedPercent(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric)
		? clampPercent(numeric)
		: 50;
}

function roundedPercent(value) {
	return Math.round(clampPercent(value) * 100) / 100;
}

function clampPercent(value) {
	return Math.min(100, Math.max(0, value));
}

function isPhysicalItemSheet(application) {
	return (
		application?.document?.documentName === "Item" &&
		PHYSICAL_ITEM_TYPES.has(application.document.type)
	);
}

function isClassicActorSheet(application) {
	if (application?.document?.documentName !== "Actor") return false;
	const classes = application.options?.classes ?? [];
	return Array.from(classes).includes("classic-actor-sheet");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
