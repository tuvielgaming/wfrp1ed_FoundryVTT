import { DamageApplication } from "./DamageApplication.mjs";
import { DamageChat } from "./DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";
import { DamageResolver } from "./DamageResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const WOUNDS_INITIALIZED_FLAG_KEY = "woundsInitialized";
const WOUNDS_VALUE_PATH = "system.status.wounds.value";
const WOUNDS_INITIALIZED_PATH =
	`flags.${FLAG_SCOPE}.${WOUNDS_INITIALIZED_FLAG_KEY}`;
const PRESERVE_WOUNDS_INITIALIZATION_OPTION =
	"wfrp1edPreserveWoundsInitialization";

Hooks.once("init", () => {
	if (!game.WFRP1ED) {
		throw new Error(
			"WFRP1ED damage bootstrap requires the core system API to initialize first.",
		);
	}

	game.WFRP1ED = Object.freeze({
		...game.WFRP1ED,
		damage: Object.freeze({
			Packet: DamagePacket,
			Resolution: DamageResolution,
			Resolver: DamageResolver,
			Application: DamageApplication,
			Chat: DamageChat,
			mitigationPolicy: DAMAGE_MITIGATION_POLICY,
			criticalMode: DAMAGE_CRITICAL_MODE,
		}),
	});

	Hooks.on(
		"preUpdateActor",
		(actor, changes, options) => {
			normalizeRemainingWoundsUpdate(
				actor,
				changes,
				options,
			);
		},
	);

	Hooks.on(
		"renderChatMessageHTML",
		(message, html) => {
			DamageChat.applyClientState(message, html);
		},
	);

	Hooks.on(
		"getChatMessageContextOptions",
		(_application, menuItems) => {
			DamageChat.addContextMenuOptions(menuItems);
			normalizeContextMenuEntries(menuItems);
		},
	);

	Hooks.on(
		"updateActor",
		(actor, changes) => {
			DamageChat.refreshActorCards(actor);

			if (woundsProfileChanged(changes)) {
				void synchronizeUndamagedWounds(actor);
			}
		},
	);
});

Hooks.once("ready", () => {
	void initializeExistingCharacterWounds();
});

/**
 * Keep every Character remaining-Wounds write inside the legal WFRP 1e range.
 *
 * This is the common persistence boundary for sheet edits and other modules.
 * DamageApplication already calculates the same floor explicitly, but the Actor
 * update hook prevents console/forms/future features from persisting negative
 * remaining Wounds again. Manual writes initialize the in-play Wounds state.
 * Internal synchronization may opt out so an undamaged Actor can continue to
 * follow later profile-Wounds changes until play actually changes the resource.
 *
 * @param {Actor} actor
 * @param {Object} changes
 * @param {Object} options
 */
function normalizeRemainingWoundsUpdate(
	actor,
	changes,
	options = {},
) {
	if (
		actor?.type !== "character" ||
		!changes ||
		typeof changes !== "object"
	) {
		return;
	}

	const update = readUpdateValue(
		changes,
		WOUNDS_VALUE_PATH,
	);

	if (!update.present) {
		return;
	}

	const requested = Number(update.value);

	if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
		throw new Error(
			`Actor '${actor.name ?? actor.id}' remaining Wounds must be a finite integer.`,
		);
	}

	const maximum = Number(actor.woundsMaximum);
	const hasMaximum =
		Number.isFinite(maximum) &&
		Number.isInteger(maximum) &&
		maximum >= 0;
	const normalized = hasMaximum
		? Math.min(maximum, Math.max(0, requested))
		: Math.max(0, requested);

	writeUpdateValue(
		changes,
		WOUNDS_VALUE_PATH,
		normalized,
		update.dotted,
	);

	if (
		options?.[PRESERVE_WOUNDS_INITIALIZATION_OPTION] === true
	) {
		return;
	}

	changes[WOUNDS_INITIALIZED_PATH] = true;
}

/**
 * Foundry v14 renamed ContextMenuEntry fields to label/visible/onClick and
 * changed the click callback signature from callback(target) to
 * onClick(event, target).
 *
 * The test-result controller predates that API and DamageChat was initially
 * implemented using the backwards-compatible aliases. Normalize WFRP entries
 * before the menu renders while preserving the legacy callback semantics.
 *
 * @param {Array<Object>} menuItems
 */
function normalizeContextMenuEntries(menuItems) {
	if (!Array.isArray(menuItems)) {
		return;
	}

	for (const entry of menuItems) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		if (entry.label === undefined && entry.name !== undefined) {
			entry.label = entry.name;
		}

		if (entry.visible === undefined && entry.condition !== undefined) {
			entry.visible = entry.condition;
		}

		if (entry.onClick === undefined && typeof entry.callback === "function") {
			const legacyCallback = entry.callback;
			entry.onClick = (_event, target) => legacyCallback(target);
		}

		delete entry.name;
		delete entry.condition;
		delete entry.callback;
	}
}

/**
 * Initialize or normalize the remaining-Wounds field for existing Character
 * Actors.
 *
 * Actors which have never received explicit in-play damage remain synchronized
 * to their current Wounds characteristic maximum. Actors initialized by older
 * test builds may contain negative Wounds; WFRP 1e never persists Wounds below
 * zero, so those legacy values are normalized to zero on ready.
 */
async function initializeExistingCharacterWounds() {
	for (const actor of game.actors ?? []) {
		if (actor?.type !== "character") {
			continue;
		}

		if (
			actor.getFlag?.(
				FLAG_SCOPE,
				WOUNDS_INITIALIZED_FLAG_KEY,
			) === true
		) {
			await normalizeInitializedWounds(actor);
			continue;
		}

		await synchronizeUndamagedWounds(actor);
	}
}

/**
 * Keep an Actor which has not yet entered the in-play Wounds lifecycle at its
 * current Wounds characteristic maximum.
 *
 * @param {Actor} actor
 */
async function synchronizeUndamagedWounds(actor) {
	if (
		actor?.type !== "character" ||
		actor.getFlag?.(FLAG_SCOPE, WOUNDS_INITIALIZED_FLAG_KEY) === true
	) {
		return;
	}

	const maximum = Number(actor.woundsMaximum);

	if (!Number.isFinite(maximum) || !Number.isInteger(maximum)) {
		console.warn(
			"WFRP1ED | Unable to initialize remaining Wounds.",
			{
				actor: actor.uuid,
				woundsMaximum: actor.woundsMaximum,
			},
		);
		return;
	}

	const stored = Number(actor.system?.status?.wounds?.value);

	if (stored === maximum) {
		return;
	}

	try {
		await actor.update(
			{
				[WOUNDS_VALUE_PATH]: Math.max(0, maximum),
			},
			{
				[PRESERVE_WOUNDS_INITIALIZATION_OPTION]: true,
			},
		);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to synchronize Character remaining Wounds.",
			{
				actor: actor.uuid,
				error,
			},
		);
	}
}

/**
 * Normalize legacy initialized Actors created while the damage prototype still
 * represented critical overflow as negative Wounds.
 *
 * This intentionally does not recreate a historical critical value. The source
 * hit has already happened and its exact per-hit overflow may not be recoverable
 * from the current Actor total alone.
 *
 * @param {Actor} actor
 */
async function normalizeInitializedWounds(actor) {
	const stored = Number(actor.system?.status?.wounds?.value);

	if (
		!Number.isFinite(stored) ||
		!Number.isInteger(stored) ||
		stored >= 0
	) {
		return;
	}

	try {
		await actor.update({
			[WOUNDS_VALUE_PATH]: 0,
		});

		console.info(
			"WFRP1ED | Normalized legacy negative remaining Wounds to zero.",
			{
				actor: actor.uuid,
				previousWounds: stored,
			},
		);
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to normalize legacy negative remaining Wounds.",
			{
				actor: actor.uuid,
				error,
			},
		);
	}
}

function readUpdateValue(changes, path) {
	if (Object.hasOwn(changes, path)) {
		return {
			present: true,
			value: changes[path],
			dotted: true,
		};
	}

	const value = foundry.utils.getProperty(changes, path);

	return {
		present: value !== undefined,
		value,
		dotted: false,
	};
}

function writeUpdateValue(
	changes,
	path,
	value,
	dotted,
) {
	if (dotted) {
		changes[path] = value;
		return;
	}

	foundry.utils.setProperty(changes, path, value);
}

function woundsProfileChanged(changes) {
	if (!changes || typeof changes !== "object") {
		return false;
	}

	if (
		foundry.utils.getProperty(
			changes,
			"system.characteristics.w",
		) !== undefined
	) {
		return true;
	}

	return Object.keys(changes).some((key) =>
		key.startsWith("system.characteristics.w."),
	);
}
