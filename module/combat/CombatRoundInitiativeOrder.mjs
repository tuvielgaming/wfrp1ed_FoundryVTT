import { CombatRoundTurnState } from "./CombatRoundTurnState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BASE_INITIATIVE_FLAG = "roundBaseInitiative";
const REORDER_OPTION = "wfrpRoundInitiativeReorder";
const RESET_OPTION = "wfrpRoundInitiativeReset";
const DRAG_MIME = "application/x-wfrp-combatant";

/**
 * Round-scoped WFRP initiative ordering.
 *
 * A Combatant's baseline initiative is captured before combat. During a started
 * round the GM may edit initiative normally or drag Combat Tracker rows to
 * postpone/reorder turns. These values are temporary and reset next round.
 *
 * Turn completion is owned by CombatRoundTurnState rather than by list position.
 * Reordering the active Combatant therefore transfers focus to the first
 * unfinished Combatant in the new order without marking the postponed actor as
 * finished for the round.
 */
export class CombatRoundInitiativeOrder {
	static async captureBaseline(combatant, { force = false } = {}) {
		assertCombatant(combatant);
		const current = nullableFinite(combatant.initiative);
		const existing = combatant.getFlag(FLAG_SCOPE, BASE_INITIATIVE_FLAG);
		if (!force && existing !== undefined && existing !== null) return existing;
		if (current === null) return null;

		await combatant.setFlag(
			FLAG_SCOPE,
			BASE_INITIATIVE_FLAG,
			current,
		);
		return current;
	}

	static async captureCombatBaselines(combat, { force = false } = {}) {
		if (!(combat instanceof foundry.documents.Combat)) return;
		for (const combatant of combat.combatants) {
			await this.captureBaseline(combatant, { force });
		}
	}

	/** Restore temporary initiative changes before Foundry advances the round. */
	static async resetBeforeNextRound(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return;
		const updates = [];

		for (const combatant of combat.combatants) {
			const base = nullableFinite(
				combatant.getFlag(FLAG_SCOPE, BASE_INITIATIVE_FLAG),
			);
			if (base === null) continue;
			if (nullableFinite(combatant.initiative) === base) continue;
			updates.push({ _id: combatant.id, initiative: base });
		}

		if (updates.length) {
			await combat.updateEmbeddedDocuments(
				"Combatant",
				updates,
				{ [RESET_OPTION]: true },
			);
		}
	}

	/** Apply an explicit current-round order using temporary initiative values. */
	static async applyOrder(combat, orderedIds, { movedCombatantId = "" } = {}) {
		if (!(combat instanceof foundry.documents.Combat)) {
			throw new TypeError("A Foundry Combat is required.");
		}
		if (!game.user?.isGM) {
			throw new Error(localize(
				"Only a GM can reorder initiative.",
				"Tylko MG może zmieniać kolejność inicjatywy.",
			));
		}

		const ids = [...orderedIds].map(String);
		const combatantIds = [...combat.combatants].map((entry) => String(entry.id));
		if (
			ids.length !== combatantIds.length ||
			new Set(ids).size !== ids.length ||
			combatantIds.some((id) => !ids.includes(id))
		) {
			throw new Error("Initiative reorder must include every Combatant exactly once.");
		}

		await this.captureCombatBaselines(combat);
		const activeBeforeId = String(combat.combatant?.id ?? "");

		/*
		 * Anchor synthetic values to the stable baseline rather than to previous
		 * temporary values. Repeated drags cannot inflate initiative indefinitely.
		 */
		const baselineValues = [...combat.combatants]
			.map((entry) => nullableFinite(
				entry.getFlag(FLAG_SCOPE, BASE_INITIATIVE_FLAG),
			))
			.filter((value) => value !== null);
		const currentValues = [...combat.combatants]
			.map((entry) => nullableFinite(entry.initiative))
			.filter((value) => value !== null);
		const top = baselineValues.length
			? Math.max(...baselineValues)
			: currentValues.length
				? Math.max(...currentValues)
				: ids.length;

		const updates = ids.map((id, index) => ({
			_id: id,
			initiative: top + ids.length - index,
		}));

		await combat.updateEmbeddedDocuments(
			"Combatant",
			updates,
			{ [REORDER_OPTION]: true },
		);

		/*
		 * Initiative is sortable data while Combat.turn is a numeric index. After
		 * reordering we must explicitly choose which Combatant owns the turn.
		 *
		 * - Moving a non-active row preserves the current Combatant.
		 * - Moving the active row is a postponement: focus the first unfinished
		 *   Combatant from the top of the new order. If everyone else has already
		 *   finished, the postponed Combatant keeps focus.
		 */
		const movedActive =
			activeBeforeId && String(movedCombatantId) === activeBeforeId;
		let focus = null;
		if (movedActive) {
			focus = CombatRoundTurnState.firstUnfinished(combat);
		} else if (activeBeforeId) {
			focus = combat.combatants.get(activeBeforeId) ?? null;
		}
		if (!focus) focus = CombatRoundTurnState.firstUnfinished(combat);
		if (focus) await CombatRoundTurnState.focus(combat, focus);
	}
}

/**
 * Native initiative edits before combat define the baseline. During combat they
 * are temporary. If a Combatant had no initiative when combat started, the
 * first finite value assigned becomes its baseline.
 */
Hooks.on("updateCombatant", (combatant, changes, options) => {
	if (options?.[RESET_OPTION]) return;
	if (!Object.hasOwn(changes ?? {}, "initiative")) return;
	if (!game.user?.isGM) return;

	const value = nullableFinite(changes.initiative);
	if (value === null) return;
	const combat = combatant.parent;
	const existing = combatant.getFlag(FLAG_SCOPE, BASE_INITIATIVE_FLAG);
	const shouldCapture = !combat?.started || existing === undefined || existing === null;
	if (!shouldCapture) return;

	void combatant.setFlag(
		FLAG_SCOPE,
		BASE_INITIATIVE_FLAG,
		value,
	);
});

/** GM drag-and-drop convenience for the native Foundry v14 Combat Tracker. */
Hooks.on("renderApplicationV2", (application, element) => {
	const CombatTracker = foundry.applications?.sidebar?.tabs?.CombatTracker;
	if (!CombatTracker || !(application instanceof CombatTracker)) return;
	if (!game.user?.isGM || !game.combat?.started) return;
	activateTrackerDrag(element, game.combat);
});

function activateTrackerDrag(root, combat) {
	if (!(root instanceof HTMLElement)) return;
	const rows = combatantRows(root);
	if (rows.length < 2) return;

	root.dataset.wfrpInitiativeDragRoot = "true";
	const list = commonParent(rows);
	const endZone = ensureEndDropZone(list);

	for (const row of rows) {
		if (row.dataset.wfrpInitiativeDrag === "true") continue;
		const id = combatantId(row);
		if (!id || !combat.combatants.get(id)) continue;

		row.dataset.wfrpInitiativeDrag = "true";
		row.draggable = true;
		row.title = localize(
			"GM: drag to change initiative order for this round. Manual initiative edits are also temporary and reset next round.",
			"MG: przeciągnij, aby zmienić kolejność inicjatywy w tej rundzie. Ręczna zmiana wartości inicjatywy także jest tymczasowa i resetuje się w następnej rundzie.",
		);

		/* Foundry's token portrait is draggable by default and can steal the drag
		 * gesture from the Combatant row. Disable only the tracker image drag so
		 * grabbing the portrait naturally drags the whole Combatant. */
		for (const image of row.querySelectorAll("img")) image.draggable = false;

		row.addEventListener("dragstart", (event) => {
			clearDropFeedback(root);
			root.classList.add("wfrp-initiative-dragging");
			row.classList.add("wfrp-initiative-drag-source");
			event.dataTransfer?.setData(DRAG_MIME, id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		});

		row.addEventListener("dragover", (event) => {
			if (!hasWfrpDrag(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			clearDropTargets(root, row);
			const rect = row.getBoundingClientRect();
			const after = event.clientY > rect.top + rect.height / 2;
			row.classList.add("wfrp-initiative-drop-target");
			row.dataset.wfrpDropPosition = after ? "after" : "before";
		});

		row.addEventListener("dragleave", (event) => {
			if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) {
				return;
			}
			row.classList.remove("wfrp-initiative-drop-target");
			delete row.dataset.wfrpDropPosition;
		});

		row.addEventListener("drop", (event) => {
			const sourceId = event.dataTransfer?.getData(DRAG_MIME);
			if (!sourceId || sourceId === id) return;
			event.preventDefault();
			event.stopPropagation();
			const position = row.dataset.wfrpDropPosition === "after"
				? "after"
				: "before";
			clearDropFeedback(root);
			void reorderRelative(combat, sourceId, id, position);
		});

		row.addEventListener("dragend", () => clearDropFeedback(root));
	}

	if (endZone && endZone.dataset.wfrpInitiativeBound !== "true") {
		endZone.dataset.wfrpInitiativeBound = "true";
		endZone.addEventListener("dragover", (event) => {
			if (!hasWfrpDrag(event)) return;
			event.preventDefault();
			clearDropTargets(root, endZone);
			endZone.classList.add("wfrp-initiative-drop-end--active");
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		});
		endZone.addEventListener("dragleave", (event) => {
			if (
				event.relatedTarget instanceof Node &&
				endZone.contains(event.relatedTarget)
			) return;
			endZone.classList.remove("wfrp-initiative-drop-end--active");
		});
		endZone.addEventListener("drop", (event) => {
			const sourceId = event.dataTransfer?.getData(DRAG_MIME);
			if (!sourceId) return;
			event.preventDefault();
			event.stopPropagation();
			clearDropFeedback(root);
			void reorderToEnd(combat, sourceId);
		});
	}
}

async function reorderRelative(combat, sourceId, targetId, position) {
	try {
		const ids = combat.turns.map((entry) => String(entry.id));
		const from = ids.indexOf(String(sourceId));
		if (from < 0 || !ids.includes(String(targetId))) return;

		ids.splice(from, 1);
		let insertAt = ids.indexOf(String(targetId));
		if (position === "after") insertAt += 1;
		ids.splice(insertAt, 0, String(sourceId));

		await CombatRoundInitiativeOrder.applyOrder(combat, ids, {
			movedCombatantId: sourceId,
		});
	} catch (error) {
		console.error("WFRP1ED | Unable to reorder initiative.", error);
		ui.notifications.error(error?.message ?? String(error));
	}
}

async function reorderToEnd(combat, sourceId) {
	try {
		const ids = combat.turns
			.map((entry) => String(entry.id))
			.filter((id) => id !== String(sourceId));
		if (!combat.combatants.get(String(sourceId))) return;
		ids.push(String(sourceId));
		await CombatRoundInitiativeOrder.applyOrder(combat, ids, {
			movedCombatantId: sourceId,
		});
	} catch (error) {
		console.error("WFRP1ED | Unable to move initiative to end.", error);
		ui.notifications.error(error?.message ?? String(error));
	}
}

function ensureEndDropZone(list) {
	if (!(list instanceof HTMLElement)) return null;
	let zone = list.querySelector(":scope > [data-wfrp-initiative-drop-end]");
	if (zone) return zone;

	zone = document.createElement(list.tagName === "OL" || list.tagName === "UL" ? "li" : "div");
	zone.dataset.wfrpInitiativeDropEnd = "";
	zone.classList.add("wfrp-initiative-drop-end");
	zone.textContent = localize("Move to end", "Przenieś na koniec");
	list.append(zone);
	return zone;
}

function commonParent(rows) {
	const first = rows[0]?.parentElement ?? null;
	return first && rows.every((row) => row.parentElement === first) ? first : null;
}

function clearDropFeedback(root) {
	root.classList.remove("wfrp-initiative-dragging");
	for (const row of root.querySelectorAll(
		".wfrp-initiative-drag-source, .wfrp-initiative-drop-target",
	)) {
		row.classList.remove(
			"wfrp-initiative-drag-source",
			"wfrp-initiative-drop-target",
		);
		delete row.dataset.wfrpDropPosition;
	}
	for (const zone of root.querySelectorAll(".wfrp-initiative-drop-end--active")) {
		zone.classList.remove("wfrp-initiative-drop-end--active");
	}
}

function clearDropTargets(root, except = null) {
	for (const row of root.querySelectorAll(".wfrp-initiative-drop-target")) {
		if (row === except) continue;
		row.classList.remove("wfrp-initiative-drop-target");
		delete row.dataset.wfrpDropPosition;
	}
	for (const zone of root.querySelectorAll(".wfrp-initiative-drop-end--active")) {
		if (zone === except) continue;
		zone.classList.remove("wfrp-initiative-drop-end--active");
	}
}

function hasWfrpDrag(event) {
	return Boolean(event.dataTransfer?.types?.includes(DRAG_MIME));
}

function combatantRows(root) {
	const selectors = [
		".combatant[data-combatant-id]",
		"[data-combatant-id].combatant",
		"li[data-combatant-id]",
		"[data-entry-id].combatant",
	];
	const result = new Set();
	for (const selector of selectors) {
		for (const row of root.querySelectorAll(selector)) result.add(row);
	}
	return [...result];
}

function combatantId(row) {
	return String(
		row?.dataset?.combatantId ??
		row?.dataset?.entryId ??
		"",
	).trim();
}

function nullableFinite(value) {
	if (value === null || value === undefined || value === "") return null;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
