import { coreCriticalConsequence } from "./CoreCriticalConsequences.mjs";
import { isCoreDetailedEffectProvider } from "./CoreDetailedCriticalTables.mjs";

/**
 * Normalize the declarative automation payload stored on a Critical Wound Item.
 *
 * This is the public contract for user-authored Critical Wounds. The runtime must
 * never need to know that a wound is "Leg #4" (or any other named Core result).
 * It only understands consequence primitives declared on the Item itself.
 *
 * Core Rulebook wounds use the same contract. `coreCriticalConsequence()` is a
 * compatibility/seed source for old wounds created before the consequence data
 * became part of CriticalWoundData.
 */
export function criticalConsequenceForWound(wound) {
	if (wound?.type !== "criticalWound") return null;

	const authored = normalizeCriticalConsequence(wound.system?.consequence);
	if (authored?.enabled) return authored;

	/* Transitional compatibility for already-existing Core wounds. New Core
	 * Compendium Items persist this data directly in `system.consequence`. */
	if (!isCoreDetailedEffectProvider(wound.system?.resolution?.providerId)) return null;
	const fallback = coreCriticalConsequence(
		genericLocation(wound.system?.hitLocation),
		positiveInteger(wound.system?.resolution?.effectNumber),
	);
	return fallback ? normalizeCriticalConsequence({ enabled: true, ...fallback }) : null;
}

export function normalizeCriticalConsequence(source) {
	const raw = source?.toObject?.() ?? source;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

	const characteristics = Array.isArray(raw.characteristics)
		? raw.characteristics
			.map(normalizeCharacteristicChange)
			.filter(Boolean)
		: [];
	const duration = normalizeDuration(raw.duration, raw.until);
	const periodicWounds = normalizePeriodicWounds(raw.periodicWounds);
	const dropHeld = normalizeDropHeld(raw.dropHeld);
	const enabled = raw.enabled === true || Boolean(
		characteristics.length ||
		duration.formula ||
		duration.until ||
		periodicWounds.formula ||
		dropHeld
	);

	return Object.freeze({
		enabled,
		characteristics: Object.freeze(characteristics),
		duration: Object.freeze(duration),
		periodicWounds: Object.freeze(periodicWounds),
		dropHeld,
	});
}

/** Raw system-data shape suitable for Item creation/Compendium source. */
export function consequenceSystemSource(source) {
	const normalized = normalizeCriticalConsequence(source) ?? normalizeCriticalConsequence({});
	return {
		enabled: normalized.enabled,
		characteristics: normalized.characteristics.map((entry) => ({ ...entry })),
		duration: { ...normalized.duration },
		periodicWounds: { ...normalized.periodicWounds },
		dropHeld: normalized.dropHeld,
	};
}

export function consequenceHasAutomation(source) {
	return normalizeCriticalConsequence(source)?.enabled === true;
}

function normalizeCharacteristicChange(source) {
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	const characteristicId = canonicalCharacteristicId(source.characteristicId);
	const operation = normalizeOperation(source.operation);
	const value = Number(source.value);
	if (!characteristicId || !operation || !Number.isFinite(value)) return null;
	return Object.freeze({ characteristicId, operation, value });
}

function normalizeDuration(source, legacyUntil = "") {
	const raw = source?.toObject?.() ?? source ?? {};
	return {
		formula: cleanFormula(raw.formula),
		units: String(raw.units ?? "").trim() === "rounds" ? "rounds" : "",
		until: normalizeUntil(raw.until || legacyUntil),
	};
}

function normalizePeriodicWounds(source) {
	const raw = source?.toObject?.() ?? source ?? {};
	return {
		formula: cleanFormula(raw.formula),
		until: normalizeUntil(raw.until),
	};
}

function normalizeDropHeld(value) {
	const normalized = String(value ?? "").trim();
	return ["injured-hand", "all"].includes(normalized) ? normalized : "";
}

function normalizeUntil(value) {
	return String(value ?? "").trim() === "medical-attention"
		? "medical-attention"
		: "";
}

function normalizeOperation(value) {
	const normalized = String(value ?? "").trim();
	return ["add", "subtract", "multiply", "override"].includes(normalized)
		? normalized
		: "";
}

function canonicalCharacteristicId(value) {
	const normalized = String(value ?? "").trim().toLowerCase();
	if (normalized === "sp") return "m";
	return [
		"m", "ws", "bs", "s", "t", "w", "i", "a",
		"dex", "ld", "int", "cl", "wp", "fel",
	].includes(normalized) ? normalized : "";
}

function cleanFormula(value) {
	return String(value ?? "").trim();
}

function genericLocation(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "leftArm":
		case "rightArm":
		case "arm": return "arm";
		case "leftLeg":
		case "rightLeg":
		case "leg": return "leg";
		case "head": return "head";
		case "body": return "body";
		default: return "";
	}
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}
