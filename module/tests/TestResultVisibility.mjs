export const TEST_RESULT_VISIBILITY = Object.freeze({
	GM_ONLY: "gm-only",
	PUBLIC: "public",
});

/**
 * Normalize one result-detail visibility value.
 *
 * This setting controls only whether non-GM clients may inspect the detailed
 * target calculation on a completed test card. It does not alter Foundry's
 * ChatMessage roll mode or document visibility.
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
				"GM only",
				"Tylko MG",
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
