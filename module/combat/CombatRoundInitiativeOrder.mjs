const FLAG_SCOPE = "wfrp1ed";
const BASE_INITIATIVE_FLAG = "roundBaseInitiative";
const BASE_CAPTURE_OPTION = "wfrpRoundBaseInitiativeCapture";
const REORDER_OPTION = "wfrpRoundInitiativeReorder";
const RESET_OPTION = "wfrpRoundInitiativeReset";

/**
 * Round-scoped WFRP initiative ordering.
 *
 * A Combatant's baseline initiative is captured before combat (or the first
 * time a real initiative value appears). During a started round the GM may edit
 * initiative normally or drag Combat Tracker rows to postpone/reorder turns.
 * Those initiative values are temporary. Immediately before Next Round the
 * baseline values are restored, so the following round starts from the normal
 * initiative order again.
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
			{ [BASE_CAPTURE_OPTION]: true },
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
	static async applyOrder(combat, orderedIds) {
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

		const finiteValues = [...combat.combatants]
			.map((entry) => Number(entry.initiative))
			.filter(Number.isFinite);
		const top = finiteValues.length
			? Math.max(...finiteValues)
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
	}
}

/**
 * Native initiative edits before combat define the baseline. During combat they
 * are intentionally temporary. If a Combatant had no initiative when combat
 * started, the first finite value assigned becomes its baseline.
 */
Hooks.on("updateCombatant", (combatant, changes, options) => {
	if (options?.[BASE_CAPTURE_OPTION] || options?.[RESET_OPTION]) return;
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
		{ [BASE_CAPTURE_OPTION]: true },
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

		row.addEventListener("dragstart", (event) => {
			event.dataTransfer?.setData("application/x-wfrp-combatant", id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		});

		row.addEventListener("dragover", (event) => {
			if (!event.dataTransfer?.types?.includes("application/x-wfrp-combatant")) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		});

		row.addEventListener("drop", (event) => {
			const sourceId = event.dataTransfer?.getData("application/x-wfrp-combatant");
			if (!sourceId || sourceId === id) return;
			event.preventDefault();
			void reorderFromDrop(combat, sourceId, id, row, event);
		});
	}
}

async function reorderFromDrop(combat, sourceId, targetId, targetRow, event) {
	try {
		const ids = combat.turns.map((entry) => String(entry.id));
		const from = ids.indexOf(String(sourceId));
		const target = ids.indexOf(String(targetId));
		if (from < 0 || target < 0) return;

		ids.splice(from, 1);
		let insertAt = ids.indexOf(String(targetId));
		const rect = targetRow.getBoundingClientRect();
		const after = event.clientY > rect.top + rect.height / 2;
		if (after) insertAt += 1;
		ids.splice(insertAt, 0, String(sourceId));

		await CombatRoundInitiativeOrder.applyOrder(combat, ids);
	} catch (error) {
		console.error("WFRP1ED | Unable to reorder initiative.", error);
		ui.notifications.error(error?.message ?? String(error));
	}
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
