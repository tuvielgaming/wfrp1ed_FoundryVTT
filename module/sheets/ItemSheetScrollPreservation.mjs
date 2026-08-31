const positions = new WeakMap();

/**
 * Preserve the live scroll position of native WFRP ItemSheetV2 applications
 * across submit-on-change rerenders. This is presentation-only state and is
 * never persisted to Item data.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	if (!isWfrpItemSheet(application)) return;
	const pendingRoot = asElement(element);
	const remembered = positions.get(application);
	if (pendingRoot) {
		const scroller = findScroller(pendingRoot);
		if (scroller) {
			if (remembered) restore(scroller, remembered);
			track(application, scroller);
		}
	}

	requestAnimationFrame(() => {
		if (!application.rendered) return;
		const root = asElement(application.element);
		const scroller = root ? findScroller(root) : null;
		if (!scroller) return;
		const latest = positions.get(application);
		if (latest) restore(scroller, latest);
		track(application, scroller);
	});
});

Hooks.on("closeApplicationV2", (application) => {
	if (isWfrpItemSheet(application)) positions.delete(application);
});

function isWfrpItemSheet(application) {
	if (application?.document?.documentName !== "Item") return false;
	return Array.from(application.options?.classes ?? []).includes("wfrp1ed");
}

function findScroller(root) {
	const candidates = [
		root.querySelector?.(".window-content"),
		root.querySelector?.(".weapon-item-sheet__tab-content"),
		root.querySelector?.(".combat-item-sheet__content"),
		root.querySelector?.(".race-item-sheet"),
		root,
	].filter((entry) => entry instanceof HTMLElement);
	return candidates.find(isScrollable) ?? root;
}

function isScrollable(element) {
	const style = getComputedStyle(element);
	const overflowY = style.overflowY;
	return (overflowY === "auto" || overflowY === "scroll") && element.scrollHeight > element.clientHeight;
}

function track(application, scroller) {
	if (scroller.dataset.wfrpItemScrollTracker === "true") return;
	scroller.dataset.wfrpItemScrollTracker = "true";
	if (!positions.has(application)) positions.set(application, snapshot(scroller));
	scroller.addEventListener("scroll", () => positions.set(application, snapshot(scroller)), { passive: true });
}

function snapshot(scroller) {
	return { top: scroller.scrollTop, left: scroller.scrollLeft };
}

function restore(scroller, position) {
	scroller.scrollTop = Number(position?.top) || 0;
	scroller.scrollLeft = Number(position?.left) || 0;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}
