import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const SYSTEM_PREFIX = "system.";
const FLAG_SCOPE = "wfrp1ed";
const CORE_CATALOG_FLAG_KEY = "coreCatalog";

installCareerExitSelfDropGuard();

/**
 * Career Items contain several sibling collections (skills, trappings,
 * magicPoints, exits) plus the nested Advance Scheme. No Career Item update is
 * allowed to reach TypeDataModel cleaning with an incomplete Career system
 * object, because omitted siblings could be reconstructed from schema defaults.
 *
 * Foundry's preUpdateItem hook exposes the differential update before the
 * database operation. For every Career Item update, rebuild `changed.system` as
 * a complete snapshot of the current Career system with any requested system
 * differential applied on top. This also protects root-only changes such as the
 * Career name or image.
 *
 * The guard sits below every Career UI writer, so ordinary controls,
 * Advancements, Skills, Trappings, Magic Points, Career Exits, drag/drop, and
 * future Career editors all share the same persistence guarantee.
 */
Hooks.on("preUpdateItem", (item, changed) => {
	if (item?.type !== "career") return;
	if (!changed || typeof changed !== "object" || Array.isArray(changed)) return;

	const system = careerSystemSource(item);

	/* A nested `system` differential may already exist. Merge it first; arrays
	 * are deliberately replaced as complete values because Foundry treats array
	 * updates that way as well. */
	if (isRecord(changed.system)) {
		mergeDifferential(system, changed.system);
	}

	/* Dotted update paths are legal Foundry update syntax. Fold every system.*
	 * path into the complete snapshot and remove the dotted key so one complete
	 * authoritative `system` payload reaches TypeDataModel cleaning. */
	for (const [path, value] of Object.entries(changed)) {
		if (!path.startsWith(SYSTEM_PREFIX)) continue;
		setPath(system, path.slice(SYSTEM_PREFIX.length), cloneValue(value));
		delete changed[path];
	}

	/* Final persistence safety net. The sheet-level guard below rejects the
	 * invalid drop before any update, while this filter also protects imports,
	 * macros, migrations, and future Career editors. */
	const exits = Array.isArray(system.exits) ? system.exits : [];
	const filteredExits = exits.filter((exit) => !isSelfCareerReference(item, exit));
	if (filteredExits.length !== exits.length) {
		system.exits = filteredExits;
		ui.notifications.warn(selfExitMessage());
	}

	changed.system = system;
});

/**
 * Reject a Career dropped onto its own Career Exit zone before the private
 * CareerItemSheet #addExit handler can append it. This is intentionally owned
 * by the drop pipeline because a rejected self-exit should never flash into the
 * UI or depend on a later preUpdate cleanup.
 */
function installCareerExitSelfDropGuard() {
	if (CareerItemSheet.prototype.__wfrpSelfExitDropGuardInstalled === true) return;

	const original = CareerItemSheet.prototype._onDropDocument;
	CareerItemSheet.prototype._onDropDocument = async function guardedCareerExitDrop(
		event,
		document,
	) {
		const target = event?.target?.closest?.("[data-career-drop-zone]");
		const zone = String(target?.dataset?.careerDropZone ?? "");
		const isCareer = document instanceof foundry.documents.Item && document.type === "career";

		if (zone === "exits" && isCareer && sameCareerDocument(this.document, document)) {
			ui.notifications.warn(selfExitMessage());
			return null;
		}

		return original.call(this, event, document);
	};

	Object.defineProperty(
		CareerItemSheet.prototype,
		"__wfrpSelfExitDropGuardInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function careerSystemSource(item) {
	const source = item.system?.toObject?.() ?? item._source?.system ?? {};
	return cloneValue(source);
}

function sameCareerDocument(current, dropped) {
	if (!current || !dropped) return false;
	if (current === dropped) return true;

	const currentUuid = String(current.uuid ?? "").trim();
	const droppedUuid = String(dropped.uuid ?? "").trim();
	if (currentUuid && droppedUuid && currentUuid === droppedUuid) return true;

	const currentRules = canonicalRulesId(current);
	const droppedRules = canonicalRulesId(dropped);
	if (currentRules && droppedRules) return currentRules === droppedRules;

	const currentSource = sourceDocumentId(current);
	const droppedSource = sourceDocumentId(dropped);
	if (currentSource && droppedSource) return currentSource === droppedSource;

	/* Custom Careers often have no rulesId/catalog identity. In that case their
	 * normalized Career name is the only stable authoring identity available.
	 * Do not use the name fallback when both Careers have conflicting canonical
	 * ids; those are deliberately distinct Careers even if localized alike. */
	if (!currentRules && !droppedRules && !currentSource && !droppedSource) {
		const currentName = normalizeName(current.name);
		const droppedName = normalizeName(dropped.name);
		return Boolean(currentName && droppedName && currentName === droppedName);
	}

	return false;
}

function isSelfCareerReference(item, reference) {
	const itemUuid = String(item?.uuid ?? "").trim();
	const referenceUuid = String(reference?.uuid ?? "").trim();
	if (itemUuid && referenceUuid && itemUuid === referenceUuid) return true;

	const itemRulesId = canonicalRulesId(item);
	const referenceRulesId = String(reference?.rulesId ?? "").trim();
	if (itemRulesId && referenceRulesId) return itemRulesId === referenceRulesId;

	/* References persisted before canonical ids existed may contain only their
	 * display name. Use that fallback only when neither side has a canonical id. */
	if (!itemRulesId && !referenceRulesId) {
		const itemName = normalizeName(item?.name);
		const referenceName = normalizeName(reference?.name);
		return Boolean(itemName && referenceName && itemName === referenceName);
	}

	return false;
}

function canonicalRulesId(item) {
	const catalogue = item?.getFlag?.(FLAG_SCOPE, CORE_CATALOG_FLAG_KEY);
	return String(
		item?.system?.rulesId ||
		catalogue?.canonicalRulesId ||
		catalogue?.catalogId ||
		"",
	).trim();
}

function sourceDocumentId(item) {
	return String(
		item?._stats?.compendiumSource ||
		item?.getFlag?.("core", "sourceId") ||
		"",
	).trim();
}

function mergeDifferential(target, differential) {
	for (const [key, value] of Object.entries(differential)) {
		if (Array.isArray(value)) {
			target[key] = cloneValue(value);
			continue;
		}

		if (isRecord(value)) {
			if (!isRecord(target[key])) target[key] = {};
			mergeDifferential(target[key], value);
			continue;
		}

		target[key] = value;
	}
	return target;
}

function setPath(target, path, value) {
	const parts = String(path ?? "").split(".").filter(Boolean);
	if (!parts.length) return;

	let cursor = target;
	for (let index = 0; index < parts.length - 1; index += 1) {
		const key = parts[index];
		if (!isRecord(cursor[key])) cursor[key] = {};
		cursor = cursor[key];
	}
	cursor[parts.at(-1)] = value;
}

function cloneValue(value) {
	if (value === undefined || value === null) return value;
	if (typeof structuredClone === "function") {
		try {
			return structuredClone(value);
		} catch (_error) {
			// Fall back to Foundry's clone helper for DataModel-like objects.
		}
	}
	try {
		return foundry.utils.deepClone(value);
	} catch (_error) {
		return value;
	}
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeName(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function selfExitMessage() {
	return localize(
		"A Career cannot list itself as a Career Exit.",
		"Profesja nie może wskazywać samej siebie jako Profesji wyjściowej.",
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
