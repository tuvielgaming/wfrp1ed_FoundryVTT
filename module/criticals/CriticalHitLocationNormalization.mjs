const DROP_WOUNDED_ARM = "injured-hand";

/*
 * Sidebar/Compendium Critical Wound templates are authoring documents. Older or
 * user-authored templates may therefore carry a display label (for example
 * "Lewa Ręka") or no physical side at all instead of the canonical runtime
 * hit-location IDs expected by CriticalConsequenceEngine.
 *
 * Normalize only the embedded Actor copy, immediately before creation. The
 * sidebar template keeps its author-facing value, while the runtime wound always
 * reaches the consequence engine as leftArm/rightArm/arm.
 */
Hooks.on("preCreateItem", (item, data) => {
	if (item?.type !== "criticalWound") return;
	if (!(item.parent instanceof foundry.documents.Actor)) return;
	if (dropHeldMode(item, data) !== DROP_WOUNDED_ARM) return;

	const current = firstText(
		data?.system?.hitLocation,
		item?._source?.system?.hitLocation,
		item.system?.hitLocation,
	);
	const normalized = canonicalArmLocation(current);

	if (normalized) {
		if (normalized !== current) {
			item.updateSource({ "system.hitLocation": normalized });
		}
		return;
	}

	/* Empty is an intentional unresolved state on the Career/Critical authoring
	 * sheet. For a side-dependent held-item consequence, turn it into the
	 * engine's canonical generic-arm sentinel. ensurePhysicalArmSide() then opens
	 * the already-tested left/right selection dialog before any item is dropped. */
	if (!current) {
		item.updateSource({ "system.hitLocation": "arm" });
	}
});

function dropHeldMode(item, data) {
	return firstText(
		data?.system?.consequence?.dropHeld,
		item?._source?.system?.consequence?.dropHeld,
		item.system?.consequence?.toObject?.()?.dropHeld,
		item.system?.consequence?.dropHeld,
	);
}

function canonicalArmLocation(value) {
	const key = locationKey(value);
	if (!key) return "";

	if (LEFT_ARM_KEYS.has(key)) return "leftArm";
	if (RIGHT_ARM_KEYS.has(key)) return "rightArm";
	if (GENERIC_ARM_KEYS.has(key)) return "arm";
	return "";
}

const LEFT_ARM_KEYS = new Set([
	"leftarm",
	"lefthand",
	"left",
	"lewareka",
	"leweramie",
	"lewadlon",
]);

const RIGHT_ARM_KEYS = new Set([
	"rightarm",
	"righthand",
	"right",
	"prawareka",
	"praweramie",
	"prawadlon",
]);

const GENERIC_ARM_KEYS = new Set([
	"arm",
	"hand",
	"reka",
	"ramie",
	"dlon",
]);

function locationKey(value) {
	return readText(value)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLocaleLowerCase()
		.replace(/[^a-z]/g, "");
}

function firstText(...values) {
	for (const value of values) {
		const text = readText(value);
		if (text) return text;
	}
	return "";
}

function readText(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "value")
	) {
		return String(value.value ?? "").trim();
	}
	return String(value ?? "").trim();
}
