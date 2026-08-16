import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreCriticalTableSources } from "../module/core/CoreCriticalTableCatalog.mjs";
import { coreCriticalWoundItemSources } from "../module/core/CoreCriticalWoundCatalog.mjs";
import { coreSkillItemSources } from "../module/core/CoreSkillCatalog.mjs";

const compilePack = await loadCompilePack();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = join(ROOT, ".pack-build");
const PACK_ROOT = join(ROOT, "packs");

const PACKS = Object.freeze([
	pack("core-skills-en", "Item", 133, () => coreSkillItemSources("en")),
	pack("core-skills-pl", "Item", 134, () => coreSkillItemSources("pl")),
	pack("core-critical-wounds-en", "Item", 64, () => coreCriticalWoundItemSources("en")),
	pack("core-critical-wounds-pl", "Item", 64, () => coreCriticalWoundItemSources("pl")),
	pack("core-critical-tables-en", "RollTable", 16, () => coreCriticalTableSources("en")),
	pack("core-critical-tables-pl", "RollTable", 16, () => coreCriticalTableSources("pl")),
]);

await rm(SOURCE_ROOT, { recursive: true, force: true });
await mkdir(SOURCE_ROOT, { recursive: true });
await mkdir(PACK_ROOT, { recursive: true });

for (const definition of PACKS) {
	const sourceDirectory = join(SOURCE_ROOT, definition.name);
	const destination = join(PACK_ROOT, definition.name);
	await mkdir(sourceDirectory, { recursive: true });
	await rm(destination, { recursive: true, force: true });

	const documents = definition.documents().map((source, index) =>
		prepareDocument(definition, source, index));
	validatePack(definition, documents);

	for (const document of documents) {
		const fileName = `${safeFileName(document.name)}_${document._id}.json`;
		await writeFile(
			join(sourceDirectory, fileName),
			`${JSON.stringify(document, null, 2)}\n`,
			"utf8",
		);
	}

	await compilePack(sourceDirectory, destination, { log: true });
	console.log(
		`WFRP1ED | Built ${definition.name}: ${documents.length} ${definition.documentType} documents.`,
	);
}

await rm(SOURCE_ROOT, { recursive: true, force: true });
console.log("WFRP1ED | Core compendium build complete.");

async function loadCompilePack() {
	/*
	 * The published 0.0.6 package has existed in more than one packaging shape:
	 * the current source entry point re-exports compilePack, while some npm
	 * installs expose the implementation only from lib/package.mjs. Prefer the
	 * public API, but support that published-package layout as a compatibility
	 * fallback so the repository build is deterministic across both variants.
	 */
	try {
		const api = await import("@foundryvtt/foundryvtt-cli");
		if (typeof api.compilePack === "function") return api.compilePack;
	} catch (error) {
		if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			console.warn(
				"WFRP1ED | Foundry CLI root API did not expose compilePack; trying its package implementation.",
			);
		}
	}

	try {
		const implementation = await import(
			"@foundryvtt/foundryvtt-cli/lib/package.mjs"
		);
		if (typeof implementation.compilePack === "function") {
			return implementation.compilePack;
		}
	} catch (error) {
		throw new Error(
			"Unable to load compilePack from @foundryvtt/foundryvtt-cli. Run 'npm install' and verify that the installed CLI package contains lib/package.mjs.",
			{ cause: error },
		);
	}

	throw new Error(
		"@foundryvtt/foundryvtt-cli is installed, but neither its public API nor lib/package.mjs exposes compilePack.",
	);
}

function pack(name, documentType, expectedCount, documents) {
	return Object.freeze({ name, documentType, expectedCount, documents });
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

function safeFileName(value) {
	const normalized = String(value ?? "document")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || "document";
}

function structuredCloneSafe(value) {
	return JSON.parse(JSON.stringify(value));
}
