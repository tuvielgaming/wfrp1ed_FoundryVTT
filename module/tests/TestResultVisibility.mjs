export const TEST_RESULT_VISIBILITY = Object.freeze({
	GM_ONLY: "gm-only",
	PUBLIC: "public",
});

/**
 * Normalize one result-detail visibility value.
 *
 * The persisted `gm-only` identifier is retained for backward compatibility,
 * but its current presentation contract is "restricted": the GM and an OWNER
 * of the Actor who made the Test may inspect full details. Other players receive
 * only the compact identity/target/result summary unless the GM explicitly
 * changes the result to PUBLIC.
 *
 * This setting does not alter Foundry's ChatMessage roll mode or document
 * visibility.
 *
 * @param {*} value
 * @returns {"gm-only"|"public"}
 */
export function normalizeTestResultVisibility(value) {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();

	return normalized === TEST_RESULT_VISIBILITY.PUBLIC
		? TEST_RESULT_VISIBILITY.PUBLIC
		: TEST_RESULT_VISIBILITY.GM_ONLY;
}

/**
 * Localized options for GM-facing result-detail selectors.
 *
 * @returns {Array<{value:string,label:string}>}
 */
export function testResultVisibilityOptions() {
	return [
		{
			value: TEST_RESULT_VISIBILITY.GM_ONLY,
			label: localize(
				"WFRP1ED.TestResult.Visibility.GMOnly",
				"Restricted (GM & Actor owner)",
				"Ograniczone (MG i właściciel Aktora)",
			),
		},
		{
			value: TEST_RESULT_VISIBILITY.PUBLIC,
			label: localize(
				"WFRP1ED.TestResult.Visibility.Public",
				"Public (full)",
				"Publiczne (pełne)",
			),
		},
	];
}

/**
 * Shared label for the visibility selector.
 *
 * @returns {string}
 */
export function testResultVisibilityLabel() {
	return localize(
		"WFRP1ED.TestResult.Visibility.Label",
		"Result details",
		"Szczegóły wyniku",
	);
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);

	if (localized !== key) {
		return localized;
	}

	return game.i18n.lang === "pl"
		? polishFallback
		: englishFallback;
}
