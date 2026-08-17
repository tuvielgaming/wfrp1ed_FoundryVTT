import { CombatRoundTurnState } from "./CombatRoundTurnState.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BASE_INITIATIVE_FLAG = "roundBaseInitiative";
const ROUND_ORDER_FLAG = "roundInitiativeOrder";
export const ROUND_ORDER_OPTION = "wfrpRoundInitiativeOrder";
const DRAG_MIME = "application/x-wfrp-combatant";

/**
 * Round-scoped WFRP acting order independent of Foundry's native Combat.turns.
 *
 * Combatant.initiative is always the real WFRP Initiative score. Foundry keeps
 * its own initiative-sorted Combat.turns array for lifecycle/focus purposes.
 * Temporary WFRP delay/reorder is stored once on the Combat document as
 * `{ round, ids }` and is used for:
 * - deciding who acts next;
 * - displaying rows in the Combat Tracker;
 * - mapping actors onto immutable initiative-clock slots.
 *
 * This separation prevents drag-and-drop from corrupting Initiative or Foundry's
 * turn lifecycle while still allowing an arbitrary acting order for one round.
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

	/** Identify updates which change only the WFRP temporary order. */
	static isOrderUpdate(changed, options) {
		if (options?.[ROUND_ORDER_OPTION]) return true;
		if (!changed || typeof changed !== "object") return false;
		if (Object.hasOwn(changed, `flags.${FLAG_SCOPE}.${ROUND_ORDER_FLAG}`)) return true;
		const scoped = changed.flags?.[FLAG_SCOPE];
		return Boolean(
			scoped &&
			typeof scoped === "object" &&
			(
				Object.hasOwn(scoped, ROUND_ORDER_FLAG) ||
				Object.hasOwn(scoped, `-=${ROUND_ORDER_FLAG}`)
			)
		);
	}

	/** Return persisted current-combatant IDs in their relative WFRP order. */
	static storedIds(combat, round = nonNegativeInteger(combat?.round)) {
		if (!(combat instanceof foundry.documents.Combat)) return null;
		if (round <= 0) return null;

		const state = combat.getFlag?.(FLAG_SCOPE, ROUND_ORDER_FLAG);
		if (!state || typeof state !== "object" || Array.isArray(state)) return null;
		if (nonNegativeInteger(state.round) !== round || !Array.isArray(state.ids)) return null;

		const currentIds = new Set(
			[...combat.combatants].map((entry) => String(entry.id)),
		);
		const seen = new Set();
		return state.ids.map(String).filter((id) => {
			if (!currentIds.has(id) || seen.has(id)) return false;
			seen.add(id);
			return true;
		});
	}

	/** Return a complete valid WFRP order, or null if none is defined. */
	static ids(combat, round = nonNegativeInteger(combat?.round)) {
		if (!(combat instanceof foundry.documents.Combat)) return null;
		if (round <= 0) return null;

		const ids = this.storedIds(combat, round);
		if (!ids) return null;
		const combatantIds = [...combat.combatants].map((entry) => String(entry.id));
		if (ids.length !== combatantIds.length || new Set(ids).size !== ids.length) return null;
		if (combatantIds.some((id) => !ids.includes(id))) return null;
		return ids;
	}

	/** Return the acting order without changing Foundry's native Combat.turns. */
	static orderedCombatants(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return [];
		const ids = this.ids(combat);
		if (!ids) return [...(combat.turns ?? [])];
		return ids
			.map((id) => combat.combatants.get(String(id)) ?? null)
			.filter(Boolean);
	}

	/** First unfinished WFRP turn in the temporary acting order. */
	static firstUnfinished(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return null;
		const skipDefeated = combat.settings?.skipDefeated === true;
		return this.orderedCombatants(combat).find((combatant) => {
			if (skipDefeated && combatant.defeated) return false;
			return !CombatRoundTurnState.isCompleted(combatant);
		}) ?? null;
	}

	/** Build the new round list from real Initiative values. */
	static async initializeRound(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return;
		const round = nonNegativeInteger(combat.round);
		if (!combat.started || round <= 0) return;

		const ordered = [...combat.combatants].sort(compareCanonicalInitiative);
		await this.#writeOrder(
			combat,
			ordered.map((entry) => String(entry.id)),
			round,
		);
	}

	/** Clear only the temporary acting order before the next round. */
	static async resetBeforeNextRound(combat) {
		if (!(combat instanceof foundry.documents.Combat)) return;
		if (combat.getFlag?.(FLAG_SCOPE, ROUND_ORDER_FLAG) === undefined) return;
		if (!combatIsPersisted(combat)) return;

		await combat.update(
			{ [`flags.${FLAG_SCOPE}.${ROUND_ORDER_FLAG}`]: null },
			{ [ROUND_ORDER_OPTION]: true },
		);
	}

	/**
	 * Insert a newly joined Combatant at its canonical Initiative rank while
	 * preserving the relative temporary order of existing combatants.
	 */
	static async insertCombatant(combat, combatant) {
		if (!(combat instanceof foundry.documents.Combat) || !combat.started) return;
		if (!combatIsPersisted(combat)) return;
		assertCombatant(combatant);
		const round = nonNegativeInteger(combat.round);
		if (round <= 0) return;

		const id = String(combatant.id);
		const current = this.storedIds(combat, round)
			?? [...combat.turns].map((entry) => String(entry.id));
		const withoutNew = current.filter((entryId) => entryId !== id);

		const canonical = [...combat.combatants].sort(compareCanonicalInitiative);
		const canonicalIds = canonical.map((entry) => String(entry.id));
		const canonicalIndex = canonicalIds.indexOf(id);
		if (canonicalIndex < 0) return;

		const afterIds = new Set(canonicalIds.slice(canonicalIndex + 1));
		let insertAt = withoutNew.findIndex((entryId) => afterIds.has(entryId));
		if (insertAt < 0) insertAt = withoutNew.length;
		withoutNew.splice(insertAt, 0, id);

		await this.#writeOrder(combat, withoutNew, round);
	}

	/** Preserve the surviving temporary order after one Combatant exits. */
	static async removeCombatant(combat) {
		if (!(combat instanceof foundry.documents.Combat) || !combat.started) return;
		if (!combatIsPersisted(combat)) return;
		const round = nonNegativeInteger(combat.round);
		if (round <= 0) return;

		const stored = this.storedIds(combat, round);
		if (!stored) return;
		const currentIds = [...combat.combatants].map((entry) => String(entry.id));
		const preserved = stored.filter((id) => currentIds.includes(id));
		for (const combatant of [...combat.combatants].sort(compareCanonicalInitiative)) {
			const id = String(combatant.id);
			if (!preserved.includes(id)) preserved.push(id);
		}
		await this.#writeOrder(combat, preserved, round);
	}

	/** Apply an explicit current-round acting order without changing Initiative. */
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
		if (!combatIsPersisted(combat)) return;

		const round = nonNegativeInteger(combat.round);
		if (!combat.started || round <= 0) {
			throw new Error("Round order can only be changed during a started combat round.");
		}

		const ids = validateOrder(combat, orderedIds);
		const activeBefore = combat.combatant ?? null;
		const activeBeforeId = String(activeBefore?.id ?? "");

		await this.#writeOrder(combat, ids, round);

		const movedActive =
			activeBeforeId && String(movedCombatantId) === activeBeforeId;
		if (!movedActive) {
			if (activeBefore) await CombatRoundTurnState.focus(combat, activeBefore);
			return;
		}

		const next = this.firstUnfinished(combat);
		if (!next || String(next.id) === activeBeforeId) {
			if (activeBefore) await CombatRoundTurnState.focus(combat, activeBefore);
			return;
		}
		await CombatRoundTurnState.focus(combat, next);
	}

	static async #writeOrder(combat, ids, round) {
		if (!combatIsPersisted(combat)) return;
		const validated = validateOrder(combat, ids);
		await combat.update(
			{
				[`flags.${FLAG_SCOPE}.${ROUND_ORDER_FLAG}`]: {
					round,
					ids: validated,
				},
			},
			{ [ROUND_ORDER_OPTION]: true },
		);
	}
}

/**
 * Initiative edits outside a running round define the frozen per-round baseline.
 * During a round, tracker drag never changes Initiative.
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

/** Re-render a viewed tracker when only the WFRP order flag changes. */
Hooks.on("updateCombat", (combat, changes, options) => {
	if (!CombatRoundInitiativeOrder.isOrderUpdate(changes, options)) return;
	if (String(game.combat?.id ?? "") !== String(combat?.id ?? "")) return;
	void ui.combat?.render?.();
});

/**
 * Display the WFRP acting order without replacing Foundry's native turn array.
 * GM users additionally receive drag-and-drop controls.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const CombatTracker = foundry.applications?.sidebar?.tabs?.CombatTracker;
	if (!CombatTracker || !(application instanceof CombatTracker)) return;
	const combat = game.combat;
	if (!combat?.started) return;

	applyTrackerDisplayOrder(element, combat);
	if (game.user?.isGM) activateTrackerDrag(element, combat);
});

function applyTrackerDisplayOrder(root, combat) {
	if (!(root instanceof HTMLElement)) return;
	const rows = combatantRows(root);
	if (rows.length < 2) return;
	const list = commonParent(rows);
	if (!(list instanceof HTMLElement)) return;

	const ids = CombatRoundInitiativeOrder.ids(combat);
	if (!ids) return;
	const byId = new Map(rows.map((row) => [combatantId(row), row]));
	const endZone = list.querySelector(":scope > [data-wfrp-initiative-drop-end]");

	for (const id of ids) {
		const row = byId.get(String(id));
		if (!row) continue;
		if (endZone) list.insertBefore(row, endZone);
		else list.append(row);
	}
}

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
			if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
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
			if (event.relatedTarget instanceof Node && endZone.contains(event.relatedTarget)) return;
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

function actionableDropPosition(combat, sourceId, targetId, preferredPosition) {
	const current = currentOrderIds(combat);
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
		const current = currentOrderIds(combat);
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

async function reorderToEnd(combat, sourceId) {
	try {
		const ids = currentOrderIds(combat)
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

function currentOrderIds(combat) {
	return CombatRoundInitiativeOrder.ids(combat)
		?? [...(combat?.turns ?? [])].map((entry) => String(entry.id));
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

function validateOrder(combat, orderedIds) {
	const ids = [...orderedIds].map(String);
	const combatantIds = [...combat.combatants].map((entry) => String(entry.id));
	if (
		ids.length !== combatantIds.length ||
		new Set(ids).size !== ids.length ||
		combatantIds.some((id) => !ids.includes(id))
	) {
		throw new Error("Initiative reorder must include every Combatant exactly once.");
	}
	return ids;
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

function combatIsPersisted(combat) {
	const id = String(combat?.id ?? "");
	return Boolean(id && game.combats?.get?.(id) === combat);
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
