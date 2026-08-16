Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		!(actor instanceof foundry.documents.Actor) ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet") ||
		application.isEditable !== true
	) return;

	installItemDragSources(element, actor);
});

/**
 * Make every rendered embedded Item row on the Classic Actor sheet a standard
 * Foundry Item drag source. This is intentionally Item-type agnostic: weapons,
 * armour, equipment, skills, and future Item-backed panels all use the same
 * drag payload instead of each panel inventing its own behaviour.
 */
function installItemDragSources(root, actor) {
	for (const item of actor.items ?? []) {
		const surface = dragSurfaceForItem(root, item.id);
		if (!(surface instanceof HTMLElement)) continue;

		surface.draggable = true;
		surface.dataset.wfrpItemDragSource = "";
		surface.dataset.itemId = String(item.id ?? "");
		surface.dataset.itemUuid = String(item.uuid ?? "");

		/* Native image dragging can steal the drag gesture from the containing
		 * Item row. Let the row own the gesture so grabbing either the image,
		 * name, or another non-control part produces the same Item payload. */
		for (const image of surface.querySelectorAll("img")) image.draggable = false;

		surface.addEventListener("dragstart", (event) => {
			const current = actor.items?.get?.(String(surface.dataset.itemId ?? ""));
			if (!(current instanceof foundry.documents.Item)) {
				event.preventDefault();
				return;
			}
			const data = current.toDragData();
			const serialized = JSON.stringify(data);
			event.dataTransfer.setData("text/plain", serialized);
			event.dataTransfer.setData("application/json", serialized);
			event.dataTransfer.effectAllowed = "copyMove";
		});
	}
}

function dragSurfaceForItem(root, itemId) {
	const escaped = CSS.escape(String(itemId ?? ""));
	if (!escaped) return null;
	const selector = `[data-item-id="${escaped}"]`;
	const candidates = [...root.querySelectorAll(selector)];
	if (!candidates.length) return null;

	return candidates.find((element) =>
		element.matches?.(
			"[role='row'], .classic-inventory__row, .skill-row, [data-item-uuid]",
		) && !isInteractiveElement(element)
	) ?? candidates.find((element) => !isInteractiveElement(element)) ?? null;
}

function isInteractiveElement(element) {
	return element.matches?.("button, input, textarea, select, option, a") === true;
}
