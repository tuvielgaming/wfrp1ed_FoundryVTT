import { TEST_OUTCOME_MODE } from "./Test.mjs";
import { TestResultChat } from "./TestResultChat.mjs";

/*
 * Extend the generic TestResult chat snapshot with stable mechanics metadata
 * needed by Standard-Test-specific presentation/adjudication integrations.
 *
 * The base TestResultChat intentionally remains generic. Standard Test helpers
 * need a stable test id (localized names are not identity), the raw formula
 * when a target formula input is later adjudicated from chat, and the explicit
 * outcome perspective for resistance procedures such as Hypnotism/Interrogate.
 */
installStandardTestResultMetadata();

function installStandardTestResultMetadata() {
	if (TestResultChat.__wfrpStandardTestMetadataInstalled === true) return;

	Object.defineProperty(TestResultChat, "__wfrpStandardTestMetadataInstalled", {
		value: true,
		configurable: false,
	});

	const originalSnapshot = TestResultChat._snapshot;
	const originalTemplateContext = TestResultChat._templateContext;

	TestResultChat._snapshot = function (result) {
		const state = originalSnapshot.call(this, result);
		return {
			...state,
			version: Math.max(5, Number(state?.version) || 0),
			testId: String(result?.test?.id ?? ""),
			formulaRaw: result?.test?.formula
				? String(result.test.formula)
				: null,
			targetActorUuid: String(result?.context?.target?.uuid ?? ""),
			outcomeMode: String(
				result?.test?.outcomeMode ?? TEST_OUTCOME_MODE.ROLL_UNDER,
			),
		};
	};

	TestResultChat._templateContext = function (state) {
		const context = originalTemplateContext.call(this, state);
		if (state?.outcomeMode !== TEST_OUTCOME_MODE.TARGET_RESISTANCE) {
			return context;
		}

		/*
		 * Core defines these procedures as a roll-under Will Power resistance made
		 * by the victim. The Standard Test card is initiated and named from the
		 * acting character's perspective, so procedure success is the inverse of
		 * the victim's resistance result:
		 *
		 *   d100 <= target WP -> victim resists -> procedure FAILURE
		 *   d100 >  target WP -> victim fails -> procedure SUCCESS
		 *
		 * Keeping this transformation in the stored presentation contract also
		 * means post-roll manual target-value adjudication recalculates the same
		 * physical d100 with the correct procedure perspective.
		 */
		const roll = Number(context?.result?.roll);
		const target = Number(context?.result?.target);
		if (!Number.isFinite(roll) || !Number.isFinite(target)) return context;

		const success = roll > target;
		context.result.success = success;
		context.result.failure = !success;
		context.result.margin = roll - target;
		return context;
	};
}
