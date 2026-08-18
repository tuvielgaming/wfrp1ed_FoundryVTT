const SYSTEM_PREFIX = "system.";

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

	changed.system = system;
});

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
