import {
	DETAILED_CRITICAL_OUTCOME,
	detailedCriticalEffectOutcome,
	isCoreDetailedEffectProvider,
} from "./CoreDetailedCriticalTables.mjs";
import {
	CRITICAL_TABLE_ROLE,
	CriticalTableRegistry,
} from "./CriticalTableRegistry.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CHART_RESULT_FLAG_KEY = "detailedCriticalChart";
const EFFECT_RESULT_FLAG_KEY = "detailedCriticalEffect";

const HIT_LOCATION_EFFECTS = Object.freeze({
	head: Object.freeze({
		location: "head",
		role: CRITICAL_TABLE_ROLE.DETAILED_HEAD,
	}),
	rightArm: Object.freeze({
		location: "arm",
		role: CRITICAL_TABLE_ROLE.DETAILED_ARM,
	}),
	leftArm: Object.freeze({
		location: "arm",
		role: CRITICAL_TABLE_ROLE.DETAILED_ARM,
	}),
	body: Object.freeze({
		location: "body",
		role: CRITICAL_TABLE_ROLE.DETAILED_BODY,
	}),
	rightLeg: Object.freeze({
		location: "leg",
		role: CRITICAL_TABLE_ROLE.DETAILED_LEG,
	}),
	leftLeg: Object.freeze({
		location: "leg",
		role: CRITICAL_TABLE_ROLE.DETAILED_LEG,
	}),
});

const STRUCTURED_OUTCOMES = new Set(
	Object.values(DETAILED_CRITICAL_OUTCOME),
);

/** Resolve one WFRP 1e detailed Critical Hit. */
export class DetailedCriticalResolver {
	static VERSION = 1;

	static variantForCriticalValue(value) {
		const criticalValue = positiveInteger(value, "Critical value");
		return criticalValue >= 6 ? "6+" : String(criticalValue);
	}

	static effectLocationForHitLocation(hitLocation) {
		return hitLocationDefinition(hitLocation).location;
	}

	static effectRoleForHitLocation(hitLocation) {
		return hitLocationDefinition(hitLocation).role;
	}

	/**
	 * @param {number} criticalValue
	 * @param {string} hitLocation Stable DamagePacket hit-location id.
	 * @param {Object} options
	 * @param {Roll|null} [options.roll]
	 * @returns {Promise<Object>}
	 */
	static async resolve(
		criticalValue,
		hitLocation,
		{ roll = null } = {},
	) {
		const normalizedValue = positiveInteger(
			criticalValue,
			"Critical value",
		);
		const hit = hitLocationDefinition(hitLocation);
		const variant = this.variantForCriticalValue(normalizedValue);
		const chartResolution = await CriticalTableRegistry.resolve(
			CRITICAL_TABLE_ROLE.DETAILED_CHART,
			{ variant },
		);
		const chartTable = chartResolution.table;
		const evaluatedRoll = roll ?? await new Roll(
			String(chartTable.formula || "1d100"),
		).evaluate({ allowInteractive: false });
		const total = integerRollTotal(evaluatedRoll);
		const chartResults = [...chartTable.getResultsForRoll(total)];

		if (chartResults.length !== 1) {
			throw new Error(
				`Detailed Critical Hit Chart '${chartTable.name}' must return exactly one result for roll ${total}; received ${chartResults.length}.`,
			);
		}

		const chartResult = chartResults[0];
		const chartData = structuredChartResult(chartResult);
		const effectNumber = chartData.effectNumber;
		const effectResolution = await CriticalTableRegistry.resolve(hit.role);
		const effectTable = effectResolution.table;
		const effectResults = [...effectTable.getResultsForRoll(effectNumber)];

		if (effectResults.length !== 1) {
			throw new Error(
				`Detailed critical effect table '${effectTable.name}' must return exactly one result for effect ${effectNumber}; received ${effectResults.length}.`,
			);
		}

		const effectResult = effectResults[0];
		const effectData = structuredEffectResult(
			effectResult,
			hit.location,
			effectNumber,
			effectResolution.providerId,
		);

		return foundry.utils.deepFreeze({
			version: DetailedCriticalResolver.VERSION,
			role: CRITICAL_TABLE_ROLE.DETAILED_CHART,
			criticalValue: normalizedValue,
			variant,
			hitLocation: String(hitLocation),
			effectLocation: hit.location,
			roll: {
				formula: String(
					evaluatedRoll.formula ?? chartTable.formula ?? "1d100",
				),
				total,
			},
			chart: {
				source: chartResolution.source,
				providerId: chartResolution.providerId,
				tableUuid: chartResolution.tableUuid,
				tableName: String(chartTable.name ?? ""),
				resultId: String(chartResult.id ?? ""),
			},
			effectNumber,
			flee: chartData.flee,
			effect: {
				role: hit.role,
				source: effectResolution.source,
				providerId: effectResolution.providerId,
				tableUuid: effectResolution.tableUuid,
				tableName: String(effectTable.name ?? ""),
				resultId: String(effectResult.id ?? ""),
				text: String(effectResult.text ?? "").trim(),
				outcome: effectData.outcome,
			},
			outcome: effectData.outcome,
			resolvedBy: game.user?.id ?? "",
			resolvedAt: Date.now(),
		});
	}
}

function structuredChartResult(result) {
	const value = result.getFlag?.(FLAG_SCOPE, CHART_RESULT_FLAG_KEY);

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Detailed Critical Hit Chart result '${result.id ?? ""}' has no structured WFRP effect-number flag. Custom detailed chart tables must store flags.${FLAG_SCOPE}.${CHART_RESULT_FLAG_KEY}.effectNumber and .flee.`,
		);
	}

	const effectNumber = Number(value.effectNumber);
	if (!Number.isInteger(effectNumber) || effectNumber < 1 || effectNumber > 16) {
		throw new Error(
			`Detailed Critical Hit Chart result '${result.id ?? ""}' has invalid effect number '${String(value.effectNumber)}'.`,
		);
	}

	return {
		effectNumber,
		flee: value.flee === true,
	};
}

function structuredEffectResult(
	result,
	expectedLocation,
	expectedEffectNumber,
	providerId,
) {
	const value = result.getFlag?.(FLAG_SCOPE, EFFECT_RESULT_FLAG_KEY);
	let outcome = null;

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const flaggedLocation = String(value.location ?? "").trim();
		const flaggedNumber = Number(value.effectNumber);
		const flaggedOutcome = String(value.outcome ?? "").trim();

		if (
			flaggedLocation &&
			flaggedLocation !== expectedLocation
		) {
			throw new Error(
				`Detailed critical effect result '${result.id ?? ""}' declares location '${flaggedLocation}', expected '${expectedLocation}'.`,
			);
		}

		if (
			Number.isInteger(flaggedNumber) &&
			flaggedNumber !== expectedEffectNumber
		) {
			throw new Error(
				`Detailed critical effect result '${result.id ?? ""}' declares effect ${flaggedNumber}, expected ${expectedEffectNumber}.`,
			);
		}

		outcome = STRUCTURED_OUTCOMES.has(flaggedOutcome)
			? flaggedOutcome
			: null;
	}

	/*
	 * A system-managed Core effect can recover the fatal outcome from the
	 * audited source even if a stale Core table somehow lacks its result flag.
	 * Custom providers never receive outcome inference from display text.
	 */
	if (!outcome && isCoreDetailedEffectProvider(providerId)) {
		outcome = detailedCriticalEffectOutcome(
			expectedLocation,
			expectedEffectNumber,
		);
	}

	return { outcome };
}

function hitLocationDefinition(value) {
	const hitLocation = String(value ?? "").trim();
	const definition = HIT_LOCATION_EFFECTS[hitLocation];

	if (!definition) {
		throw new Error(
			`Detailed critical resolution requires a humanoid hit location: head, rightArm, leftArm, body, rightLeg, or leftLeg. Received '${hitLocation || "none"}'.`,
		);
	}

	return definition;
}

function positiveInteger(value, label) {
	const number = Number(value);

	if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}

	return number;
}

function integerRollTotal(roll) {
	const total = Number(roll?.total);

	if (!Number.isFinite(total) || !Number.isInteger(total)) {
		throw new Error("Detailed critical roll must resolve to an integer total.");
	}

	return total;
}
