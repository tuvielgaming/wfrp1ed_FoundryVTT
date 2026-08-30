import { RACE_CAREER_CLASSES } from "../data-models/item/RaceData.mjs";

const SORT_GUARD = "wfrp1edPercentileTableOrdering";

Hooks.on("updateItem", (item, changed, options, userId) => {
	if (item?.type !== "race") return;
	if (userId !== game.user?.id) return;
	if (options?.[SORT_GUARD] === true) return;
	if (!touchesPercentileTables(changed)) return;

	void sortPercentileTables(item).catch((error) => {
		console.error("WFRP1ED | Race percentile-table ordering failed.", error);
		ui.notifications.error(localize(
			"Could not reorder the Race percentile table.",
			"Nie udało się uporządkować tabeli procentowej Rasy.",
		));
	});
});

/**
 * K100 table rows are authored by their ranges, so their stored/presented order
 * should follow those ranges rather than the historical order in which rows
 * happened to be dropped or edited.
 *
 * This intentionally does NOT repair ranges. Gaps, overlaps, or reversed ranges
 * remain exactly as authored and continue to be reported by the existing
 * validator. We only sort rows by min, then max, with original order as the
 * stable tie-breaker.
 */
async function sortPercentileTables(item) {
	const update = {};

	for (const tableName of ["skillTables", "basicCareerTables"]) {
		const source = tableObject(item.system?.[tableName]);
		const sorted = foundry.utils.deepClone(source);
		let changed = false;

		for (const careerClass of RACE_CAREER_CLASSES) {
			const rows = cloneArray(source?.[careerClass]);
			const ordered = stableRangeSort(rows);
			if (!sameOrder(rows, ordered)) changed = true;
			sorted[careerClass] = ordered;
		}

		if (changed) update[`system.${tableName}`] = sorted;
	}

	if (!Object.keys(update).length) return;
	await item.update(update, { [SORT_GUARD]: true });
}

function stableRangeSort(rows) {
	return rows
		.map((row, index) => ({ row, index }))
		.sort((left, right) => {
			const minDifference = percentile(left.row?.min) - percentile(right.row?.min);
			if (minDifference) return minDifference;
			const maxDifference = percentile(left.row?.max) - percentile(right.row?.max);
			if (maxDifference) return maxDifference;
			return left.index - right.index;
		})
		.map(({ row }) => row);
}

function touchesPercentileTables(changed) {
	if (!changed || typeof changed !== "object") return false;
	if (foundry.utils.hasProperty(changed, "system.skillTables")) return true;
	if (foundry.utils.hasProperty(changed, "system.basicCareerTables")) return true;

	return Object.keys(changed).some((key) =>
		key === "system.skillTables" ||
		key.startsWith("system.skillTables.") ||
		key === "system.basicCareerTables" ||
		key.startsWith("system.basicCareerTables."),
	);
}

function sameOrder(before, after) {
	if (before.length !== after.length) return false;
	return before.every((row, index) => rowSignature(row) === rowSignature(after[index]));
}

function rowSignature(row) {
	return JSON.stringify(row?.toObject?.() ?? row ?? {});
}

function tableObject(value) {
	const source = value?.toObject?.() ?? value;
	return source && typeof source === "object" ? foundry.utils.deepClone(source) : {};
}

function cloneArray(value) {
	const source = value?.toObject?.() ?? value;
	return Array.isArray(source) ? foundry.utils.deepClone(source) : [];
}

function percentile(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 101;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
