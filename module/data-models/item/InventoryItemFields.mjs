const {
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

export const INVENTORY_MODE = Object.freeze({
	CARRIED: "carried",
	HELD: "held",
	WORN: "worn",
});

export const INVENTORY_HAND = Object.freeze({
	NONE: "none",
	RIGHT: "right",
	LEFT: "left",
	BOTH: "both",
});

const ALL_HANDS = Object.freeze(Object.values(INVENTORY_HAND));

/**
 * Shared persistent fields for physical WFRP Items which can be carried,
 * held, or worn.
 *
 * Consumers must use the stable `state.mode` / `state.hand` contract rather
 * than localized Item names. Equipment-specific models decide which modes are
 * presented to the user.
 */
export function inventorySchema({
	allowedModes = Object.values(INVENTORY_MODE),
	defaultMode = INVENTORY_MODE.CARRIED,
} = {}) {
	const normalizedModes = normalizeAllowedModes(allowedModes);
	const normalizedDefault = normalizedModes.includes(defaultMode)
		? defaultMode
		: normalizedModes[0];

	return {
		description: textField(),
		gmDescription: textField(),
		quantity: nonNegativeIntegerField(1),
		encumbrance: nonNegativeNumberField(),
		price: new SchemaField({
			gc: nonNegativeIntegerField(),
			ss: nonNegativeIntegerField(),
			bp: nonNegativeIntegerField(),
		}),
		availability: textField(),
		storageLocation: textField(),
		state: new SchemaField({
			mode: textField(normalizedDefault),
			hand: textField(INVENTORY_HAND.NONE),
		}),
	};
}

/**
 * Normalize legacy template.json physical-Item fields into the native v14
 * inventory contract without inventing equipment mechanics.
 */
export function migrateInventoryData(
	source,
	{
		allowedModes = Object.values(INVENTORY_MODE),
		defaultMode = INVENTORY_MODE.CARRIED,
		legacyEquippedMode = INVENTORY_MODE.HELD,
	} = {},
) {
	const migrated = foundry.utils.deepClone(source ?? {});
	const normalizedModes = normalizeAllowedModes(allowedModes);
	const fallbackMode = normalizedModes.includes(defaultMode)
		? defaultMode
		: normalizedModes[0];
	const state = objectValue(migrated.state);
	const price = objectValue(migrated.price);

	let requestedMode = normalizeText(state.mode);
	if (!requestedMode) {
		if (toBoolean(unwrapValue(migrated.held))) {
			requestedMode = INVENTORY_MODE.HELD;
		} else if (
			toBoolean(unwrapValue(migrated.worn)) ||
			toBoolean(unwrapValue(migrated.equipped))
		) {
			requestedMode = legacyEquippedMode;
		}
	}

	migrated.description = unwrapText(migrated.description);
	migrated.gmDescription = unwrapText(
		migrated.gmDescription ?? migrated.gmdescription,
	);
	migrated.quantity = toNonNegativeInteger(
		unwrapValue(migrated.quantity),
		1,
	);
	migrated.encumbrance = toNonNegativeNumber(
		unwrapValue(migrated.encumbrance ?? migrated.weight),
	);
	migrated.price = {
		gc: toNonNegativeInteger(unwrapValue(price.gc)),
		ss: toNonNegativeInteger(unwrapValue(price.ss)),
		bp: toNonNegativeInteger(unwrapValue(price.bp)),
	};
	migrated.availability = unwrapText(migrated.availability);
	migrated.storageLocation = unwrapText(
		migrated.storageLocation ?? migrated.location,
	);
	migrated.state = {
		mode: normalizeAllowed(
			requestedMode,
			normalizedModes,
			fallbackMode,
		),
		hand: normalizeAllowed(
			state.hand ?? migrated.hand,
			ALL_HANDS,
			INVENTORY_HAND.NONE,
		),
	};

	return migrated;
}

export function normalizeInventoryMode(value, allowedModes, fallback) {
	return normalizeAllowed(
		value,
		normalizeAllowedModes(allowedModes),
		fallback,
	);
}

export function normalizeInventoryHand(value) {
	return normalizeAllowed(
		value,
		ALL_HANDS,
		INVENTORY_HAND.NONE,
	);
}

export function unwrapValue(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "value")
	) {
		return value.value;
	}

	return value;
}

export function unwrapText(value) {
	return normalizeText(unwrapValue(value));
}

export function toNonNegativeInteger(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.max(0, Math.trunc(number))
		: Math.max(0, Math.trunc(Number(fallback) || 0));
}

export function toInteger(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.trunc(number)
		: Math.trunc(Number(fallback) || 0);
}

export function toNonNegativeNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.max(0, number)
		: Math.max(0, Number(fallback) || 0);
}

export function toBoolean(value) {
	if (value === true || value === false) return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "on"].includes(normalized)) return true;
		if (["false", "0", "no", "off", ""].includes(normalized)) return false;
	}
	return Boolean(value);
}

function textField(initial = "") {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial,
		trim: true,
	});
}

function nonNegativeIntegerField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial,
		min: 0,
	});
}

function nonNegativeNumberField(initial = 0) {
	return new NumberField({
		required: true,
		nullable: false,
		initial,
		min: 0,
	});
}

function normalizeAllowedModes(value) {
	const source = Array.isArray(value) ? value : [];
	const result = [];

	for (const entry of source) {
		const normalized = normalizeText(entry);
		if (
			Object.values(INVENTORY_MODE).includes(normalized) &&
			!result.includes(normalized)
		) {
			result.push(normalized);
		}
	}

	if (result.length === 0) {
		result.push(INVENTORY_MODE.CARRIED);
	}

	return result;
}

function normalizeAllowed(value, allowed, fallback) {
	const normalized = normalizeText(value);
	if (allowed.includes(normalized)) return normalized;
	return allowed.includes(fallback) ? fallback : allowed[0];
}

function objectValue(value) {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

function normalizeText(value) {
	if (value === undefined || value === null) return "";
	return String(value).trim();
}
