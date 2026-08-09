import { DamageApplication } from "./DamageApplication.mjs";
import { DamageChat } from "./DamageChat.mjs";
import {
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";
import { DamageResolver } from "./DamageResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const WOUNDS_INITIALIZED_FLAG_KEY = "woundsInitialized";

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
		}),
	});

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
		(actor) => {
			DamageChat.refreshActorCards(actor);
		},
	);
});

Hooks.once("ready", () => {
	void initializeExistingCharacterWounds();
});

/**
 * Foundry v14 renamed ContextMenuEntry fields to label/visible/onClick.
 *
 * The test-result controller predates that rename and DamageChat was initially
 * implemented using the backwards-compatible aliases. Normalize WFRP entries
 * before the menu renders so v14 does not emit deprecation warnings.
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

		if (entry.onClick === undefined && entry.callback !== undefined) {
			entry.onClick = entry.callback;
		}

		delete entry.name;
		delete entry.condition;
		delete entry.callback;
	}
}

/**
 * Initialize the formerly hidden remaining-Wounds field for existing Character
 * Actors. Before the damage workflow existed the schema default was 0 and the
 * Classic sheet never exposed that value, so it did not represent an actual
 * wounded state. The per-Actor flag makes this migration idempotent.
 */
async function initializeExistingCharacterWounds() {
	for (const actor of game.actors ?? []) {
		if (
			actor.type !== "character" ||
			actor.getFlag?.(FLAG_SCOPE, WOUNDS_INITIALIZED_FLAG_KEY) === true
		) {
			continue;
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
			continue;
		}

		try {
			await actor.update({
				"system.status.wounds.value": maximum,
				[`flags.${FLAG_SCOPE}.${WOUNDS_INITIALIZED_FLAG_KEY}`]: true,
			});
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to initialize Character remaining Wounds.",
				{
					actor: actor.uuid,
					error,
				},
			);
		}
	}
}
