const SYSTEM_PREFIX = "system.";

/**
 * Career Items contain several sibling collections (skills, trappings,
 * magicPoints, exits) plus the nested Advance Scheme. A partial TypeDataModel
 * update must never be allowed to clean/migrate an incomplete Career system
 * object and thereby replace untouched siblings with schema defaults.
 *
 * Foundry's preUpdateItem hook exposes the differential update before the
 * database operation. For Career Items, whenever that differential touches
 * system data, rebuild it as a complete snapshot of the current Career system
 * with the requested differential applied on top.
 *
 * This guard is intentionally below every Career UI writer. It therefore covers
 * ordinary controls, Advance Scheme edits, Skill/Trapping configuration, Magic
 * Points, Career Exits, drag/drop actions, and any future Career editor that
 * uses Item.update().
 */
Hooks.on("preUpdateItem", (item, changed) => {
	if (item?.type !== "career") return;
	if (!changed || typeof changed !== "object" || Array.isArray(changed)) return;
	if (!touchesCareerSystem(changed)) return;

	const system = careerSystemSource(item);

	/* A nested `system` differential may already exist. Merge it first; arrays
	 * are deliberately replaced as complete values because Foundry treats array
	 * updates that way as well. */
	if (isRecord(changed.system)) {
		mergeDifferential(system, changed.system);
	}

	/* Dotted update paths are also legal Foundry update syntax. Fold every
	 * system.* path into the complete system snapshot and remove the dotted key
	 * so only one authoritative `system` payload reaches TypeDataModel cleaning. */
	for (const [path, value] of Object.entries(changed)) {
		if (!path.startsWith(SYSTEM_PREFIX)) continue;
		setPath(system, path.slice(SYSTEM_PREFIX.length), cloneValue(value));
		delete changed[path];
	}

	changed.system = system;
});

function touchesCareerSystem(changed) {
	if (Object.hasOwn(changed, "system")) return true;
	return Object.keys(changed).some((key) => key.startsWith(SYSTEM_PREFIX));
}

function careerSystemSource(item) {
	const source = item.system?.toObject?.() ?? item._source?.system ?? {};
	return cloneValue(source);
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
