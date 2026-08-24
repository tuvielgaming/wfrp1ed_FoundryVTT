export const RANGED_CRITICAL_EFFECT_TABLE_NAMES = Object.freeze({
	head: "WFRP1ED Ranged Critical Effects - Head",
	body: "WFRP1ED Ranged Critical Effects - Body",
	arm: "WFRP1ED Ranged Critical Effects - Arm",
	leg: "WFRP1ED Ranged Critical Effects - Leg",
});

const warned = new Set();

/**
 * Resolve an optional ranged-specific detailed Critical Effect description.
 *
 * Contract:
 * - exact, case-sensitive machine-facing table names;
 * - one matching World RollTable wins over Compendium content;
 * - otherwise exactly one matching Compendium RollTable may provide the text;
 * - ambiguity, an invalid result band or an empty result falls back to the
 *   ordinary Detailed Critical Effects table rather than guessing.
 *
 * These tables override narrative effect text only. The Core detailed chart,
 * effect number, fatal outcome and mechanical Critical consequence remain the
 * authoritative mechanics unless a future structured custom-mechanics contract
 * is introduced explicitly.
 */
export async function rangedCriticalEffectFor(hitLocation, effectNumber) {
	const location = genericLocation(hitLocation);
	const tableName = RANGED_CRITICAL_EFFECT_TABLE_NAMES[location];
	const number = Number(effectNumber);
	if (!tableName || !Number.isInteger(number) || number < 1 || number > 16) {
		return null;
	}

	const resolved = await resolveNamedTable(tableName);
	if (!resolved) return null;

	const results = [...resolved.table.getResultsForRoll(number)];
	if (results.length !== 1) {
		warnOnce(
			`result:${resolved.table.uuid}:${number}:${results.length}`,
			localize(
				`Ranged Critical Effects table '${tableName}' must return exactly one result for effect ${number}; received ${results.length}. The standard Detailed Critical effect will be used instead.`,
				`Tabela efektów krytycznych ataku dystansowego '${tableName}' musi zwracać dokładnie jeden wynik dla efektu ${number}; otrzymano ${results.length}. Zostanie użyty standardowy szczegółowy efekt krytyczny.`,
			),
		);
		return null;
	}

	const result = results[0];
	const text = String(result.text ?? "").trim();
	if (!text) {
		warnOnce(
			`empty:${resolved.table.uuid}:${result.id}`,
			localize(
				`Ranged Critical Effects table '${tableName}' returned an empty text result for effect ${number}. The standard Detailed Critical effect will be used instead.`,
				`Tabela efektów krytycznych ataku dystansowego '${tableName}' zwróciła pusty opis dla efektu ${number}. Zostanie użyty standardowy szczegółowy efekt krytyczny.`,
			),
		);
		return null;
	}

	return foundry.utils.deepFreeze({
		version: 1,
		location,
		effectNumber: number,
		source: resolved.source,
		packId: resolved.packId,
		tableUuid: String(resolved.table.uuid ?? ""),
		tableName: String(resolved.table.name ?? tableName),
		resultId: String(result.id ?? ""),
		text,
	});
}

async function resolveNamedTable(tableName) {
	const worldMatches = [...(game.tables ?? [])].filter(
		(table) => String(table?.name ?? "") === tableName,
	);
	if (worldMatches.length === 1) {
		return {
			source: "world",
			packId: "",
			table: worldMatches[0],
		};
	}
	if (worldMatches.length > 1) {
		warnOnce(
			`world-duplicate:${tableName}`,
			localize(
				`More than one World RollTable is named '${tableName}'. The system will not choose arbitrarily; the standard Detailed Critical effect will be used instead.`,
				`Więcej niż jedna tabela RollTable świata ma nazwę '${tableName}'. System nie wybierze jednej arbitralnie; zostanie użyty standardowy szczegółowy efekt krytyczny.`,
			),
		);
		return null;
	}

	const matches = [];
	for (const pack of game.packs ?? []) {
		if (!isRollTablePack(pack)) continue;
		try {
			const index = await pack.getIndex({ fields: ["name"] });
			for (const entry of index ?? []) {
				if (String(entry?.name ?? "") !== tableName) continue;
				matches.push({ pack, id: String(entry._id ?? entry.id ?? "") });
			}
		} catch (_error) {
			/* A user may not have permission to inspect every installed Compendium.
			 * Inaccessible packs are simply not candidates. */
		}
	}

	if (matches.length === 0) return null;
	if (matches.length > 1) {
		warnOnce(
			`pack-duplicate:${tableName}`,
			localize(
				`More than one Compendium RollTable is named '${tableName}'. The system will not choose arbitrarily; import the desired table into the World or remove the ambiguity. The standard Detailed Critical effect will be used for now.`,
				`Więcej niż jedna tabela RollTable w Kompendiach ma nazwę '${tableName}'. System nie wybierze jednej arbitralnie; zaimportuj wybraną tabelę do Świata albo usuń niejednoznaczność. Na razie zostanie użyty standardowy szczegółowy efekt krytyczny.`,
			),
		);
		return null;
	}

	const match = matches[0];
	try {
		const table = await match.pack.getDocument(match.id);
		if (!(table instanceof foundry.documents.RollTable)) return null;
		return {
			source: "compendium",
			packId: String(match.pack.collection ?? match.pack.metadata?.id ?? ""),
			table,
		};
	} catch (_error) {
		warnOnce(
			`pack-unavailable:${tableName}:${match.pack.collection ?? ""}`,
			localize(
				`The matching Compendium RollTable '${tableName}' could not be loaded. The standard Detailed Critical effect will be used instead.`,
				`Nie udało się wczytać pasującej tabeli RollTable '${tableName}' z Kompendium. Zostanie użyty standardowy szczegółowy efekt krytyczny.`,
			),
		);
		return null;
	}
}

function isRollTablePack(pack) {
	return String(pack?.documentName ?? pack?.metadata?.type ?? "") === "RollTable";
}

function genericLocation(value) {
	switch (String(value ?? "").trim()) {
		case "head": return "head";
		case "body": return "body";
		case "leftArm":
		case "rightArm":
		case "arm": return "arm";
		case "leftLeg":
		case "rightLeg":
		case "leg": return "leg";
		default: return "";
	}
}

function warnOnce(key, message) {
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(`WFRP1ED | ${message}`);
	if (game.user?.isGM) ui.notifications.warn(message);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
