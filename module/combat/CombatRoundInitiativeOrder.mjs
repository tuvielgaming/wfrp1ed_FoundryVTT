import { CombatRoundTurnState } from "./CombatRoundTurnState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BASE_INITIATIVE_FLAG = "roundBaseInitiative";
const ROUND_ORDER_FLAG = "roundInitiativeOrder";
const REORDER_OPTION = "wfrpRoundInitiativeReorder";
const RESET_OPTION = "wfrpRoundInitiativeReset";
const DRAG_MIME = "application/x-wfrp-combatant";

/**
 * Round-scoped WFRP turn ordering independent of Initiative values.
 *
 * `Combatant.initiative` is the real WFRP Initiative score for the round. It is
 * never rewritten merely to move a row in the Combat Tracker. A separate
 * round-order flag stores the temporary list position used by WFRP delay/reorder
 * handling. At the beginning of a new round that list is rebuilt from the real
 * Initiative scores.
 *
 * This separation is required by the Critical initiative clock: moving an Actor
 * in the tracker may change who occupies a timeline slot, but it must never move
 * the numeric Initiative coordinate itself.
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

	/**
	 * Return this Combatant's explicit list position for the requested round.
	 * Missing/stale state deliberately returns null so Foundry can fall back to
	 * normal Initiative sorting before combat and during round transitions.
	 */
	static position(combatant, round = nonNegativeInteger(combatant?.parent?.round)) {
		if (!(combatant instanceof foundry.documents.Combatant)) return null;
		const state = combatant.getFlag?.(FLAG_SCOPE, ROUND_ORDER_FLAG);
		if (!state || typeof state !== "object" || Array.isArray(state)) return null;
		if (nonNegativeInteger(state.round) !== nonNegativeInteger(round)) return null;
		const position = Number(state.position);
		return Number.isInteger(position) && position >= 0 ? position : null;
	}

	/**
	 * Comparator contribution used by Wfrp1edCombat._sortCombatants.
	 *
	 * A Combatant without current-round order state is placed after established
	 * rows until the authoritative GM initializes/inserts it. If no current-round
	 * order exists at all, return null so Foundry's Initiative comparator applies.
	 */
	static compare(combat, left, right) {
		if (!(combat instanceof foundry.documents.Combat)) return null;
		const round = nonNegativeInteger(combat.round);
		if (!combat.started || round <= 0) return null;

		const leftPosition = this.position(left, round);
		const rightPosition = this.position(right, round);
		if (leftPosition === null && rightPosition === null) return null;
		if (leftPosition === null) return 1;
		if (rightPosition === null) return -1;
		return leftPosition - rightPosition;
	}

	/** Build the new round list from immutable Initiative values. */
	static async initializeRound(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return;
		const round = nonNegativeInteger(combat.round);
		if (!combat.started || round <= 0) return;

		const ordered = [...combat.combatants].sort(compareCanonicalInitiative);
		await this.#writeOrder(combat, ordered.map((entry) => String(entry.id)), round, {
			option: RESET_OPTION,
		});
	}

	/**
	 * Remove the completed round's temporary order before Foundry selects the
	 * next round's first Combatant. Initiative values remain untouched.
	 */
	static async resetBeforeNextRound(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return;
		const updates = [...combat.combatants].map((combatant) => ({
			_id: combatant.id,
			[`flags.${FLAG_SCOPE}.${ROUND_ORDER_FLAG}`]: null,
		}));
		if (!updates.length) return;
		await combat.updateEmbeddedDocuments(
			"Combatant",
			updates,
			{ [RESET_OPTION]: true },
		);
	}

	/**
	 * Insert a newly joined Combatant into this round without disturbing the
	 * relative order of existing rows. The insertion slot is its canonical rank
	 * by real Initiative; any earlier delay/reorder among existing rows survives.
	 */
	static async insertCombatant(combat, combatant) {
		if (!(combat instanceof foundry.documents.Combat) || !combat.started) return;
		assertCombatant(combatant);
		const round = nonNegativeInteger(combat.round);
		if (round <= 0) return;

		const id = String(combatant.id);
		const current = combat.turns
			.map((entry) => String(entry.id))
			.filter((entryId) => entryId !== id);
		const canonical = [...combat.combatants].sort(compareCanonicalInitiative);
		const canonicalIndex = Math.max(
			0,
			canonical.findIndex((entry) => String(entry.id) === id),
		);
		const insertAt = Math.min(canonicalIndex, current.length);
		current.splice(insertAt, 0, id);
		await this.applyOrder(combat, current);
	}

	/** Apply an explicit current-round list order without changing Initiative. */
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

		const round = nonNegativeInteger(combat.round);
		if (!combat.started || round <= 0) {
			throw new Error("Round order can only be changed during a started combat round.");
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
		const activeBeforeId = String(
			combat.current?.combatantId ?? combat.combatant?.id ?? "",
		);

		await this.#writeOrder(combat, ids, round, { option: REORDER_OPTION });

		/*
		 * Changing the list order can change which row lives at Combat.turn's old
		 * numeric index. Re-focus the lifecycle owner so the active Combatant stays
		 * the same unless the active row itself was deliberately postponed.
		 */
		const activeBefore = activeBeforeId
			? combat.combatants.get(activeBeforeId) ?? null
			: null;
		if (activeBefore) {
			await CombatRoundTurnState.focus(combat, activeBefore);
		}

		/*
		 * - Moving a non-active row preserves the current Combatant.
		 * - Moving the active row is a postponement: focus the first unfinished
		 *   Combatant from the top of the new order.
		 */
		const movedActive =
			activeBeforeId && String(movedCombatantId) === activeBeforeId;
		if (!movedActive) return;

		const next = CombatRoundTurnState.firstUnfinished(combat);
		if (next) await CombatRoundTurnState.focus(combat, next);
	}

	static async #writeOrder(combat, ids, round, { option } = {}) {
		const updates = ids.map((id, index) => ({
			_id: id,
			[`flags.${FLAG_SCOPE}.${ROUND_ORDER_FLAG}`]: {
				round,
				position: index,
			},
		}));
		if (!updates.length) return;
		await combat.updateEmbeddedDocuments(
			"Combatant",
			updates,
			option ? { [option]: true } : {},
		);
	}
}

/**
 * Initiative edits outside a running round define the baseline. During a round,
 * the displayed Initiative may be edited by the GM but tracker drag never does
 * so; the current round order is a different piece of state.
 */
Hooks.on("updateCombatant", (combatant, changes) => {
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
			"GM: drag to change only this round's turn order. The Initiative value is not changed.",
			"MG: przeciągnij, aby zmienić tylko kolejność tur w tej rundzie. Wartość Inicjatywy nie jest zmieniana.",
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
			if (row.classList.contains("wfrp-initiative-drag-source")) return;

			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
			clearDropTargets(root, row);

			const rect = row.getBoundingClientRect();
			const pointerPosition = event.clientY > rect.top + rect.height / 2
				? "after"
				: "before";
			row.classList.add("wfrp-initiative-drop-target");
			row.dataset.wfrpDropPosition = pointerPosition;
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
			const preferredPosition = row.dataset.wfrpDropPosition === "after"
				? "after"
				: "before";
			const position = actionableDropPosition(
				combat,
				sourceId,
				id,
				preferredPosition,
			);
			clearDropFeedback(root);
			if (!position) return;
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

/**
 * Keep the green target indicator honest: whenever the pointer-selected half of
 * a neighboring row would produce the exact same order, flip to the other half.
 */
function actionableDropPosition(combat, sourceId, targetId, preferredPosition) {
	const current = combat.turns.map((entry) => String(entry.id));
	const preferred = relativeOrder(
		current,
		sourceId,
		targetId,
		preferredPosition,
	);
	if (preferred && !sameOrder(current, preferred)) return preferredPosition;

	const alternatePosition = preferredPosition === "after" ? "before" : "after";
	const alternate = relativeOrder(
		current,
		sourceId,
		targetId,
		alternatePosition,
	);
	if (alternate && !sameOrder(current, alternate)) return alternatePosition;
	return null;
}

async function reorderRelative(combat, sourceId, targetId, position) {
	try {
		const current = combat.turns.map((entry) => String(entry.id));
		const ids = relativeOrder(current, sourceId, targetId, position);
		if (!ids || sameOrder(current, ids)) return;

		await CombatRoundInitiativeOrder.applyOrder(combat, ids, {
			movedCombatantId: sourceId,
		});
	} catch (error) {
		console.error("WFRP1ED | Unable to reorder initiative.", error);
		ui.notifications.error(error?.message ?? String(error));
	}
}

function relativeOrder(currentIds, sourceId, targetId, position) {
	const ids = [...currentIds].map(String);
	const source = String(sourceId);
	const target = String(targetId);
	const from = ids.indexOf(source);
	if (from < 0 || source === target || !ids.includes(target)) return null;

	ids.splice(from, 1);
	let insertAt = ids.indexOf(target);
	if (position === "after") insertAt += 1;
	ids.splice(insertAt, 0, source);
	return ids;
}

function sameOrder(left, right) {
	return left.length === right.length &&
		left.every((id, index) => String(id) === String(right[index]));
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

function compareCanonicalInitiative(left, right) {
	const leftInitiative = nullableFinite(left?.initiative);
	const rightInitiative = nullableFinite(right?.initiative);
	if (leftInitiative === null && rightInitiative !== null) return 1;
	if (rightInitiative === null && leftInitiative !== null) return -1;
	if (leftInitiative !== null && rightInitiative !== null && leftInitiative !== rightInitiative) {
		return rightInitiative - leftInitiative;
	}
	return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function nullableFinite(value) {
	if (value === null || value === undefined || value === "") return null;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function assertCombatant(combatant) {
	if (!(combatant instanceof foundry.documents.Combatant)) {
		throw new TypeError("A Foundry Combatant is required.");
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
