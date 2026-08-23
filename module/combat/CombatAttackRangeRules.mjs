export const COMBAT_RANGE_BAND = Object.freeze({
	SHORT: "short",
	LONG: "long",
	EXTREME: "extreme",
	OUT_OF_RANGE: "outOfRange",
});

/**
 * Audited WFRP 1e missile-range calculations.
 *
 * English Core pp. 126, 128:
 * - Short: no range modifier;
 * - Long: -10 BS and -1 damage;
 * - Extreme: -20 BS and -2 damage.
 *
 * Polish Core pp. 126, 128 uses Krótki / Długi / Maksymalny for the same
 * mechanical bands. A printed `-` means that a band does not exist for that
 * weapon. Resolution skips an unavailable band rather than converting it to
 * zero distance. For example Short 32 / Long - / Maximum 100 resolves 0-32 as
 * Short and 33-100 directly as Maximum/Extreme.
 *
 * Whether these effects are applied automatically belongs to one attack
 * transaction, not to the Weapon Item. This service only derives consequences
 * from an authored range profile and one supplied distance.
 */
export class CombatAttackRangeRules {
	static weaponProfile(weapon) {
		if (weapon?.type !== "weapon") {
			throw new Error("Missile range rules require a Weapon Item.");
		}

		const range = weapon.system?.range ?? {};
		return this.profile({
			short: range.short,
			long: range.long,
			extreme: range.max,
		});
	}

	static profile({ short = 0, long = 0, extreme = 0 } = {}) {
		const normalized = {
			short: optionalRangeNumber(short, "short range"),
			long: optionalRangeNumber(long, "long range"),
			extreme: optionalRangeNumber(extreme, "extreme range"),
		};

		const authored = [
			["Short", normalized.short],
			["Long", normalized.long],
			["Extreme", normalized.extreme],
		].filter(([, value]) => value !== null);
		for (let index = 1; index < authored.length; index += 1) {
			if (authored[index][1] < authored[index - 1][1]) {
				throw new Error(
					"Available weapon range thresholds must increase from Short through Long to Extreme.",
				);
			}
		}

		return Object.freeze(normalized);
	}

	static resolve(profile, distance = 0) {
		const ranges = this.profile(profile);
		const measured = nonNegativeNumber(distance, "attack distance");
		let band;

		if (ranges.short !== null && measured <= ranges.short) {
			band = COMBAT_RANGE_BAND.SHORT;
		} else if (ranges.long !== null && measured <= ranges.long) {
			band = COMBAT_RANGE_BAND.LONG;
		} else if (ranges.extreme !== null && measured <= ranges.extreme) {
			band = COMBAT_RANGE_BAND.EXTREME;
		} else {
			band = COMBAT_RANGE_BAND.OUT_OF_RANGE;
		}

		const effects = effectsForBand(band);

		return Object.freeze({
			profile: ranges,
			distance: measured,
			band,
			legal: band !== COMBAT_RANGE_BAND.OUT_OF_RANGE,
			bsModifier: effects.bsModifier,
			damageModifier: effects.damageModifier,
		});
	}

	static label(band) {
		switch (band) {
			case COMBAT_RANGE_BAND.SHORT:
				return localize("Short", "Krótki");
			case COMBAT_RANGE_BAND.LONG:
				return localize("Long", "Długi");
			case COMBAT_RANGE_BAND.EXTREME:
				return localize("Extreme", "Maksymalny");
			case COMBAT_RANGE_BAND.OUT_OF_RANGE:
				return localize("Out of range", "Poza zasięgiem");
			default:
				return "—";
		}
	}
}

function effectsForBand(band) {
	switch (band) {
		case COMBAT_RANGE_BAND.LONG:
			return { bsModifier: -10, damageModifier: -1 };
		case COMBAT_RANGE_BAND.EXTREME:
			return { bsModifier: -20, damageModifier: -2 };
		case COMBAT_RANGE_BAND.SHORT:
		case COMBAT_RANGE_BAND.OUT_OF_RANGE:
		default:
			return { bsModifier: 0, damageModifier: 0 };
	}
}

function optionalRangeNumber(value, label) {
	const text = String(value ?? "").trim();
	if (text === "-" || text === "—") return null;
	return nonNegativeNumber(value, label);
}

function nonNegativeNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(`${label} must be a finite non-negative number or '-'.`);
	}
	return number;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
