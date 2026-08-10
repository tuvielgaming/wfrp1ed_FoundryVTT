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
const OWNER_WOUNDS_EDIT_FLAG_KEY = "allowOwnerWoundsEdit";
const WOUNDS_VALUE_PATH = "system.status.wounds.value";
const WOUNDS_INITIALIZED_PATH =
	`flags.${FLAG_SCOPE}.${WOUNDS_INITIALIZED_FLAG_KEY}`;
const PRESERVE_WOUNDS_INITIALIZATION_OPTION =
	"wfrp1edPreserveWoundsInitialization";
const AUTHORIZED_DAMAGE_APPLICATION_OPTION =
	"wfrp1edAuthorizedDamageApplication";

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

	registerWoundsPermissionHelpers();
	document.addEventListener(
		"click",
		onOwnerWoundsEditToggle,
	);

	Hooks.on(
		"preUpdateActor",
		(actor, changes, options, userId) =>
			normalizeRemainingWoundsUpdate(
				actor,
				changes,
				options,
				userId,
			),
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

			if (ownerWoundsEditPermissionChanged(changes)) {
				void refreshRenderedActorSheet(actor);
			}
		},
	);
});

Hooks.once("ready", () => {
	if (game.user?.isGM) {
		void initializeExistingCharacterWounds();
	}
});

function registerWoundsPermissionHelpers() {
	Handlebars.registerHelper(
		"wfrpCanEditRemainingWounds",
		(actorUuid) => {
			const actor = actorFromUuidSync(actorUuid);
			return canUserManuallyEditRemainingWounds(
				actor,
				game.user,
			);
		},
	);

	Handlebars.registerHelper(
		"wfrpIsGM",
		() => Boolean(game.user?.isGM),
	);

	Handlebars.registerHelper(
		"wfrpOwnerWoundsEditEnabled",
		(actorUuid) => {
			const actor = actorFromUuidSync(actorUuid);
			return actor?.getFlag?.(
				FLAG_SCOPE,
				OWNER_WOUNDS_EDIT_FLAG_KEY,
			) === true;
		},
	);

	Handlebars.registerHelper(
		"wfrpOwnerWoundsEditTitle",
		(actorUuid) => {
			const actor = actorFromUuidSync(actorUuid);
			const enabled = actor?.getFlag?.(
				FLAG_SCOPE,
				OWNER_WOUNDS_EDIT_FLAG_KEY,
			) === true;

			if (game.i18n.lang === "pl") {
				return enabled
					? "Zablokuj właścicielowi ręczną edycję Żywotności"
					: "Pozwól właścicielowi ręcznie edytować Żywotność";
			}

			return enabled
				? "Disable owner manual Wounds editing"
				: "Allow owner manual Wounds editing";
		},
	);
}

async function onOwnerWoundsEditToggle(event) {
	const target = event.target?.closest?.(
		"[data-wfrp-owner-wounds-edit-toggle]",
	);

	if (!target) {
		return;
	}

	event.preventDefault();
	event.stopPropagation();

	if (!game.user?.isGM) {
		ui.notifications.warn(
			game.i18n.lang === "pl"
				? "Tylko MG może zmienić uprawnienie do ręcznej edycji Żywotności."
				: "Only a GM can change manual Wounds editing permission.",
		);
		return;
	}

	const actor = await foundry.utils.fromUuid(
		String(target.dataset.actorUuid ?? "").trim(),
	);

	if (!(actor instanceof foundry.documents.Actor)) {
		ui.notifications.error(
			game.i18n.lang === "pl"
				? "Nie znaleziono postaci dla tego ustawienia Żywotności."
				: "The Actor for this Wounds permission was not found.",
		);
		return;
	}

	const enabled = actor.getFlag?.(
		FLAG_SCOPE,
		OWNER_WOUNDS_EDIT_FLAG_KEY,
	) === true;
	const next = !enabled;
	const explicitOwners = explicitPlayerOwners(actor);

	if (next && explicitOwners.length === 0) {
		ui.notifications.warn(
			game.i18n.lang === "pl"
				? `Postać ${actor.name} nie ma jawnie przypisanego właściciela-gracza. Najpierw ustaw konkretnemu graczowi poziom Właściciel w uprawnieniach postaci.`
				: `${actor.name} has no explicitly assigned player owner. Assign a specific player OWNER permission on the Actor first.`,
		);
		return;
	}

	await actor.setFlag(
		FLAG_SCOPE,
		OWNER_WOUNDS_EDIT_FLAG_KEY,
		next,
	);

	const ownerNames = explicitOwners
		.map((user) => user.name)
		.filter(Boolean)
		.join(", ");

	ui.notifications.info(
		game.i18n.lang === "pl"
			? next
				? `Ręczna edycja Żywotności odblokowana dla: ${ownerNames}.`
				: `Ręczna edycja Żywotności przez właściciela została zablokowana: ${actor.name}.`
			: next
				? `Manual Wounds editing enabled for: ${ownerNames}.`
				: `Owner manual Wounds editing has been disabled: ${actor.name}.`,
	);
}

function normalizeRemainingWoundsUpdate(
	actor,
	changes,
	options = {},
	userId = null,
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

	const internalSynchronization =
		options?.[PRESERVE_WOUNDS_INITIALIZATION_OPTION] === true;
	const authorizedDamageApplication =
		options?.[AUTHORIZED_DAMAGE_APPLICATION_OPTION] === true;
	const user = game.users?.get?.(userId) ?? game.user;

	if (
		!internalSynchronization &&
		!authorizedDamageApplication &&
		!canUserManuallyEditRemainingWounds(actor, user)
	) {
		ui.notifications.warn(
			game.i18n.lang === "pl"
				? "Ręczna edycja Żywotności jest zablokowana przez MG."
				: "Manual Wounds editing is locked by the GM.",
		);
		return false;
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
	const stored = Number(
		actor.system?.status?.wounds?.value,
	);
	const valueChanged =
		!Number.isFinite(stored) ||
		normalized !== stored;

	writeUpdateValue(
		changes,
		WOUNDS_VALUE_PATH,
		normalized,
		update.dotted,
	);

	if (
		internalSynchronization ||
		!valueChanged
	) {
		return;
	}

	changes[WOUNDS_INITIALIZED_PATH] = true;
}

function canUserManuallyEditRemainingWounds(
	actor,
	user = game.user,
) {
	if (
		!(actor instanceof foundry.documents.Actor) ||
		actor.type !== "character" ||
		!user
	) {
		return false;
	}

	if (user.isGM) {
		return true;
	}

	if (!isExplicitPlayerOwner(actor, user)) {
		return false;
	}

	return actor.getFlag?.(
		FLAG_SCOPE,
		OWNER_WOUNDS_EDIT_FLAG_KEY,
	) === true;
}

function isExplicitPlayerOwner(actor, user) {
	if (
		!(actor instanceof foundry.documents.Actor) ||
		!user ||
		user.isGM
	) {
		return false;
	}

	const ownership =
		actor.ownership ??
		actor._source?.ownership ??
		{};
	const level = Number(ownership?.[user.id]);

	return level ===
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
}

function explicitPlayerOwners(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		return [];
	}

	return [...(game.users ?? [])].filter((user) =>
		isExplicitPlayerOwner(actor, user),
	);
}

function actorFromUuidSync(uuid) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(uuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor
			? actor
			: null;
	} catch (_error) {
		return null;
	}
}

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
		await actor.update(
			{
				[WOUNDS_VALUE_PATH]: 0,
			},
			{
				[PRESERVE_WOUNDS_INITIALIZATION_OPTION]: true,
			},
		);

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

async function refreshRenderedActorSheet(actor) {
	const sheet = actor?.sheet;

	if (!sheet?.rendered) {
		return;
	}

	try {
		await sheet.render();
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to refresh Character sheet after Wounds permission change.",
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

function ownerWoundsEditPermissionChanged(changes) {
	if (!changes || typeof changes !== "object") {
		return false;
	}

	const path =
		`flags.${FLAG_SCOPE}.${OWNER_WOUNDS_EDIT_FLAG_KEY}`;

	if (Object.hasOwn(changes, path)) {
		return true;
	}

	return foundry.utils.getProperty(
		changes,
		path,
	) !== undefined;
}
