import { LayoutManager } from "./LayoutManager.mjs";

const CLASSIC_PORTRAIT_X_OFFSET = 7;
const CLASSIC_PORTRAIT_FLAG = "classicPortrait";
const CLASSIC_PORTRAIT_DRAG_THRESHOLD = 4;
const CLASSIC_PORTRAIT_MIN_ZOOM = 0.25;
const CLASSIC_PORTRAIT_MAX_ZOOM = 4;
const CLASSIC_PORTRAIT_WHEEL_FACTOR = 1.1;
const CLASSIC_PORTRAIT_WHEEL_SAVE_DELAY = 180;
const CLASSIC_PORTRAIT_RESET = Object.freeze({
	x: 50,
	y: 50,
	zoom: 1,
});

Hooks.on("renderApplicationV2", (application, element) => {
	const root = element instanceof HTMLElement ? element : null;
	if (!root) return;

	if (application?.document?.documentName === "Item") {
		activateItemImage(application, root);
	}

	if (isClassicActorSheet(application)) {
		insertClassicActorPortrait(application, root);
	}
});

function activateItemImage(application, root) {
	const image = root.querySelector("[data-wfrp1ed-item-image]");
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

	const frame = document.createElement("div");
	frame.classList.add("classic-actor-portrait-frame");

	const image = document.createElement("img");
	image.classList.add("classic-actor-portrait");
	image.src = String(application.document?.img ?? "");
	image.alt = String(application.document?.name ?? "");
	image.draggable = false;

	const framing = readPortraitFraming(application.document);
	preparePortraitLayout(image, framing);

	if (application.isEditable) {
		image.dataset.action = "editImage";
		image.dataset.edit = "img";
		image.dataset.field = "img";
		image.classList.add("wfrp1ed-document-image--editable");
		frame.classList.add("classic-actor-portrait-frame--editable");
		image.title = localize(
			"Click: change image. Drag: reposition. Shift + mouse wheel: zoom. Right-click: reset.",
			"Kliknij: zmień obraz. Przeciągnij: przesuń kadr. Shift + kółko myszy: powiększ/pomniejsz. Prawy klik: reset.",
		);
		activatePortraitFraming(
			application.document,
			frame,
			image,
			framing,
		);
	}

	frame.append(image);
	overlay.append(frame);
	page.append(overlay);
}

/**
 * Keep the fixed Classic portrait frame while allowing the player to position
 * and scale the source artwork independently for each Actor.
 *
 * Normal wheel events are deliberately untouched so the character sheet keeps
 * scrolling naturally while the pointer is over the portrait. Holding Shift
 * turns the wheel into a portrait zoom gesture.
 */
function activatePortraitFraming(actor, frame, image, initialFraming) {
	let current = { ...initialFraming };
	let drag = null;
	let suppressClick = false;
	let wheelSaveTimer = null;

	image.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;

		const metrics = portraitMetrics(frame, image, current.zoom);
		if (!metrics) return;

		drag = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			framing: { ...current },
			metrics,
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
			frame.classList.add("classic-actor-portrait-frame--framing");
		}

		current = {
			x: shiftedPercent(
				drag.framing.x,
				dx,
				drag.metrics.overflowX,
			),
			y: shiftedPercent(
				drag.framing.y,
				dy,
				drag.metrics.overflowY,
			),
			zoom: drag.framing.zoom,
		};

		applyPortraitLayout(frame, image, current);
		event.preventDefault();
	});

	const finishDrag = (event) => {
		if (!drag || event.pointerId !== drag.pointerId) return;

		const completed = drag;
		drag = null;
		frame.classList.remove("classic-actor-portrait-frame--framing");

		try {
			image.releasePointerCapture(event.pointerId);
		} catch (_error) {
			// The browser may already have released pointer capture.
		}

		if (!completed.moved) return;
		if (event.type === "pointercancel") suppressClick = false;
		void persistPortraitFraming(actor, current);
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

	frame.addEventListener(
		"wheel",
		(event) => {
			if (!event.shiftKey) return;

			event.preventDefault();
			event.stopPropagation();

			const factor =
				event.deltaY < 0
					? CLASSIC_PORTRAIT_WHEEL_FACTOR
					: 1 / CLASSIC_PORTRAIT_WHEEL_FACTOR;

			current = {
				...current,
				zoom: clampZoom(current.zoom * factor),
			};
			applyPortraitLayout(frame, image, current);

			if (wheelSaveTimer) clearTimeout(wheelSaveTimer);
			wheelSaveTimer = setTimeout(
				() => void persistPortraitFraming(actor, current),
				CLASSIC_PORTRAIT_WHEEL_SAVE_DELAY,
			);
		},
		{ passive: false },
	);

	frame.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		event.stopPropagation();

		if (wheelSaveTimer) {
			clearTimeout(wheelSaveTimer);
			wheelSaveTimer = null;
		}

		current = { ...CLASSIC_PORTRAIT_RESET };
		applyPortraitLayout(frame, image, current);
		void persistPortraitFraming(actor, current);
	});
}

function preparePortraitLayout(image, framing) {
	const apply = () => {
		const frame = image.parentElement;
		if (!(frame instanceof HTMLElement)) return;
		applyPortraitLayout(frame, image, framing);
	};

	if (image.complete && image.naturalWidth > 0) {
		requestAnimationFrame(apply);
	} else {
		image.addEventListener("load", apply, { once: true });
	}
}

/**
 * Lay out the source image as a real scaled rectangle inside the fixed frame.
 * Zoom 1.0 means the standard `cover` scale. Values below 1 zoom out and may
 * intentionally reveal some of the underlying paper around unusually shaped
 * source artwork; values above 1 zoom in further.
 */
function applyPortraitLayout(frame, image, framing) {
	const metrics = portraitMetrics(frame, image, framing.zoom);
	if (!metrics) return;

	const left =
		metrics.overflowX > 0
			? -metrics.overflowX * clampPercent(framing.x) / 100
			: (metrics.frameWidth - metrics.renderedWidth) / 2;

	const top =
		metrics.overflowY > 0
			? -metrics.overflowY * clampPercent(framing.y) / 100
			: (metrics.frameHeight - metrics.renderedHeight) / 2;

	image.style.width = `${metrics.renderedWidth}px`;
	image.style.height = `${metrics.renderedHeight}px`;
	image.style.left = `${left}px`;
	image.style.top = `${top}px`;
	image.style.objectFit = "fill";
}

function portraitMetrics(frame, image, zoom) {
	const frameWidth = frame.clientWidth;
	const frameHeight = frame.clientHeight;
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

	const coverScale = Math.max(
		frameWidth / sourceWidth,
		frameHeight / sourceHeight,
	);
	const scale = coverScale * clampZoom(zoom);
	const renderedWidth = sourceWidth * scale;
	const renderedHeight = sourceHeight * scale;

	return {
		frameWidth,
		frameHeight,
		renderedWidth,
		renderedHeight,
		overflowX: Math.max(0, renderedWidth - frameWidth),
		overflowY: Math.max(0, renderedHeight - frameHeight),
	};
}

function readPortraitFraming(actor) {
	const framing =
		actor?.getFlag?.("wfrp1ed", CLASSIC_PORTRAIT_FLAG) ?? {};

	return {
		x: normalizedPercent(framing.positionX),
		y: normalizedPercent(framing.positionY),
		zoom: normalizedZoom(framing.zoom),
	};
}

async function persistPortraitFraming(actor, framing) {
	try {
		const previous =
			actor.getFlag?.("wfrp1ed", CLASSIC_PORTRAIT_FLAG) ?? {};

		await actor.setFlag(
			"wfrp1ed",
			CLASSIC_PORTRAIT_FLAG,
			{
				...previous,
				positionX: roundedPercent(framing.x),
				positionY: roundedPercent(framing.y),
				zoom: roundedZoom(framing.zoom),
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

function normalizedPercent(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric)
		? clampPercent(numeric)
		: 50;
}

function normalizedZoom(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric)
		? clampZoom(numeric)
		: 1;
}

function roundedPercent(value) {
	return Math.round(clampPercent(value) * 100) / 100;
}

function roundedZoom(value) {
	return Math.round(clampZoom(value) * 1000) / 1000;
}

function clampPercent(value) {
	return Math.min(100, Math.max(0, value));
}

function clampZoom(value) {
	return Math.min(
		CLASSIC_PORTRAIT_MAX_ZOOM,
		Math.max(CLASSIC_PORTRAIT_MIN_ZOOM, value),
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
