const HIT_LOCATION_RANGES = Object.freeze([
	{
		minimum: 1,
		maximum: 15,
		location: "head",
	},
	{
		minimum: 16,
		maximum: 35,
		location: "rightArm",
	},
	{
		minimum: 36,
		maximum: 55,
		location: "leftArm",
	},
	{
		minimum: 56,
		maximum: 80,
		location: "body",
	},
	{
		minimum: 81,
		maximum: 90,
		location: "rightLeg",
	},
	{
		minimum: 91,
		maximum: 100,
		location: "leftLeg",
	},
]);

export class HitLocation {
	/**
	 * Resolve a humanoid hit location from an already reversed D100 result.
	 *
	 * In D100 notation, `00` represents 100. Therefore both 0 and 100 are
	 * accepted as the final 91-00 range and resolve to the left leg.
	 *
	 * This table applies to humanoid creatures on foot. Mounted or
	 * non-humanoid targets require a different location table and must be
	 * handled by the combat subsystem rather than silently using this one.
	 *
	 * @param {number} reversedRoll
	 * @returns {string}
	 */
	static fromRoll(reversedRoll) {
		const normalizedRoll = this._normalizeRoll(reversedRoll);

		const range = HIT_LOCATION_RANGES.find(
			(entry) =>
				normalizedRoll >= entry.minimum &&
				normalizedRoll <= entry.maximum,
		);

		if (!range) {
			throw new Error(
				`No humanoid hit location exists for reversed roll ` +
					`'${normalizedRoll}'.`,
			);
		}

		return range.location;
	}

	/**
	 * Normalize and validate an already reversed D100 result.
	 *
	 * @param {*} reversedRoll
	 * @returns {number}
	 * @protected
	 */
	static _normalizeRoll(reversedRoll) {
		const numericRoll = Number(reversedRoll);

		if (!Number.isInteger(numericRoll)) {
			throw new Error(
				`Hit-location roll must be an integer: ${String(reversedRoll)}`,
			);
		}

		if (numericRoll === 0) {
			return 100;
		}

		if (numericRoll < 1 || numericRoll > 100) {
			throw new Error(
				`Hit-location roll must be between 1 and 100: ` +
					String(reversedRoll),
			);
		}

		return numericRoll;
	}
}