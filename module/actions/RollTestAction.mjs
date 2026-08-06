import { TestContext } from "../tests/TestContext.mjs";
import { TestDialog } from "../tests/TestDialog.mjs";

export class RollTestAction {
	/**
	 * Configure, execute, and publish one test.
	 *
	 * The same TestContext instance is used throughout the complete lifecycle:
	 *
	 * TestContext
	 * → TestDialog
	 * → Test.roll()
	 * → TestResult.toChat()
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
		const configuredContext = await TestDialog.configure(context);

		if (!configuredContext) {
			return null;
		}

		const result = await test.roll(configuredContext);

		await result.toChat();

		return result;
	}
}