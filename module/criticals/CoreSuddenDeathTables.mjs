import {
	CRITICAL_TABLE_ROLE,
	CRITICAL_VALUE_VARIANTS,
} from "./CriticalTableRegistry.mjs";

export const CORE_SUDDEN_DEATH_PROVIDER_ID =
	"wfrp1ed.core.suddenDeath";
export const CORE_SUDDEN_DEATH_TABLE_VERSION = 1;

const MAINTENANCE_OPTION = "wfrp1edCoreCriticalMaintenance";
const FLAG_SCOPE = "wfrp1ed";
const TABLE_FLAG_KEY = "coreCriticalTable";
const OUTCOME_FLAG_KEY = "criticalOutcome";

const TABLE_IDS = Object.freeze({
	"1": "wfrpCritSD000001",
	"2": "wfrpCritSD000002",
	"3": "wfrpCritSD000003",
	"4": "wfrpCritSD000004",
	"5": "wfrpCritSD000005",
	"6+": "wfrpCritSD000006",
});

export const CORE_SUDDEN_DEATH_TABLE_UUIDS = Object.freeze(
	Object.fromEntries(
		Object.entries(TABLE_IDS).map(([variant, id]) => [
			variant,
			`RollTable.${id}`,
		]),
	),
);

export const SUDDEN_DEATH_OUTCOME = Object.freeze({
	NO_EFFECT: "no-effect",
	KILLED: "killed",
});

/*
 * Audited from both WFRP 1e Core Rulebooks.
 *
 * English: Combat — Sudden Death Critical Hit System, printed pp. 124-125.
 * Polish:  Walka — System trafień krytycznych: Nagła Śmierć, printed p. 125.
 *
 * The books match mechanically. English NE/K corresponds to Polish BE/Ś.
 * The English first band is printed 0-9%; the Polish table clarifies it as
 * 01-09%, consistent with a d100 roll of 1-100.
 */
const SUDDEN_DEATH_BANDS = Object.freeze([
	band(1, 9, [
		"no-effect", "no-effect", "no-effect",
		"no-effect", "no-effect", "killed",
	]),
	band(10, 20, [
		"no-effect", "no-effect", "no-effect",
		"no-effect", "killed", "killed",
	]),
	band(21, 30, [
		"no-effect", "no-effect", "no-effect",
		"killed", "killed", "killed",
	]),
	band(31, 40, [
		"no-effect", "no-effect", "killed",
		"killed", "killed", "killed",
	]),
	band(41, 50, [
		"no-effect", "killed", "killed",
		"killed", "killed", "killed",
	]),
	band(51, 100, [
		"killed", "killed", "killed",
		"killed", "killed", "killed",
	]),
]);

/** Register cancellable guards which keep managed Core tables read-only. */
export function registerCoreSuddenDeathTableProtection() {
	Hooks.on("preUpdateRollTable", (table, _changes, options) =>
		protectCoreDocument(table, options));
	Hooks.on("preDeleteRollTable", (table, options) =>
		protectCoreDocument(table, options));

	for (const hook of [
		"preCreateTableResult",
		"preUpdateTableResult",
		"preDeleteTableResult",
	]) {
		Hooks.on(hook, (result, ...args) => {
			const options = hook === "preDeleteTableResult"
				? args[0]
				: args[1];
			return protectCoreDocument(result?.parent, options);
		});
	}
}

/**
 * Ensure the audited Core Sudden Death fallback RollTables exist in the world.
 *
 * The current repository workflow cannot ship a binary LevelDB compendium via
 * text-only source edits, so these six system-managed world RollTables are
 * materialized with stable IDs. They are read-only; a GM may duplicate one and
 * select the duplicate as a world override without modifying the Core fallback.
 */
export async function ensureCoreSuddenDeathTables() {
	if (!game.user?.isGM) return;

	for (const variant of CRITICAL_VALUE_VARIANTS) {
		const id = TABLE_IDS[variant];
		const existing = game.tables?.get(id) ?? null;

		if (existing) {
			const metadata = coreMetadata(existing);

			if (!metadata) {
				console.error(
					`WFRP1ED | Cannot materialize Core Sudden Death table '${variant}': RollTable id '${id}' is already used by a non-Core document.`,
				);
				continue;
			}

			if (
				metadata.role === CRITICAL_TABLE_ROLE.SUDDEN_DEATH &&
				metadata.variant === variant &&
				Number(metadata.version) === CORE_SUDDEN_DEATH_TABLE_VERSION
			) {
				continue;
			}

			await existing.delete({
				[MAINTENANCE_OPTION]: true,
				render: false,
			});
		}

		await foundry.documents.RollTable.create(
			buildTableData(variant),
			{
				keepId: true,
				render: false,
				[MAINTENANCE_OPTION]: true,
			},
		);
	}

	/*
	 * Creation above intentionally suppresses six individual directory renders.
	 * Refresh the world RollTable collection once after materialization so the
	 * sidebar reflects the managed Core tables immediately on this same client.
	 */
	game.tables?.render?.(false);
}

function buildTableData(variant) {
	const variantIndex = CRITICAL_VALUE_VARIANTS.indexOf(variant);

	if (variantIndex < 0) {
		throw new Error(`Unknown Sudden Death critical variant '${variant}'.`);
	}

	return {
		_id: TABLE_IDS[variant],
		name: `WFRP1ED Core — Sudden Death / Nagła Śmierć +${variant}`,
		description:
			"System-managed WFRP 1e Core fallback. English Combat pp. 124-125; Polish Walka p. 125. Duplicate this table and configure the copy as an override for house rules.",
		formula: "1d100",
		replacement: true,
		displayRoll: true,
		ownership: {
			default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
		},
		flags: {
			[FLAG_SCOPE]: {
				[TABLE_FLAG_KEY]: {
					role: CRITICAL_TABLE_ROLE.SUDDEN_DEATH,
					variant,
					version: CORE_SUDDEN_DEATH_TABLE_VERSION,
				},
			},
		},
		results: SUDDEN_DEATH_BANDS.map((entry) => {
			const outcome = entry.outcomes[variantIndex];

			return {
				type: "text",
				text: outcome === SUDDEN_DEATH_OUTCOME.KILLED
					? "Killed / Śmierć"
					: "No Effect / Bez efektu",
				range: [...entry.range],
				weight: 1,
				drawn: false,
				flags: {
					[FLAG_SCOPE]: {
						[OUTCOME_FLAG_KEY]: outcome,
					},
				},
			};
		}),
	};
}

function band(min, max, outcomes) {
	return Object.freeze({
		range: Object.freeze([min, max]),
		outcomes: Object.freeze(outcomes),
	});
}

function coreMetadata(table) {
	if (!(table instanceof foundry.documents.RollTable)) return null;
	const value = table.getFlag?.(FLAG_SCOPE, TABLE_FLAG_KEY);
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: null;
}

function protectCoreDocument(table, options = {}) {
	if (options?.[MAINTENANCE_OPTION] === true) return;
	if (!coreMetadata(table)) return;

	ui.notifications.warn(
		game.i18n.lang === "pl"
			? "To jest zarządzana przez system tabela WFRP 1e Core. Utwórz kopię i ustaw ją jako nadpisanie, aby użyć zasad własnych."
			: "This is a system-managed WFRP 1e Core table. Duplicate it and select the copy as an override for house rules.",
	);
	return false;
}
