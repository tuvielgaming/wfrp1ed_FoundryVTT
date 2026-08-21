const scrollPositions = new WeakMap();
const restoredWindowPositions = new WeakSet();
const dialogPointerPositions = new WeakMap();
const INVENTORY_DIALOG_POINTER_MAX_AGE_MS = 2000;
const INVENTORY_DIALOG_POINTER_OFFSET = 14;
let pendingInventoryDialogPointer = null;

Hooks.once("ready", () => {
	document.addEventListener(
		"pointerdown",
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (!target.closest(".classic-inventory__delete")) return;

			pendingInventoryDialogPointer = {
				left: event.clientX,
				top: event.clientY,
				at: Date.now(),
			};
		},
		true,
	);
});

/**
 * Restore the last closed Classic Character Sheet position before its first
 * render. The preference is browser-local per Foundry world and user; it never
 * touches Actor data or synchronizes to other clients.
 *
 * Inventory delete confirmations are also positioned near the pointer that
 * triggered them. The pointer request expires quickly so unrelated DialogV2
 * windows keep Foundry's normal centering behaviour.
 */
Hooks.on("preRenderApplicationV2", (application) => {
	if (
		isClassicActorSheet(application) &&
		!restoredWindowPositions.has(application)
	) {
		restoredWindowPositions.add(application);
		const remembered = readClassicWindowPosition();
		if (remembered) application.setPosition(remembered);
	}

	const pointer = freshInventoryDialogPointer();
	if (!pointer || !isDialogV2(application)) return;

	pendingInventoryDialogPointer = null;
	const requested = {
		left: pointer.left + INVENTORY_DIALOG_POINTER_OFFSET,
		top: pointer.top + INVENTORY_DIALOG_POINTER_OFFSET,
	};
	dialogPointerPositions.set(application, requested);
	application.setPosition(requested);
});

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
 * The scroll position belongs to the Application instance only and is never
 * persisted to Actor data.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const dialogPosition = dialogPointerPositions.get(application);
	if (dialogPosition) {
		/* Re-apply after the dialog has its real dimensions so Foundry can clamp
		 * it against the viewport accurately near screen edges. */
		dialogPointerPositions.delete(application);
		application.setPosition(dialogPosition);
	}

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
	if (!isClassicActorSheet(application)) return;

	writeClassicWindowPosition(application.position);
	scrollPositions.delete(application);
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

function freshInventoryDialogPointer() {
	const pointer = pendingInventoryDialogPointer;
	if (!pointer) return null;

	if (Date.now() - pointer.at > INVENTORY_DIALOG_POINTER_MAX_AGE_MS) {
		pendingInventoryDialogPointer = null;
		return null;
	}

	return pointer;
}

function readClassicWindowPosition() {
	try {
		const raw = localStorage.getItem(classicWindowPositionKey());
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		const left = Number(parsed?.left);
		const top = Number(parsed?.top);
		if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
		return { left, top };
	} catch (_error) {
		return null;
	}
}

function writeClassicWindowPosition(position) {
	const left = Number(position?.left);
	const top = Number(position?.top);
	if (!Number.isFinite(left) || !Number.isFinite(top)) return;

	try {
		localStorage.setItem(
			classicWindowPositionKey(),
			JSON.stringify({ left, top }),
		);
	} catch (_error) {
		/* Browser storage may be unavailable in hardened/private clients. Window
		 * persistence is QoL only, so failure must never affect the sheet. */
	}
}

function classicWindowPositionKey() {
	const worldId = String(game.world?.id ?? "world");
	const userId = String(game.user?.id ?? "user");
	return `wfrp1ed.classicActorSheet.position.${worldId}.${userId}`;
}

function isDialogV2(application) {
	const DialogV2 = foundry.applications.api.DialogV2;
	return application instanceof DialogV2;
}

function isClassicActorSheet(application) {
	if (application?.document?.documentName !== "Actor") {
		return false;
	}

	const classes = application.options?.classes ?? [];
	return Array.from(classes).includes("classic-actor-sheet");
}
