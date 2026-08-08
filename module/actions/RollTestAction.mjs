import { TestContext } from "../tests/TestContext.mjs";
import { TestDialog } from "../tests/TestDialog.mjs";

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
	 * can prepare a context independently without duplicating roll or chat logic.
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

		const result = await context.test.roll(context);

		await result.toChat();

		return result;
	}
}
