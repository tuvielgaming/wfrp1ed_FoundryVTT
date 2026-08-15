import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";

const CHARACTERISTIC_IDS = Object.freeze([
	"m", "ws", "bs", "s", "t", "i", "dex", "ld", "int", "cl", "wp", "fel",
]);
const CHARACTERISTIC_ALIASES = Object.freeze({ sp: "m" });

let previousGetCharacteristicValue = null;

/**
 * WFRP 1e fractional-characteristic boundary.
 *
 * Effect composition is allowed to retain exact fractional intermediate values
 * (for example I 35 × 0.5 = 17.5), but a characteristic used for play is a
 * whole-number value. The default policy discards the fractional remainder.
 * A future rule which explicitly defines different rounding must perform that
 * rule-specific rounding before reaching this generic characteristic boundary.
 *
 * This deliberately defines no universal minimum: individual WFRP procedures
 * own their own lower bounds.
 */
Hooks.once("init", () => {
	if (previousGetCharacteristicValue) return;
	previousGetCharacteristicValue = Wfrp1edActor.prototype.getCharacteristicValue;

	Wfrp1edActor.prototype.getCharacteristicValue = function getWholeCharacteristicValue(id) {
		const exact = previousGetCharacteristicValue.call(this, id);
		return characteristicPlayValue(exact);
	};
});

/*
 * CriticalWoundCharacteristicEffects decorates the Classic sheet from its exact
 * effect-composition snapshot. Run after that decorator and normalize the visible
 * current profile to the same whole-number value consumed by tests and combat.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (
		!(actor instanceof foundry.documents.Actor) ||
		actor.type !== "character" ||
		!element?.querySelector?.(".wfrp1ed-classic-sheet")
	) return;

	for (const id of CHARACTERISTIC_IDS) {
		const storageId = id === "m" && !element.querySelector('[data-characteristic="m"]')
			? "sp"
			: id;
		const cell = element.querySelector(
			`.characteristics-row--current [data-characteristic="${storageId}"]`,
		);
		if (!cell) continue;

		const profile = cell.querySelector(".characteristic-current-profile");
		if (!profile) continue;

		const value = actor.getCharacteristicValue(
			CHARACTERISTIC_ALIASES[storageId] ?? id,
		);
		if (!Number.isFinite(Number(value))) continue;
		profile.textContent = String(value);
	}
});

export function characteristicPlayValue(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		throw new Error(`WFRP characteristic value must be finite; received '${String(value)}'.`);
	}
	return Math.floor(numeric);
}
