import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";
import { coreCriticalTableSources } from "../module/core/CoreCriticalTableCatalog.mjs";
import { coreCriticalWoundItemSources } from "../module/core/CoreCriticalWoundCatalog.mjs";
import { coreSkillItemSources } from "../module/core/CoreSkillCatalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACK_ROOT = join(ROOT, "packs");

const PACKS = Object.freeze([
	pack("core-skills-en", "Item", 133, () => coreSkillItemSources("en")),
	pack("core-skills-pl", "Item", 134, () => coreSkillItemSources("pl")),
	pack("core-critical-wounds-en", "Item", 64, () => coreCriticalWoundItemSources("en")),
	pack("core-critical-wounds-pl", "Item", 64, () => coreCriticalWoundItemSources("pl")),
	pack("core-critical-tables-en", "RollTable", 16, () => coreCriticalTableSources("en")),
	pack("core-critical-tables-pl", "RollTable", 16, () => coreCriticalTableSources("pl")),
]);

await mkdir(PACK_ROOT, { recursive: true });

for (const definition of PACKS) {
	const destination = join(PACK_ROOT, definition.name);
	await rm(destination, { recursive: true, force: true });

	const documents = definition.documents().map((source, index) =>
		prepareDocument(definition, source, index));
	validatePack(definition, documents);

	await compileFoundryLevelPack(definition, documents, destination);
	console.log(
		`WFRP1ED | Built ${definition.name}: ${documents.length} ${definition.documentType} documents.`,
	);
}

console.log("WFRP1ED | Core compendium build complete.");

function pack(name, documentType, expectedCount, documents) {
	return Object.freeze({ name, documentType, expectedCount, documents });
}

/**
 * Write the small hierarchy used by this repository directly in Foundry's
 * LevelDB pack format.
 *
 * The published @foundryvtt/foundryvtt-cli 0.0.6 npm package is missing the
 * lib/package.mjs implementation referenced by its documented compilePack API
 * in some installations. Depending on that private packaging detail makes the
 * system build fail before it reaches our content. ClassicLevel is the actual
 * database layer used by Foundry's official compiler, so keep our build local
 * and deterministic for the two document hierarchies we own here:
 *
 *   Item -> ActiveEffect
 *   RollTable -> TableResult
 *
 * Foundry stores embedded collections as arrays of ids on the parent and stores
 * each embedded document under a hierarchical LevelDB key.
 */
async function compileFoundryLevelPack(definition, documents, destination) {
	const collection = collectionFor(definition.documentType);
	await mkdir(destination, { recursive: true });

	const db = new ClassicLevel(destination, {
		keyEncoding: "utf8",
		valueEncoding: "json",
	});

	await db.open();
	try {
		const batch = db.batch();
		const seenKeys = new Set();

		for (const source of documents) {
			const document = structuredCloneSafe(source);
			const parentId = document._id;

			if (collection === "items") {
				const effects = Array.isArray(document.effects)
					? document.effects
					: [];
				document.effects = effects.map((effect) => effect._id);

				for (const effect of effects) {
					putUnique(
						batch,
						seenKeys,
						`!items.effects!${parentId}.${effect._id}`,
						effect,
					);
				}
			}

			if (collection === "tables") {
				const results = Array.isArray(document.results)
					? document.results
					: [];
				document.results = results.map((result) => result._id);

				for (const result of results) {
					putUnique(
						batch,
						seenKeys,
						`!tables.results!${parentId}.${result._id}`,
						result,
					);
				}
			}

			putUnique(
				batch,
				seenKeys,
				`!${collection}!${parentId}`,
				document,
			);
		}

		await batch.write();
		await compactDatabase(db);
	} finally {
		await db.close();
	}
}

function putUnique(batch, seenKeys, key, source) {
	if (seenKeys.has(key)) {
		throw new Error(`Duplicate Foundry pack key '${key}'.`);
	}
	seenKeys.add(key);

	const value = structuredCloneSafe(source);
	delete value._key;
	batch.put(key, value);
}

async function compactDatabase(db) {
	const forward = db.keys({ limit: 1, fillCache: false });
	const firstKey = await forward.next();
	await forward.close();

	const backward = db.keys({ limit: 1, reverse: true, fillCache: false });
	const lastKey = await backward.next();
	await backward.close();

	if (firstKey && lastKey) {
		await db.compactRange(firstKey, lastKey, { keyEncoding: "utf8" });
	}
}

function collectionFor(documentType) {
	switch (documentType) {
		case "Item": return "items";
		case "RollTable": return "tables";
		default:
			throw new Error(
				`Unsupported compendium document type '${documentType}'.`,
			);
	}
}

function validatePack(definition, documents) {
	if (documents.length !== definition.expectedCount) {
		throw new Error(
			`${definition.name} produced ${documents.length} documents; expected ${definition.expectedCount}.`,
		);
	}

	const ids = new Set();
	for (const document of documents) {
		const id = String(document._id ?? "");
		if (!/^[A-Za-z0-9]{16}$/.test(id)) {
			throw new Error(`${definition.name} contains invalid document id '${id}'.`);
		}
		if (ids.has(id)) {
			throw new Error(`${definition.name} contains duplicate document id '${id}'.`);
		}
		ids.add(id);

		validateEmbeddedIds(definition, document, "effects");
		validateEmbeddedIds(definition, document, "results");
	}
}

function validateEmbeddedIds(definition, document, field) {
	if (!Array.isArray(document[field])) return;
	const ids = new Set();

	for (const embedded of document[field]) {
		const id = String(embedded?._id ?? "");
		if (!/^[A-Za-z0-9]{16}$/.test(id)) {
			throw new Error(
				`${definition.name} document '${document._id}' contains invalid ${field} id '${id}'.`,
			);
		}
		if (ids.has(id)) {
			throw new Error(
				`${definition.name} document '${document._id}' contains duplicate ${field} id '${id}'.`,
			);
		}
		ids.add(id);
	}
}

function prepareDocument(packDefinition, source, index) {
	const document = structuredCloneSafe(source);
	const identity = documentIdentity(packDefinition, document, index);
	if (!document._id) document._id = stableId(identity);

	if (Array.isArray(document.effects)) {
		document.effects = document.effects.map((effect, effectIndex) => ({
			...effect,
			_id: effect._id ?? stableId(`${identity}:effect:${effectIndex}`),
		}));
	}

	if (Array.isArray(document.results)) {
		document.results = document.results.map((result, resultIndex) => ({
			...result,
			_id: result._id ?? stableId(`${identity}:result:${resultIndex}`),
		}));
	}

	return document;
}

function documentIdentity(packDefinition, document, index) {
	const core = document.flags?.wfrp1ed?.coreCatalog;
	if (core?.kind === "skill") {
		return `${packDefinition.name}:skill:${core.catalogId || core.polishIndex || index}`;
	}
	if (core?.kind === "criticalWound") {
		return `${packDefinition.name}:critical:${core.location}:${core.effectNumber}`;
	}
	if (document._id) return `${packDefinition.name}:${document._id}`;
	return `${packDefinition.name}:${document.name}:${index}`;
}

function stableId(seed) {
	return createHash("sha256")
		.update(String(seed), "utf8")
		.digest("hex")
		.slice(0, 16);
}

function structuredCloneSafe(value) {
	return JSON.parse(JSON.stringify(value));
}
