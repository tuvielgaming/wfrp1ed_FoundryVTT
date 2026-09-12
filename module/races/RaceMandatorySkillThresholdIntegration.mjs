import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const SORT_GUARD = "wfrp1edMandatorySkillThresholdOrdering";

install();

/**
 * Mandatory racial Skills are top-level acquisition entries. A standalone Skill
 * and a package therefore consume exactly one acquisition threshold each.
 *
 * Race authoring intentionally allows temporary duplicate thresholds while the
 * user is rearranging entries. The sheet cannot be closed until every top-level
 * entry has a unique threshold. Whenever mandatorySkills changes, entries are
 * kept in ascending threshold order; equal thresholds use their existing order
 * as a stable tie-breaker so conflicts stay adjacent and easy to resolve.
 */
function install() {
	if (RaceItemSheet.prototype.__wfrpMandatorySkillThresholdsInstalled === true) return;

	const originalClose = RaceItemSheet.prototype.close;
	RaceItemSheet.prototype.close = async function mandatorySkillThresholdClose(options = {}) {
		if (this.isEditable) {
			const conflicts = duplicateThresholds(this.document.system?.mandatorySkills);
			if (conflicts.length) {
				ui.notifications.warn(closeBlockedMessage(conflicts));
				return this;
			}
		}
		return originalClose.call(this, options);
	};

	Hooks.on("updateItem", (item, changed, options, userId) => {
		if (item?.type !== "race") return;
		if (userId !== game.user?.id) return;
		if (options?.[SORT_GUARD] === true) return;
		if (!touchesMandatorySkills(changed)) return;

		void sortMandatorySkills(item).catch((error) => {
			console.error("WFRP1ED | Race mandatory Skill threshold ordering failed.", error);
			ui.notifications.error(localize(
				"Could not reorder mandatory racial Skills by acquisition threshold.",
				"Nie udało się uporządkować obowiązkowych Umiejętności rasowych według progu nabycia.",
			));
		});
	});

	Object.defineProperty(
		RaceItemSheet.prototype,
		"__wfrpMandatorySkillThresholdsInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

async function sortMandatorySkills(item) {
	const before = cloneArray(item.system?.mandatorySkills);
	const after = stableThresholdSort(before);
	if (sameOrder(before, after)) return;
	await item.update({ "system.mandatorySkills": after }, { [SORT_GUARD]: true });
}

export function stableThresholdSort(source) {
	return cloneArray(source)
		.map((entry, index) => ({ entry, index, threshold: thresholdOf(entry) }))
		.sort((left, right) => left.threshold - right.threshold || left.index - right.index)
		.map(({ entry }) => entry);
}

export function duplicateThresholds(source) {
	const counts = new Map();
	for (const entry of cloneArray(source)) {
		const threshold = thresholdOf(entry);
		counts.set(threshold, (counts.get(threshold) ?? 0) + 1);
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([threshold, count]) => ({ threshold, count }))
		.sort((left, right) => left.threshold - right.threshold);
}

function closeBlockedMessage(conflicts) {
	const summary = conflicts
		.map(({ threshold, count }) => `${threshold} (${count}×)`)
		.join(", ");
	return localize(
		`Race sheet cannot be closed while mandatory Skills or packages share an acquisition threshold. Repeated thresholds: ${summary}. Assign a unique threshold to every standalone Skill or package.`,
		`Nie można zamknąć karty Rasy, gdy obowiązkowe Umiejętności lub pakiety mają ten sam próg nabycia. Powtórzone progi: ${summary}. Ustaw unikalny próg dla każdej samodzielnej Umiejętności lub pakietu.`,
	);
}

function touchesMandatorySkills(changed) {
	if (!changed || typeof changed !== "object") return false;
	if (foundry.utils.hasProperty(changed, "system.mandatorySkills")) return true;
	return Object.keys(changed).some((key) =>
		key === "system.mandatorySkills" || key.startsWith("system.mandatorySkills."),
	);
}

function sameOrder(before, after) {
	if (before.length !== after.length) return false;
	return before.every((entry, index) => entrySignature(entry) === entrySignature(after[index]));
}

function entrySignature(entry) {
	return JSON.stringify(entry?.toObject?.() ?? entry ?? {});
}

function thresholdOf(entry) {
	return Math.max(1, integer(entry?.minInitialSkills, 1));
}

function cloneArray(value) {
	const source = value?.toObject?.() ?? value;
	return Array.isArray(source) ? foundry.utils.deepClone(source) : [];
}

function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
