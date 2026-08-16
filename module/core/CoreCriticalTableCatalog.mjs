import {
	CORE_DETAILED_CRITICAL_TABLE_VERSION,
	DETAILED_CRITICAL_OUTCOME,
	detailedCriticalEffectOutcome,
	detailedCriticalEffectText,
	detailedCriticalLocationLabel,
} from "../criticals/CoreDetailedCriticalTables.mjs";
import {
	CORE_SUDDEN_DEATH_TABLE_VERSION,
	SUDDEN_DEATH_OUTCOME,
} from "../criticals/CoreSuddenDeathTables.mjs";
import {
	CRITICAL_TABLE_ROLE,
	CRITICAL_TABLE_VARIANT,
	CRITICAL_VALUE_VARIANTS,
} from "../criticals/CriticalTableRegistry.mjs";

const DETAILED_CHART_IDS = Object.freeze({
	"1": "wfrpCritDCH00001",
	"2": "wfrpCritDCH00002",
	"3": "wfrpCritDCH00003",
	"4": "wfrpCritDCH00004",
	"5": "wfrpCritDCH00005",
	"6+": "wfrpCritDCH00006",
});
const DETAILED_EFFECT_TABLES = Object.freeze({
	arm: Object.freeze({ role: CRITICAL_TABLE_ROLE.DETAILED_ARM, id: "wfrpCritDEA00001" }),
	head: Object.freeze({ role: CRITICAL_TABLE_ROLE.DETAILED_HEAD, id: "wfrpCritDEH00001" }),
	body: Object.freeze({ role: CRITICAL_TABLE_ROLE.DETAILED_BODY, id: "wfrpCritDEB00001" }),
	leg: Object.freeze({ role: CRITICAL_TABLE_ROLE.DETAILED_LEG, id: "wfrpCritDEL00001" }),
});
const SUDDEN_DEATH_IDS = Object.freeze({
	"1": "wfrpCritSD000001",
	"2": "wfrpCritSD000002",
	"3": "wfrpCritSD000003",
	"4": "wfrpCritSD000004",
	"5": "wfrpCritSD000005",
	"6+": "wfrpCritSD000006",
});

/* Shared with the runtime Core tables; kept visibly compact for audit. */
const DETAILED_CHART_BANDS = Object.freeze([
	band(1, 10, [1, 3, 5, 7, star(11), star(14)]),
	band(11, 20, [2, 4, 6, star(9), star(13), 15]),
	band(21, 30, [3, 5, star(8), star(14), 16, 16]),
	band(31, 40, [4, 7, star(10), star(13), 15, 15]),
	band(41, 50, [5, star(9), star(14), 16, 16, 16]),
	band(51, 60, [7, star(12), 15, 15, 15, 15]),
	band(61, 70, [star(9), 16, 16, 16, 16, 16]),
	band(71, 80, [star(11), 15, 15, 15, 15, 15]),
	band(81, 90, [16, 16, 16, 16, 16, 16]),
	band(91, 100, [15, 15, 15, 15, 15, 15]),
]);

const SUDDEN_DEATH_BANDS = Object.freeze([
	band(1, 9, ["no-effect", "no-effect", "no-effect", "no-effect", "no-effect", "killed"]),
	band(10, 20, ["no-effect", "no-effect", "no-effect", "no-effect", "killed", "killed"]),
	band(21, 30, ["no-effect", "no-effect", "no-effect", "killed", "killed", "killed"]),
	band(31, 40, ["no-effect", "no-effect", "killed", "killed", "killed", "killed"]),
	band(41, 50, ["no-effect", "killed", "killed", "killed", "killed", "killed"]),
	band(51, 100, ["killed", "killed", "killed", "killed", "killed", "killed"]),
]);

/** Build all 16 Core critical RollTables for one presentation language. */
export function coreCriticalTableSources(language = "en") {
	const lang = normalizeLanguage(language);
	return Object.freeze([
		...CRITICAL_VALUE_VARIANTS.map((variant) => detailedChart(variant, lang)),
		...Object.entries(DETAILED_EFFECT_TABLES).map(([location, definition]) =>
			detailedEffects(location, definition, lang)),
		...CRITICAL_VALUE_VARIANTS.map((variant) => suddenDeath(variant, lang)),
	]);
}

function detailedChart(variant, language) {
	const index = CRITICAL_VALUE_VARIANTS.indexOf(variant);
	const polish = language === "pl";
	return {
		_id: DETAILED_CHART_IDS[variant],
		name: polish
			? `WFRP1ED Core — Tabela trafień krytycznych +${variant}`
			: `WFRP1ED Core — Critical Hit Chart +${variant}`,
		description: polish
			? "WFRP 1e Core, Walka, str. 122. Rzut K100 wskazuje numer efektu krytycznego dla odpowiedniego obszaru trafienia."
			: "WFRP 1e Core, Combat, p. 122. The d100 result selects a numbered Critical Effect for the appropriate hit location.",
		formula: "1d100",
		replacement: true,
		displayRoll: false,
		ownership: { default: 2 },
		flags: {
			wfrp1ed: {
				coreDetailedCriticalTable: {
					role: CRITICAL_TABLE_ROLE.DETAILED_CHART,
					variant,
					version: CORE_DETAILED_CRITICAL_TABLE_VERSION,
					language,
				},
			},
		},
		results: DETAILED_CHART_BANDS.map((entry) => {
			const selected = entry.values[index];
			const effectNumber = typeof selected === "object" ? selected.number : selected;
			const flee = typeof selected === "object" && selected.flee === true;
			return {
				type: "text",
				text: polish
					? `Efekt ${effectNumber}${flee ? " — ofiara musi uciec z walki, jeżeli jest to możliwe" : ""}`
					: `Effect ${effectNumber}${flee ? " — victim must flee combat if it is possible to do so" : ""}`,
				range: [...entry.range],
				weight: 1,
				drawn: false,
				flags: {
					wfrp1ed: {
						detailedCriticalChart: { effectNumber, flee },
					},
				},
			};
		}),
	};
}

function detailedEffects(location, definition, language) {
	const polish = language === "pl";
	return {
		_id: definition.id,
		name: polish
			? `WFRP1ED Core — Efekty trafień krytycznych — ${detailedCriticalLocationLabel(location, "pl")}`
			: `WFRP1ED Core — Critical Effects — ${detailedCriticalLocationLabel(location, "en")}`,
		description: polish
			? "WFRP 1e Core, Walka, str. 122-124. Wyniki odtwarzają tekst efektów z polskiego podręcznika."
			: "WFRP 1e Core, Combat, pp. 122-124. Results reproduce the Core Rulebook Critical Effects text.",
		formula: "1d16",
		replacement: true,
		displayRoll: false,
		ownership: { default: 2 },
		flags: {
			wfrp1ed: {
				coreDetailedCriticalTable: {
					role: definition.role,
					variant: CRITICAL_TABLE_VARIANT.DEFAULT,
					version: CORE_DETAILED_CRITICAL_TABLE_VERSION,
					language,
				},
			},
		},
		results: Array.from({ length: 16 }, (_unused, index) => {
			const effectNumber = index + 1;
			const outcome = detailedCriticalEffectOutcome(location, effectNumber);
			return {
				type: "text",
				text: detailedCriticalEffectText(location, effectNumber, language),
				range: [effectNumber, effectNumber],
				weight: 1,
				drawn: false,
				flags: {
					wfrp1ed: {
						detailedCriticalEffect: {
							location,
							effectNumber,
							outcome: outcome === DETAILED_CRITICAL_OUTCOME.KILLED
								? DETAILED_CRITICAL_OUTCOME.KILLED
								: null,
						},
					},
				},
			};
		}),
	};
}

function suddenDeath(variant, language) {
	const index = CRITICAL_VALUE_VARIANTS.indexOf(variant);
	const polish = language === "pl";
	return {
		_id: SUDDEN_DEATH_IDS[variant],
		name: polish
			? `WFRP1ED Core — Nagła Śmierć +${variant}`
			: `WFRP1ED Core — Sudden Death +${variant}`,
		description: polish
			? "WFRP 1e Core, Walka, str. 125. Tabela Nagłej Śmierci."
			: "WFRP 1e Core, Combat, pp. 124-125. Sudden Death Critical Hit System.",
		formula: "1d100",
		replacement: true,
		displayRoll: true,
		ownership: { default: 2 },
		flags: {
			wfrp1ed: {
				coreCriticalTable: {
					role: CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
					variant,
					version: CORE_SUDDEN_DEATH_TABLE_VERSION,
					language,
				},
			},
		},
		results: SUDDEN_DEATH_BANDS.map((entry) => {
			const outcome = entry.values[index];
			return {
				type: "text",
				text: outcome === SUDDEN_DEATH_OUTCOME.KILLED
					? (polish ? "Śmierć" : "Killed")
					: (polish ? "Bez efektu" : "No Effect"),
				range: [...entry.range],
				weight: 1,
				drawn: false,
				flags: {
					wfrp1ed: {
						criticalOutcome: { outcome },
					},
				},
			};
		}),
	};
}

function band(min, max, values) {
	return Object.freeze({
		range: Object.freeze([min, max]),
		values: Object.freeze(values),
	});
}

function star(number) {
	return Object.freeze({ number, flee: true });
}

function normalizeLanguage(language) {
	return String(language ?? "en").toLowerCase().startsWith("pl")
		? "pl"
		: "en";
}
