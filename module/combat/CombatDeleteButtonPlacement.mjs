const COMBAT_ROW_SELECTORS = Object.freeze([
	".melee-row",
	".ranged-row",
	".armour-row",
]);

/**
 * Keep Weapon/Armour delete controls visually consistent with Classic
 * Equipment/Wealth rows without changing the combat table renderer itself.
 *
 * CombatSheetIntegration creates the authoritative delete button and its
 * behaviour inside the Item-name controls. This presentation layer simply
 * moves that existing button to the last printed cell after the row has been
 * rendered, preserving its event listeners and confirmation workflow.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor") return;

	const root = asElement(element);
	if (!root?.querySelector?.(".wfrp1ed-classic-sheet")) return;

	requestAnimationFrame(() => {
		const liveRoot = asElement(application?.element) ?? root;
		placeCombatDeleteButtons(liveRoot);
	});
});

function placeCombatDeleteButtons(root) {
	for (const selector of COMBAT_ROW_SELECTORS) {
		for (const row of root.querySelectorAll(selector)) {
			if (!(row instanceof HTMLElement)) continue;

			const deleteButton = row.querySelector(".combat-sheet-delete-item");
			if (!(deleteButton instanceof HTMLButtonElement)) continue;

			const cells = row.querySelectorAll("[role='cell']");
			const terminalCell = cells[cells.length - 1];
			if (!(terminalCell instanceof HTMLElement)) continue;

			terminalCell.classList.add("combat-sheet-delete-cell");
			if (deleteButton.parentElement !== terminalCell) {
				terminalCell.append(deleteButton);
			}
		}
	}
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}
