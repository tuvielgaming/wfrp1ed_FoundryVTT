export const EQUIPMENT_KIND = Object.freeze({
	STANDARD: "standard",
	AMMUNITION: "ammunition",
});

export const CONTAINER_KIND = Object.freeze({
	STANDARD: "standard",
	QUICK_AMMUNITION: "quickAmmunition",
});

export const AMMUNITION_TYPE = Object.freeze({
	NONE: "none",
	ARROW: "arrow",
	BOLT: "bolt",
	SLING: "sling",
	FIREARM_LOAD: "firearmLoad",
	CUSTOM: "custom",
});

export function normalizeEquipmentKind(value) {
	return normalizeAllowed(value, Object.values(EQUIPMENT_KIND), EQUIPMENT_KIND.STANDARD);
}

export function normalizeContainerKind(value) {
	return normalizeAllowed(value, Object.values(CONTAINER_KIND), CONTAINER_KIND.STANDARD);
}

export function normalizeAmmunitionType(value, fallback = AMMUNITION_TYPE.NONE) {
	return normalizeAllowed(value, Object.values(AMMUNITION_TYPE), fallback);
}

export function ammunitionIdentity({ type = AMMUNITION_TYPE.NONE, customId = "" } = {}) {
	const normalizedType = normalizeAmmunitionType(type);
	const normalizedCustomId = normalizeCustomId(customId);
	return Object.freeze({
		type: normalizedType,
		customId: normalizedType === AMMUNITION_TYPE.CUSTOM ? normalizedCustomId : "",
		key: normalizedType === AMMUNITION_TYPE.CUSTOM
			? `${AMMUNITION_TYPE.CUSTOM}:${normalizedCustomId}`
			: normalizedType,
	});
}

export function ammunitionIdentityMatches(first, second) {
	const a = ammunitionIdentity(first);
	const b = ammunitionIdentity(second);
	if (a.type === AMMUNITION_TYPE.NONE || b.type === AMMUNITION_TYPE.NONE) return false;
	return a.key === b.key;
}

export function normalizeCustomId(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
}

function normalizeAllowed(value, allowed, fallback) {
	const normalized = String(value ?? "").trim();
	return allowed.includes(normalized) ? normalized : fallback;
}
