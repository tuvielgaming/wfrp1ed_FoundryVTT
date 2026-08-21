import { SUDDEN_DEATH_OUTCOME } from "./CoreSuddenDeathTables.mjs";
import {
	CRITICAL_TABLE_ROLE,
	CriticalTableRegistry,
} from "./CriticalTableRegistry.mjs";

const FLAG_SCOPE = "wfrp1ed";
const OUTCOME_FLAG_KEY = "criticalOutcome";
const STRUCTURED_OUTCOMES = new Set(
	Object.values(SUDDEN_DEATH_OUTCOME),
);

/** Resolve one WFRP Sudden Death / Nagła Śmierć critical. */
export class SuddenDeathResolver {
	static VERSION = 1;

	static variantForCriticalValue(value) {
		const criticalValue = positiveInteger(value, "Critical value");
		return criticalValue >= 6 ? "6+" : String(criticalValue);
	}

	static async resolve(criticalValue, { roll = null } = {}) {
		const normalizedValue = positiveInteger(
			criticalValue,
			"Critical value",
		);
		const variant = this.variantForCriticalValue(normalizedValue);
		const tableResolution = await CriticalTableRegistry.resolve(
			CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
			{ variant },
		);
		const table = tableResolution.table;
		const evaluatedRoll = roll ?? await new Roll(
			String(table.formula || "1d100"),
		).evaluate();
		const total = integerRollTotal(evaluatedRoll);
		const tableResults = [...table.getResultsForRoll(total)];

		if (tableResults.length === 0) {
			throw new Error(
				`Sudden Death table '${table.name}' has no result for roll ${total}.`,
			);
		}

		const results = tableResults.map((result) => {
			const rawOutcome = String(
				result.getFlag?.(FLAG_SCOPE, OUTCOME_FLAG_KEY) ?? "",
			).trim();
			const outcome = STRUCTURED_OUTCOMES.has(rawOutcome)
				? rawOutcome
				: null;

			return {
				id: String(result.id ?? ""),
				text: tableResultPresentation(result),
				outcome,
			};
		});
		const structured = [...new Set(
			results.map((result) => result.outcome).filter(Boolean),
		)];

		return foundry.utils.deepFreeze({
			version: SuddenDeathResolver.VERSION,
			role: CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
			criticalValue: normalizedValue,
			variant,
			source: tableResolution.source,
			providerId: tableResolution.providerId,
			tableUuid: tableResolution.tableUuid,
			tableName: String(table.name ?? ""),
			roll: {
				formula: String(evaluatedRoll.formula ?? table.formula ?? "1d100"),
				total,
			},
			results,
			outcome: structured.length === 1 ? structured[0] : null,
			resolvedBy: game.user?.id ?? "",
			resolvedAt: Date.now(),
		});
	}
}

/**
 * Foundry v14 deprecated TableResult#text. Structured Core outcomes never rely
 * on presentation text, but custom/override tables still need a readable
 * fallback. Prefer the current name API and then description without touching
 * the deprecated compatibility getter.
 */
function tableResultPresentation(result) {
	const name = String(result?.name ?? "").trim();
	if (name) return name;
	return String(result?.description ?? "").trim();
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
		throw new Error("Sudden Death roll must resolve to an integer total.");
	}

	return total;
}
