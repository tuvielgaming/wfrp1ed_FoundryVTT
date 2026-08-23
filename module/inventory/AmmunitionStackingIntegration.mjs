const OWNED_ITEM_DRAG_TYPE = "application/x-wfrp1ed-owned-item";

let activeSplitPrompt = null;

/*
 * Equipment quantities are stacks. Two stacks may merge only when they are the
 * same authored Equipment definition: same name, same mechanical system data,
 * same Item flags and the same complete ActiveEffect definitions. Quantity and
 * current storage fields are ignored because those are exactly what stacking
 * changes.
 *
 * The handler is loaded before ClassicActorItemDragIntegration and runs in the
 * capture phase. It consumes confirmed stack merges and stackable Equipment
 * leaving a container; every unrelated drop is left to the normal inventory and
 * container implementation.
 *
 * Shift/Ctrl/Cmd + drag is reserved for splitting. Native browser drag cannot
 * remain suspended while an asynchronous quantity prompt is answered, so the
 * modified drag is cancelled, a compact prompt is shown beside the pointer, and
 * confirming creates a second stack in the same storage location. The new stack
 * can then be dragged normally.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (application.isEditable !== true) return;
	const sheet = classicSheetRoot(element);
	if (!sheet || sheet.dataset.wfrpEquipmentStacking === "true") return;
	sheet.dataset.wfrpEquipmentStacking = "true";

	/* Split has to intercept the drag before the normal Item drag source writes
	 * its payload. A sheet-level capture listener runs before the row listener
	 * installed by ClassicActorItemDragIntegration. */
	sheet.addEventListener("dragstart", (event) => {
		if (!(event.shiftKey || event.ctrlKey || event.metaKey)) return;
		if (interactiveOrigin(event.target)) return;

		const row = event.target?.closest?.(".classic-inventory__row[data-item-id]");
		if (!(row instanceof HTMLElement)) return;
		const source = actor.items?.get?.(String(row.dataset.itemId ?? ""));
		if (!isStackableEquipment(source)) return;

		event.preventDefault();
		event.stopImmediatePropagation();

		const current = quantity(source);
		if (current < 2) {
			ui.notifications.warn(localize(
				`Cannot split ${source.name}: the stack contains only one item.`,
				`Nie można podzielić „${source.name}”: stos zawiera tylko jeden przedmiot.`,
			));
			return;
		}

		void requestStackSplit({
			actor,
			source,
			application,
			x: Number(event.clientX) || Number(event.pageX) || 0,
			y: Number(event.clientY) || Number(event.pageY) || 0,
		}).catch(reportStackingError);
	}, true);

	sheet.addEventListener("drop", (event) => {
		const marker = ownedItemDragMarker(event.dataTransfer);
		if (!isSameActorEquipmentMarker(marker, actor)) return;

		const source = ownedItemFromMarker(actor, marker);
		if (!isStackableEquipment(source)) return;

		const targetRow = event.target?.closest?.(
			".classic-inventory__row[data-item-id]",
		);
		const target = targetRow
			? actor.items?.get?.(String(targetRow.dataset.itemId ?? ""))
			: null;

		/* Container rows own capacity/compatibility adjudication. A container is
		 * never itself a stack destination. */
		if (target?.system?.isContainer === true) return;

		const explicitTarget = stackableDropTarget(source, target);
		if (explicitTarget) {
			/* Do not smuggle an Item into another container by dropping it onto a
			 * child row. Same-container merges are safe, while a top-level target
			 * is always a legal destination for a source leaving a container. */
			const sourceContainerId = containerId(source);
			const targetContainerId = containerId(explicitTarget);
			if (targetContainerId && targetContainerId !== sourceContainerId) {
				consumeDrop(event);
				ui.notifications.warn(localize(
					"These stacks are identical, but they are in different containers. Drop the item onto the container itself to move it there, or move it to the main Equipment level first.",
					"Te stosy są identyczne, ale znajdują się w różnych pojemnikach. Upuść przedmiot na sam pojemnik, aby go tam przenieść, albo najpierw przenieś go na główny poziom Ekwipunku.",
				));
				return;
			}
			consumeDrop(event);
			void mergeStacks(source, explicitTarget, application)
				.catch(reportStackingError);
			return;
		}

		/* A drop onto a same-named Equipment row is an explicit request to stack.
		 * If strict identity rejects it, consume the gesture and explain why rather
		 * than silently falling through to an unrelated inventory move. */
		const mismatch = stackMismatchReason(source, target);
		if (mismatch) {
			consumeDrop(event);
			ui.notifications.warn(localize(
				`Cannot merge “${source.name}” stacks: ${mismatch.en}`,
				`Nie można połączyć stosów „${source.name}”: ${mismatch.pl}`,
			));
			return;
		}

		/* Stackable Equipment leaving a container is fully owned here. This is
		 * important for ammunition too: the older generic drag integration still
		 * contains a legacy ammunition-only coalescer with a looser identity test.
		 * Consuming the drop here prevents that fallback from ever merging two
		 * stacks that fail our strict Equipment + ActiveEffect identity contract. */
		if (!containerId(source)) return;
		if (target && containerId(target)) return;
		const matchingTopLevel = topLevelMatchingStack(actor, source);

		consumeDrop(event);
		if (matchingTopLevel) {
			void mergeStacks(source, matchingTopLevel, application)
				.catch(reportStackingError);
			return;
		}
		void moveStackToTopLevel(source, application)
			.catch(reportStackingError);
	}, true);
});

function isStackableEquipment(item) {
	return Boolean(
		item instanceof foundry.documents.Item &&
		item.type === "equipment" &&
		item.system?.isContainer !== true &&
		item.system?.isWealth !== true
	);
}

function stackableDropTarget(source, target) {
	if (!isStackableEquipment(target) || target === source) return null;
	return sameStackVariant(source, target) ? target : null;
}

function topLevelMatchingStack(actor, source) {
	return [...(actor.items ?? [])].find((candidate) =>
		candidate !== source &&
		isStackableEquipment(candidate) &&
		!containerId(candidate) &&
		sameStackVariant(source, candidate)
	) ?? null;
}

/**
 * Stack identity is deliberately conservative. Apart from current amount and
 * physical storage, mechanically distinct Equipment must remain distinct rows.
 * This automatically protects ammunition variants: two Arrow stacks with
 * different ActiveEffects can never collapse just because both are arrows.
 */
function sameStackVariant(first, second) {
	if (!isStackableEquipment(first) || !isStackableEquipment(second)) return false;
	if (normalizedName(first) !== normalizedName(second)) return false;
	if (equipmentSystemSignature(first) !== equipmentSystemSignature(second)) return false;
	if (itemFlagsSignature(first) !== itemFlagsSignature(second)) return false;
	return effectSignature(first) === effectSignature(second);
}

function stackMismatchReason(first, second) {
	if (!isStackableEquipment(first) || !isStackableEquipment(second) || first === second) {
		return null;
	}
	if (normalizedName(first) !== normalizedName(second)) return null;
	if (equipmentSystemSignature(first) !== equipmentSystemSignature(second)) {
		return {
			en: "the Equipment properties or state are different.",
			pl: "właściwości lub stan Ekwipunku są różne.",
		};
	}
	if (itemFlagsSignature(first) !== itemFlagsSignature(second)) {
		return {
			en: "their system metadata is different.",
			pl: "ich dane systemowe są różne.",
		};
	}
	if (effectSignature(first) !== effectSignature(second)) {
		return {
			en: "their Active Effects are different.",
			pl: "ich Aktywne Efekty są różne.",
		};
	}
	return {
		en: "the items are not the same stack variant.",
		pl: "przedmioty nie są tym samym wariantem stosu.",
	};
}

function equipmentSystemSignature(item) {
	const source = item?.toObject?.()?.system ?? {};
	const normalized = stripRuntimeMetadata(source);

	/* Quantity and physical storage are instance state, not authored item
	 * identity. All other Equipment data remains part of the signature:
	 * Encumbrance, price, reference quantity, ammunition/subtype data, clothing
	 * state, availability and future mechanical fields included by the model. */
	delete normalized.quantity;
	delete normalized.containerId;
	delete normalized.storageLocation;
	delete normalized.totalEncumbrance;
	return stableStringify(normalized);
}

function itemFlagsSignature(item) {
	const flags = item?.toObject?.()?.flags ?? {};
	return stableStringify(stripRuntimeMetadata(flags));
}

function effectSignature(item) {
	const definitions = [...(item.effects ?? [])]
		.map((effect) => normalizedEffect(effect))
		.map((effect) => stableStringify(effect))
		.sort();
	return `[${definitions.join(",")}]`;
}

function normalizedEffect(effect) {
	const source = effect?.toObject?.() ?? {};
	const duration = source.duration && typeof source.duration === "object"
		? {
			/* Foundry v14 duration contract. Runtime start markers are intentionally
			 * excluded below, but authored value/units remain mechanical identity. */
			value: nullableNumber(source.duration.value),
			units: String(source.duration.units ?? ""),
		}
		: null;
	const changes = [...(source.changes ?? [])]
		.map((change) => ({
			key: String(change?.key ?? ""),
			mode: Number(change?.mode ?? 0),
			value: change?.value ?? "",
			priority: nullableNumber(change?.priority),
		}))
		.map((change) => stableStringify(change))
		.sort();
	const statuses = [...(source.statuses ?? [])].map(String).sort();

	return {
		name: String(source.name ?? ""),
		type: String(source.type ?? ""),
		disabled: source.disabled === true,
		transfer: source.transfer === true,
		duration,
		changes,
		statuses,
		system: source.system && typeof source.system === "object"
			? stripRuntimeMetadata(source.system)
			: {},
		flags: source.flags && typeof source.flags === "object"
			? stripRuntimeMetadata(source.flags)
			: {},
	};
}

function stripRuntimeMetadata(value) {
	if (Array.isArray(value)) return value.map((entry) => stripRuntimeMetadata(entry));
	if (!value || typeof value !== "object") return value;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if ([
			"_id",
			"id",
			"origin",
			"sourceId",
			"startTime",
			"startRound",
			"startTurn",
			"updatedAt",
			"createdAt",
		].includes(key)) continue;
		result[key] = stripRuntimeMetadata(entry);
	}
	return result;
}

async function requestStackSplit({ actor, source, application, x, y }) {
	const current = quantity(source);
	if (current < 2) return;
	const amount = await splitQuantityPrompt(source, current, { x, y });
	if (amount === null) return;

	/* Resolve the live embedded Item again after the user answers; quantity may
	 * have changed while the prompt was open. */
	const liveSource = actor.items?.get?.(source.id);
	if (!isStackableEquipment(liveSource)) {
		throw new Error(localize(
			"The Equipment stack no longer exists.",
			"Stos Ekwipunku już nie istnieje.",
		));
	}
	const liveQuantity = quantity(liveSource);
	if (amount < 1 || amount >= liveQuantity) {
		throw new Error(localize(
			`Choose a split amount from 1 to ${Math.max(1, liveQuantity - 1)}.`,
			`Wybierz liczbę od 1 do ${Math.max(1, liveQuantity - 1)} do oddzielenia.`,
		));
	}

	const created = await splitStack(actor, liveSource, amount);
	await rerender(application);
	ui.notifications.info(localize(
		`Split ${liveSource.name}: ${amount} separated, ${liveQuantity - amount} remain in the original stack.`,
		`Podzielono „${liveSource.name}”: oddzielono ${amount}, w pierwotnym stosie pozostało ${liveQuantity - amount}.`,
	));
	return created;
}

function splitQuantityPrompt(source, current, { x = 0, y = 0 } = {}) {
	activeSplitPrompt?.cancel?.();

	return new Promise((resolve) => {
		const ownerDocument = document;
		const panel = ownerDocument.createElement("form");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-modal", "false");
		panel.style.cssText = [
			"position:fixed",
			"z-index:12000",
			"min-width:220px",
			"max-width:300px",
			"padding:10px",
			"border:1px solid var(--color-border-dark-1, #5c4a32)",
			"border-radius:5px",
			"background:var(--color-bg, #f0e5cf)",
			"box-shadow:0 4px 16px rgba(0,0,0,.45)",
			"color:var(--color-text-primary, #191813)",
			"font:14px var(--font-primary, serif)",
		].join(";");

		const title = ownerDocument.createElement("div");
		title.textContent = localize(
			`Split stack: ${source.name}`,
			`Podziel stos: ${source.name}`,
		);
		title.style.cssText = "font-weight:700;margin-bottom:6px";

		const hint = ownerDocument.createElement("label");
		hint.textContent = localize(
			`How many to separate? (1–${current - 1})`,
			`Ile oddzielić? (1–${current - 1})`,
		);
		hint.style.cssText = "display:block;margin-bottom:5px";

		const input = ownerDocument.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = String(current - 1);
		input.step = "1";
		input.value = "1";
		input.required = true;
		input.style.cssText = "box-sizing:border-box;width:100%;margin:0 0 8px;padding:4px 6px;text-align:center";

		const buttons = ownerDocument.createElement("div");
		buttons.style.cssText = "display:flex;gap:6px;justify-content:flex-end";
		const cancelButton = ownerDocument.createElement("button");
		cancelButton.type = "button";
		cancelButton.textContent = localize("Cancel", "Anuluj");
		const confirmButton = ownerDocument.createElement("button");
		confirmButton.type = "submit";
		confirmButton.textContent = localize("Split", "Podziel");
		buttons.append(cancelButton, confirmButton);
		panel.append(title, hint, input, buttons);
		ownerDocument.body.append(panel);

		const finish = (value) => {
			if (!panel.isConnected) return;
			panel.remove();
			ownerDocument.removeEventListener("keydown", onKeyDown, true);
			ownerDocument.removeEventListener("pointerdown", onOutsidePointer, true);
			if (activeSplitPrompt?.panel === panel) activeSplitPrompt = null;
			resolve(value);
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			finish(null);
		};
		const onOutsidePointer = (event) => {
			if (panel.contains(event.target)) return;
			finish(null);
		};

		panel.addEventListener("submit", (event) => {
			event.preventDefault();
			const amount = Math.trunc(Number(input.value));
			if (!Number.isFinite(amount) || amount < 1 || amount >= current) {
				input.setCustomValidity(localize(
					`Enter a number from 1 to ${current - 1}.`,
					`Wpisz liczbę od 1 do ${current - 1}.`,
				));
				input.reportValidity();
				input.setCustomValidity("");
				return;
			}
			finish(amount);
		});
		cancelButton.addEventListener("click", () => finish(null));
		ownerDocument.addEventListener("keydown", onKeyDown, true);
		/* Delay outside-click activation until the cancelled drag gesture has
		 * finished propagating, otherwise the initiating pointer can close its own
		 * prompt immediately on some browsers. */
		setTimeout(() => {
			if (panel.isConnected) ownerDocument.addEventListener("pointerdown", onOutsidePointer, true);
		}, 0);

		activeSplitPrompt = { panel, cancel: () => finish(null) };
		positionSplitPrompt(panel, x, y);
		queueMicrotask(() => {
			if (!panel.isConnected) return;
			input.focus();
			input.select();
		});
	});
}

function positionSplitPrompt(panel, x, y) {
	const margin = 8;
	const offset = 12;
	const viewportWidth = Math.max(320, window.innerWidth || 0);
	const viewportHeight = Math.max(240, window.innerHeight || 0);
	const anchorX = x > 0 ? x : Math.round(viewportWidth / 2);
	const anchorY = y > 0 ? y : Math.round(viewportHeight / 2);

	panel.style.left = `${anchorX + offset}px`;
	panel.style.top = `${anchorY + offset}px`;
	const rect = panel.getBoundingClientRect();
	const left = Math.min(
		Math.max(margin, anchorX + offset),
		Math.max(margin, viewportWidth - rect.width - margin),
	);
	const top = Math.min(
		Math.max(margin, anchorY + offset),
		Math.max(margin, viewportHeight - rect.height - margin),
	);
	panel.style.left = `${Math.round(left)}px`;
	panel.style.top = `${Math.round(top)}px`;
}

async function splitStack(actor, source, amount) {
	const before = quantity(source);
	const remaining = before - amount;
	if (amount < 1 || remaining < 1) {
		throw new Error(localize(
			"A stack split must leave at least one item in both stacks.",
			"Podział stosu musi pozostawić co najmniej jeden przedmiot w obu stosach.",
		));
	}

	const splitSource = source.toObject();
	delete splitSource._id;
	splitSource.system = foundry.utils.deepClone(splitSource.system ?? {});
	splitSource.system.quantity = amount;

	/* Preserve the complete Item definition, including ActiveEffects, flags and
	 * current container/location. Update the original first, then roll it back if
	 * Foundry cannot create the second embedded Item. */
	await source.update({ "system.quantity": remaining });
	try {
		const [created] = await actor.createEmbeddedDocuments("Item", [splitSource]);
		if (!(created instanceof foundry.documents.Item)) {
			throw new Error(localize(
				"Foundry did not create the split Equipment stack.",
				"Foundry nie utworzył oddzielonego stosu Ekwipunku.",
			));
		}
		return created;
	} catch (error) {
		await source.update({ "system.quantity": before }).catch(() => {});
		throw error;
	}
}

async function mergeStacks(source, target, application) {
	const sourceQuantity = quantity(source);
	if (sourceQuantity <= 0) return;
	await target.update({
		"system.quantity": quantity(target) + sourceQuantity,
	});
	await source.delete();
	await rerender(application);
}

async function moveStackToTopLevel(source, application) {
	await source.update({
		"system.containerId": "",
		"system.storageLocation": "",
	});
	await rerender(application);
}

async function rerender(application) {
	if (typeof application?.render !== "function") return;
	await Promise.resolve(application.render({ force: true }));
}

function ownedItemFromMarker(actor, marker) {
	const uuid = String(marker?.itemUuid ?? "").trim();
	if (!uuid) return null;
	return [...(actor.items ?? [])].find(
		(item) => String(item?.uuid ?? "") === uuid,
	) ?? null;
}

function ownedItemDragMarker(dataTransfer) {
	if (!dataTransfer) return null;
	try {
		const raw = dataTransfer.getData(OWNED_ITEM_DRAG_TYPE);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch (_error) {
		return null;
	}
}

function isSameActorEquipmentMarker(marker, actor) {
	return Boolean(
		marker &&
		String(marker.actorUuid ?? "") === String(actor?.uuid ?? "") &&
		String(marker.itemType ?? "") === "equipment"
	);
}

function consumeDrop(event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}

function interactiveOrigin(target) {
	return Boolean(target?.closest?.(
		"input, select, textarea, button, a, [contenteditable='true'], [data-action]",
	));
}

function containerId(item) {
	return String(item?.system?.containerId ?? "").trim();
}

function normalizedName(item) {
	return String(item?.name ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

function quantity(item) {
	const number = Number(item?.system?.quantity ?? 0);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function nullableNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function stableStringify(value) {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function classicSheetRoot(root) {
	if (root?.matches?.(".wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function reportStackingError(error) {
	console.error("WFRP1ED | Equipment stacking failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
