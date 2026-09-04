import { TestResultChat } from "./TestResultChat.mjs";

/*
 * Extend the generic TestResult chat snapshot with stable mechanics metadata
 * needed by Standard-Test-specific presentation/adjudication integrations.
 *
 * The base TestResultChat intentionally remains generic. Standard Test helpers
 * need a stable test id (localized names are not identity) and the raw formula
 * when a target formula input is later adjudicated from chat.
 */
installStandardTestResultMetadata();

function installStandardTestResultMetadata() {
	if (TestResultChat.__wfrpStandardTestMetadataInstalled === true) return;

	Object.defineProperty(TestResultChat, "__wfrpStandardTestMetadataInstalled", {
		value: true,
		configurable: false,
	});

	const originalSnapshot = TestResultChat._snapshot;

	TestResultChat._snapshot = function (result) {
		const state = originalSnapshot.call(this, result);
		return {
			...state,
			version: Math.max(4, Number(state?.version) || 0),
			testId: String(result?.test?.id ?? ""),
			formulaRaw: result?.test?.formula
				? String(result.test.formula)
				: null,
			targetActorUuid: String(result?.context?.target?.uuid ?? ""),
		};
	};
}
