const TOOLBAR_CLASS = "classic-inventory__toolbar--page";
const OBSERVED_SHEETS = new WeakSet();

/**
 * Consolidate the duplicate Equipment/Wealth toolbars into one vertical page
 * toolbar. Existing button elements are moved rather than recreated so their
 * authoritative click handlers remain owned by ClassicInventoryIntegration.
 *
 * The Polish Classic equipment section starts at x=14 on the logical page. The
 * toolbar itself is styled to 13px wide at x=0, leaving a 1px gap so it cannot
 * cover the printed Equipment panel border.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor") return;

	const root = asElement(element);
	const sheet = classicSheetRoot(root);
	if (!(sheet instanceof HTMLElement)) return;

	requestAnimationFrame(() => {
		const liveRoot = asElement(application?.element) ?? root;
		const liveSheet = classicSheetRoot(liveRoot);
		if (!(liveSheet instanceof HTMLElement)) return;
		placeToolbar(liveSheet);
		installObserver(liveSheet);
	});
});

function placeToolbar(sheet) {
	const equipmentHost = sheet.querySelector(
		"[data-wfrp1ed-inventory][data-inventory-section='equipment']",
	);
	if (!(equipmentHost instanceof HTMLElement)) return;

	const wealthHost = sheet.querySelector(
		"[data-wfrp1ed-inventory][data-inventory-section='wealth']",
	);
	const equipmentOverlay = equipmentHost.closest(".sheet-overlay--equipment");
	const page = equipmentHost.closest(".classic-sheet-page");
	if (!(equipmentOverlay instanceof HTMLElement) || !(page instanceof HTMLElement)) return;

	let pageToolbar = page.querySelector(`:scope > .${TOOLBAR_CLASS}`);
	const equipmentToolbar = equipmentHost.querySelector(":scope > .classic-inventory__toolbar");
	const wealthToolbar = wealthHost instanceof HTMLElement
		? wealthHost.querySelector(":scope > .classic-inventory__toolbar")
		: null;

	if (!(pageToolbar instanceof HTMLElement)) {
		if (!(equipmentToolbar instanceof HTMLElement)) return;
		pageToolbar = equipmentToolbar;
		pageToolbar.classList.add(TOOLBAR_CLASS);

		/* Equipment toolbar already owns Add Equipment, Manager and Help. Move the
		 * existing Add Wealth button before Manager so one vertical strip exposes
		 * all inventory actions without duplicating the manager/help controls. */
		if (wealthToolbar instanceof HTMLElement) {
			const wealthAdd = wealthToolbar.querySelector("button .fa-coins")?.closest("button");
			const manager = pageToolbar.querySelector(".classic-inventory__manager");
			if (wealthAdd instanceof HTMLButtonElement) {
				if (manager instanceof HTMLElement) pageToolbar.insertBefore(wealthAdd, manager);
				else pageToolbar.append(wealthAdd);
			}
			wealthToolbar.remove();
		}

		page.append(pageToolbar);
	} else {
		/* A partial inventory-host rebuild can create fresh local toolbars while
		 * the page-level strip survives. Discard those duplicates; the page buttons
		 * remain valid because they close over the same Actor document. */
		if (equipmentToolbar instanceof HTMLElement && equipmentToolbar !== pageToolbar) {
			equipmentToolbar.remove();
		}
		if (wealthToolbar instanceof HTMLElement) wealthToolbar.remove();
	}

	positionToolbar(pageToolbar, equipmentHost, equipmentOverlay);
}

function positionToolbar(toolbar, equipmentHost, equipmentOverlay) {
	const headerTop = finiteNumber(
		getComputedStyle(equipmentHost).getPropertyValue("--classic-inventory-header-top"),
		0,
	);
	toolbar.style.left = "0px";
	toolbar.style.top = `${equipmentOverlay.offsetTop + headerTop}px`;
}

function installObserver(sheet) {
	if (OBSERVED_SHEETS.has(sheet)) return;
	OBSERVED_SHEETS.add(sheet);

	let queued = false;
	const observer = new MutationObserver(() => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			if (!sheet.isConnected) {
				observer.disconnect();
				return;
			}
			placeToolbar(sheet);
		});
	});
	observer.observe(sheet, { childList: true, subtree: true });
}

function finiteNumber(value, fallback = 0) {
	const number = Number.parseFloat(String(value ?? ""));
	return Number.isFinite(number) ? number : fallback;
}

function classicSheetRoot(root) {
	if (root?.matches?.(".wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}
