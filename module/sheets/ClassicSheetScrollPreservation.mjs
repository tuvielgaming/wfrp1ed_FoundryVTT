const scrollPositions = new WeakMap();

/**
 * ApplicationV2 replaces sheet content during document rerenders. The Classic
 * sheet is two printed pages inside one scrolling window, so returning to the
 * top after every Actor/Item update is especially disruptive.
 *
 * Capture the existing frame-content scroll position immediately before a
 * Classic Actor sheet rerenders and restore it immediately afterward. The
 * position belongs to the Application instance only and is never persisted to
 * Actor data.
 */
Hooks.on("preRenderApplicationV2", (application, _context, options) => {
	if (!isClassicActorSheet(application) || options?.isFirstRender) {
		return;
	}

	const content = application.window?.content;
	if (!(content instanceof HTMLElement)) return;

	scrollPositions.set(application, {
		top: content.scrollTop,
		left: content.scrollLeft,
	});
});

Hooks.on("renderApplicationV2", (application) => {
	if (!isClassicActorSheet(application)) return;

	const position = scrollPositions.get(application);
	const content = application.window?.content;

	if (!position || !(content instanceof HTMLElement)) {
		return;
	}

	content.scrollTop = position.top;
	content.scrollLeft = position.left;
});

Hooks.on("closeApplicationV2", (application) => {
	if (isClassicActorSheet(application)) {
		scrollPositions.delete(application);
	}
});

function isClassicActorSheet(application) {
	if (application?.document?.documentName !== "Actor") {
		return false;
	}

	const classes = application.options?.classes ?? [];
	return Array.from(classes).includes("classic-actor-sheet");
}
