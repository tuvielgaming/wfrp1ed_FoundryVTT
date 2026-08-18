const DROP_WOUNDED_ARM = "injured-hand";

/*
 * Sidebar/Compendium Critical Wound templates are authoring documents. Older or
 * user-authored templates may therefore carry a display label (for example
 * "Lewa Ręka") or no physical side at all instead of the canonical runtime
 * hit-location IDs expected by CriticalConsequenceEngine.
 *
 * Normalize only the embedded Actor copy, immediately before creation. The
 * sidebar template keeps its author-facing text, while the runtime wound always
 * reaches the consequence engine as leftArm/rightArm/arm.
 */
Hooks.on("preCreateItem", (item) => {
	if (item?.type !== "criticalWound") return;
	if (!(item.parent instanceof foundry.documents.Actor)) return;
	if (dropHeldMode(item) !== DROP_WOUNDED_ARM) return;

	const current = readText(item.system?.hitLocation);
	const normalized = canonicalArmLocation(current);

	if (normalized) {
		if (normalized !== current) {
			item.updateSource({ "system.hitLocation": normalized });
		}
		return;
	}

	/* A side-dependent held-item consequence with no usable arm location is an
	 * unresolved arm template. Canonical `arm` intentionally makes the engine
	 * ask the user which physical arm was injured after the Item is created. */
	if (!current) {
		item.updateSource({ "system.hitLocation": "arm" });
	}
});

function dropHeldMode(item) {
	const consequence = item.system?.consequence?.toObject?.() ??
		item.system?.consequence ?? {};
	return readText(consequence?.dropHeld);
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
