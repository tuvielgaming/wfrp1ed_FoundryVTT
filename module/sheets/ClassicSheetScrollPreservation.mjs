const scrollPositions = new WeakMap();

/**
 * ApplicationV2 replaces the Classic sheet's inner HTML during document
 * rerenders. The actual scrolling element is `.wfrp1ed-classic-sheet`.
 *
 * Relying only on a pre-render hook proved too fragile because owned-Item and
 * submit-on-change updates can enter the render cycle after the live scroller
 * has already been replaced/reset. Instead, continuously remember the user's
 * last scroll position from the live scroller itself and restore that remembered
 * value whenever a new sheet body is rendered.
 *
 * The position belongs to the Application instance only and is never persisted
 * to Actor data.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	if (!isClassicActorSheet(application)) return;

	const remembered = scrollPositions.get(application);
	const pendingScroller = findScroller(element);

	if (pendingScroller) {
		if (remembered) restore(pendingScroller, remembered);
		attachTracker(application, pendingScroller);
	}

	/*
	 * The render hook receives pending HTML. Repeat the operation after Foundry
	 * has inserted/replaced the live HTML so detached-element geometry cannot
	 * clamp a large scrollTop back to zero.
	 */
	requestAnimationFrame(() => {
		if (!application.rendered) return;

		const liveScroller = currentScroller(application);
		if (!liveScroller) return;

		const latest = scrollPositions.get(application);
		if (latest) restore(liveScroller, latest);
		attachTracker(application, liveScroller);
	});
});

Hooks.on("closeApplicationV2", (application) => {
	if (isClassicActorSheet(application)) {
		scrollPositions.delete(application);
	}
});

function attachTracker(application, scroller) {
	if (scroller.dataset.wfrpScrollTracker === "true") return;

	scroller.dataset.wfrpScrollTracker = "true";

	/*
	 * Seed first-render state without overriding a previously remembered value.
	 */
	if (!scrollPositions.has(application)) {
		scrollPositions.set(application, {
			top: scroller.scrollTop,
			left: scroller.scrollLeft,
		});
	}

	scroller.addEventListener(
		"scroll",
		() => {
			scrollPositions.set(application, {
				top: scroller.scrollTop,
				left: scroller.scrollLeft,
			});
		},
		{ passive: true },
	);
}

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
