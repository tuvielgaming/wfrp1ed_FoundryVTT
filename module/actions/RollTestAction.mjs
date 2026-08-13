import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { TestContext } from "../tests/TestContext.mjs";
import { TestDialog } from "../tests/TestDialog.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

export class RollTestAction {
	/**
	 * Configure, execute, and publish one test.
	 *
	 * If `options.modifier` is explicitly supplied, the caller has already
	 * completed the generic modifier step as part of a composed UI such as the
	 * Standard Test dialog. Otherwise the shared TestDialog is opened normally.
	 *
	 * @param {Actor} actor
	 * @param {Test} test
	 * @param {Object} options
	 * @returns {Promise<TestResult|null>}
	 */
	static async execute(actor, test, options = {}) {
		if (!actor) {
			throw new Error("RollTestAction requires an Actor.");
		}

		if (!test) {
			throw new Error("RollTestAction requires a Test definition.");
		}

		const context = new TestContext(actor, test, options);
		const hasConfiguredModifier =
			Object.prototype.hasOwnProperty.call(
				options,
				"modifier",
			);

		if (hasConfiguredModifier) {
			TestDialog.applyModifier(
				context,
				options.modifier,
			);

			return this.executeConfigured(context);
		}

		const configuredContext = await TestDialog.configure(context);

		if (!configuredContext) {
			return null;
		}

		return this.executeConfigured(configuredContext);
	}

	/**
	 * Execute and publish an already-configured TestContext.
	 *
	 * This is the reusable execution half of the test pipeline. UI composers
	 * can prepare a context independently without duplicating roll logic.
	 * TestResultChat owns only the persistent interactive chat presentation.
	 *
	 * The published ChatMessage is retained on `result.chatMessage`. Generic
	 * callers may ignore it; higher-level transactions such as combat can attach
	 * their own separate context flag to the exact same physical roll/card
	 * without searching the ChatLog or publishing a duplicate result.
	 *
	 * Selected declarative Active Effects are normalized into ordinary
	 * TestModifier entries here, immediately before the test target is resolved.
	 * This keeps one target/modifier pipeline and makes the existing result
	 * breakdown automatically audit their source and contribution.
	 *
	 * @param {TestContext} context
	 * @returns {Promise<TestResult>}
	 */
	static async executeConfigured(context) {
		if (!context?.actor) {
			throw new Error(
				"RollTestAction requires a configured context with an Actor.",
			);
		}

		if (!context?.test) {
			throw new Error(
				"RollTestAction requires a configured context with a Test.",
			);
		}

		RuleEffectRollSelection.applyToTestContext(context);

		const result = await context.test.roll(context);

		result.chatMessage = await TestResultChat.publish(result);

		return result;
	}
}
