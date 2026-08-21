const scrollPositions = new WeakMap();
const restoredWindowPositions = new WeakSet();
const pendingClassicWindowPositions = new WeakMap();
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
 * Record requested window positions during pre-render, but do not call
 * ApplicationV2#setPosition yet. Foundry v14 has not necessarily created the
 * application element at this stage; calling setPosition here can reach its
 * internal DOM-positioning code with an undefined element.
 *
 * The actual position is applied from renderApplicationV2 (or its next animation
 * frame), after the window element exists.
 */
Hooks.on("preRenderApplicationV2", (application) => {
	if (
		isClassicActorSheet(application) &&
		!restoredWindowPositions.has(application)
	) {
		restoredWindowPositions.add(application);
		const remembered = readClassicWindowPosition();
		if (remembered) {
			pendingClassicWindowPositions.set(application, remembered);
		}
	}

	const pointer = freshInventoryDialogPointer();
	if (!pointer || !isDialogV2(application)) return;

	pendingInventoryDialogPointer = null;
	dialogPointerPositions.set(application, {
		left: pointer.left + INVENTORY_DIALOG_POINTER_OFFSET,
		top: pointer.top + INVENTORY_DIALOG_POINTER_OFFSET,
	});
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
		/* The window now has a real element and dimensions, so Foundry can safely
		 * apply and clamp the requested cursor-near position. */
		dialogPointerPositions.delete(application);
		applyPositionWhenReady(application, dialogPosition);
	}

	if (!isClassicActorSheet(application)) return;

	const windowPosition = pendingClassicWindowPositions.get(application);
	if (windowPosition) {
		pendingClassicWindowPositions.delete(application);
		applyPositionWhenReady(application, windowPosition);
	}

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
	pendingClassicWindowPositions.delete(application);
});

function applyPositionWhenReady(application, position) {
	const apply = () => {
		const element = application?.element;
		if (!(element instanceof HTMLElement)) return false;
		application.setPosition(position);
		return true;
	};

	if (apply()) return;

	requestAnimationFrame(() => {
		if (!application?.rendered) return;
		apply();
	});
}

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
