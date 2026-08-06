export class TestResult {
	/**
	 * Result of one generic WFRP 1e test.
	 *
	 * Combat-specific information such as hit location and damage does not
	 * belong to a generic test result. It must be added by the combat subsystem
	 * after the attack procedure has been verified and implemented.
	 *
	 * @param {Object} data
	 * @param {Actor} data.actor
	 * @param {Test} data.test
	 * @param {number} data.target
	 * @param {number} data.roll
	 * @param {TestContext} data.context
	 */
	constructor({
		actor,
		test,
		target,
		roll,
		context,
	} = {}) {
		if (!actor) {
			throw new Error("TestResult requires an Actor.");
		}

		if (!test) {
			throw new Error("TestResult requires a Test definition.");
		}

		this.actor = actor;
		this.test = test;
		this.target = this._finiteNumber(target, "target");
		this.roll = this._d100Result(roll);
		this.context = context ?? null;
	}

	/**
	 * Calculate the signed amount by which a test succeeded or failed.
	 *
	 * Positive:
	 * The roll was below the target by this amount.
	 *
	 * Zero:
	 * The roll exactly matched the target and succeeded.
	 *
	 * Negative:
	 * The roll exceeded the target by this amount.
	 *
	 * @param {number} target
	 * @param {number} roll
	 * @returns {number}
	 */
	static calculateMargin(target, roll) {
		const numericTarget = Number(target);
		const numericRoll = Number(roll);

		if (!Number.isFinite(numericTarget)) {
			throw new Error(
				`Test target must be a finite number: ${String(target)}`,
			);
		}

		if (!Number.isInteger(numericRoll)) {
			throw new Error(
				`Test roll must be an integer: ${String(roll)}`,
			);
		}

		return numericTarget - numericRoll;
	}

	/**
	 * A basic WFRP 1e test succeeds when the D100 roll is less than or equal
	 * to the final target number.
	 *
	 * @returns {boolean}
	 */
	get success() {
		return this.roll <= this.target;
	}

	/**
	 * @returns {boolean}
	 */
	get failure() {
		return !this.success;
	}

	/**
	 * Signed numerical amount by which the test succeeded or failed.
	 *
	 * @returns {number}
	 */
	get margin() {
		return TestResult.calculateMargin(this.target, this.roll);
	}

	/**
	 * Absolute numerical distance between the target and roll.
	 *
	 * @returns {number}
	 */
	get degree() {
		return Math.abs(this.margin);
	}

	/**
	 * Render the generic test-result chat card.
	 *
	 * @returns {Promise<string>}
	 */
	async render() {
		return renderTemplate(
			"systems/wfrp1ed/templates/chat/test-result.hbs",
			{
				result: this,
			},
		);
	}

	/**
	 * Publish the result to Foundry chat.
	 *
	 * @returns {Promise<ChatMessage>}
	 */
	async toChat() {
		const content = await this.render();

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({
				actor: this.actor,
			}),
			content,
		});
	}

	/**
	 * Convert a value into a finite number.
	 *
	 * @param {*} value
	 * @param {string} label
	 * @returns {number}
	 * @protected
	 */
	_finiteNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`TestResult '${label}' must be a finite number: ` +
					String(value),
			);
		}

		return number;
	}

	/**
	 * Validate a D100 result.
	 *
	 * Foundry's 1d100 roll produces values from 1 through 100.
	 *
	 * @param {*} value
	 * @returns {number}
	 * @protected
	 */
	_d100Result(value) {
		const roll = Number(value);

		if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
			throw new Error(
				`TestResult roll must be an integer from 1 to 100: ` +
					String(value),
			);
		}

		return roll;
	}
}