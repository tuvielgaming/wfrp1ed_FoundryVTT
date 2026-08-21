import { InventoryEncumbrance } from "../inventory/InventoryEncumbrance.mjs";

const RATE = Object.freeze({
	CAUTIOUS: "cautious",
	STANDARD: "standard",
	RUNNING: "running",
});

/*
 * Polish Core Rulebook, printed p.73, "Poruszanie się w kilometrach na godzinę".
 * Keep these authored lookup values instead of recalculating the localized
 * conversion: the published table contains its own one-decimal rounding.
 * Index 0 is the explicit immobile fallback used when effective Movement is 0.
 */
const POLISH_KMH = Object.freeze({
	[RATE.CAUTIOUS]: Object.freeze([
		0,
		0.8, 1.6, 2.0, 2.7, 3.5,
		4.3, 4.7, 5.6, 6.4, 7.2,
		8.0, 8.4, 9.2, 10.0, 10.8,
		11.6, 12.4, 12.8, 13.6, 14.4,
	]),
	[RATE.STANDARD]: Object.freeze([
		0,
		1.6, 2.7, 4.3, 5.5, 7.0,
		8.2, 9.8, 11.6, 12.8, 14.4,
		15.6, 17.2, 18.8, 20.0, 21.6,
		22.8, 24.4, 25.6, 27.2, 28.8,
	]),
	[RATE.RUNNING]: Object.freeze([
		0,
		5.5, 11.3, 16.8, 22.2, 28.0,
		33.5, 39.0, 46.0, 51.6, 57.2,
		63.2, 68.8, 74.4, 80.0, 86.0,
		91.6, 97.2, 103.2, 108.8, 114.4,
	]),
});

/**
 * Canonical WFRP 1e movement-rate derivation for the Classic character sheet.
 *
 * English Core p.73 gives the rate multipliers:
 * - Cautious:  2 × M yards/metres per 10-second round; 12 × M per minute;
 * - Standard:  4 × M per round; 24 × M per minute;
 * - Running:  16 × M per round; 96 × M per minute.
 *
 * The Polish Classic sheet uses metres and kilometres/hour. Its km/h column is
 * therefore taken from the Polish Core published table above.
 */
export class MovementRates {
	static forActor(actor) {
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error("Movement-rate calculation requires an Actor document.");
		}

		const encumbrance = InventoryEncumbrance.evaluate(actor);
		const movement = nonNegativeInteger(encumbrance.effectiveMovement);

		return Object.freeze({
			movement,
			baseMovement: encumbrance.baseMovement,
			movementPenalty: encumbrance.movementPenalty,
			load: encumbrance.load,
			capacity: encumbrance.capacity,
			overloaded: encumbrance.overloaded,
			withinPublishedSpeedTable: movement <= 20,
			rates: Object.freeze({
				[RATE.CAUTIOUS]: rateRecord(movement, RATE.CAUTIOUS, 2, 12),
				[RATE.STANDARD]: rateRecord(movement, RATE.STANDARD, 4, 24),
				[RATE.RUNNING]: rateRecord(movement, RATE.RUNNING, 16, 96),
			}),
		});
	}
}

export const MOVEMENT_RATE = RATE;

function rateRecord(movement, rate, roundMultiplier, minuteMultiplier) {
	return Object.freeze({
		round: movement * roundMultiplier,
		minute: movement * minuteMultiplier,
		kmh: POLISH_KMH[rate]?.[movement] ?? null,
	});
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
