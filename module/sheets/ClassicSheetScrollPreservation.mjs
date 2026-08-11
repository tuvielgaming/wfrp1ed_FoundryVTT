const scrollPositions = new WeakMap();

/**
 * ApplicationV2 replaces sheet content during document rerenders. The Classic
 * sheet itself is the scrolling element (`.wfrp1ed-classic-sheet`), not the
 * outer ApplicationV2 frame content. Preserve that inner scroll position
 * across Actor and owned-Item updates.
 *
 * The position belongs to the Application instance only and is never persisted
 * to Actor data.
 */
Hooks.on("preRenderApplication", (application, _context, options) => {
	if (!isClassicActorSheet(application) || options?.isFirstRender) {
		return;
	}

	const scroller = currentScroller(application);
	if (!(scroller instanceof HTMLElement)) return;

	scrollPositions.set(application, {
		top: scroller.scrollTop,
		left: scroller.scrollLeft,
	});
});

Hooks.on("renderApplicationV2", (application, element) => {
	if (!isClassicActorSheet(application)) return;

	const position = scrollPositions.get(application);
	if (!position) return;

	/*
	 * renderApplicationV2 receives the pending inner HTML before Foundry inserts
	 * it into the live frame. Restore immediately where possible, then repeat on
	 * the next animation frame after insertion/layout so a large vertical
	 * position cannot be clamped to zero by detached-element geometry.
	 */
	const pendingScroller = findScroller(element);
	if (pendingScroller) restore(pendingScroller, position);

	requestAnimationFrame(() => {
		if (!application.rendered) return;

		const liveScroller = currentScroller(application);
		if (liveScroller) restore(liveScroller, position);
	});
});

Hooks.on("closeApplicationV2", (application) => {
	if (isClassicActorSheet(application)) {
		scrollPositions.delete(application);
	}
});

function currentScroller(application) {
	return findScroller(application?.element);
}

function findScroller(root) {
	if (!(root instanceof HTMLElement)) return null;

	if (root.matches?.(".wfrp1ed-classic-sheet")) {
		return root;
	}

	return root.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function restore(scroller, position) {
	scroller.scrollTop = position.top;
	scroller.scrollLeft = position.left;
}

function isClassicActorSheet(application) {
	if (application?.document?.documentName !== "Actor") {
		return false;
	}

	const classes = application.options?.classes ?? [];
	return Array.from(classes).includes("classic-actor-sheet");
}
