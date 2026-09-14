import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "characterCreationMode";
const TOGGLE_ACTION = "toggleCharacterCreationMode";
const FRAME_BUTTON_CLASS = "wfrp1ed-character-creation-toggle";
const MODE_WINDOW_CLASS = "wfrp1ed-character-creation-mode";

/**
 * Explicit per-Actor Character Creation Mode.
 *
 * New Character Actors begin in this mode so the Race/Career creation workflow
 * is immediately available. The GM-facing sheet control remains authoritative
 * for leaving or re-entering the mode later; normal Experience progression is
 * deliberately not reinterpreted as character creation.
 */
export class CharacterCreationMode {
	static enabled(actor) {
		return actor?.documentName === "Actor" &&
			actor.type === "character" &&
			actor.getFlag?.(FLAG_SCOPE, FLAG_KEY) === true;
	}

	static canToggle(actor, user = game.user) {
		return Boolean(
			user?.isGM === true &&
			actor?.documentName === "Actor" &&
			actor.type === "character",
		);
	}

	static async set(actor, enabled) {
		if (!this.canToggle(actor, game.user)) {
			throw new Error(localize(
				"Only the GM can change Character Creation Mode.",
				"Tylko MG może zmienić Tryb tworzenia postaci.",
			));
		}

		const next = enabled === true;
		if (this.enabled(actor) === next) return next;
		await actor.setFlag(FLAG_SCOPE, FLAG_KEY, next);
		return next;
	}

	static async toggle(actor) {
		return this.set(actor, !this.enabled(actor));
	}
}

installNewCharacterDefault();
installCharacterCreationFrameControl();
installCharacterCreationPresentationSync();

/**
 * Character creation is the default lifecycle state of every newly-created PC.
 *
 * Foundry v14 explicitly defines Document._preCreate as the authoritative
 * lifecycle point for mutating pending document source data. Own this default
 * on the system Actor class instead of relying on a free-standing preCreateActor
 * hook. Existing Actors are never rewritten.
 */
function installNewCharacterDefault() {
	if (Wfrp1edActor.__wfrpCharacterCreationDefaultInstalled === true) return;

	const original = Wfrp1edActor.prototype._preCreate;
	if (typeof original !== "function") {
		console.error(
			"WFRP1ED | Wfrp1edActor has no _preCreate lifecycle; Character Creation default was not installed.",
		);
		return;
	}

	Wfrp1edActor.prototype._preCreate = async function wfrpCharacterCreationPreCreate(
		data,
		options,
		user,
	) {
		const result = await original.call(this, data, options, user);
		if (result === false) return false;
		if (this.type !== "character") return result;

		const existingFlags = foundry.utils.deepClone(this.flags ?? {});
		const systemFlags = {
			...(existingFlags?.[FLAG_SCOPE] ?? {}),
			[FLAG_KEY]: true,
		};

		this.updateSource({
			flags: {
				...existingFlags,
				[FLAG_SCOPE]: systemFlags,
			},
		});
		return result;
	};

	Object.defineProperty(
		Wfrp1edActor,
		"__wfrpCharacterCreationDefaultInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function installCharacterCreationFrameControl() {
	if (ClassicActorSheet.__wfrpCharacterCreationModeInstalled === true) return;

	ClassicActorSheet.DEFAULT_OPTIONS.actions ??= {};
	ClassicActorSheet.DEFAULT_OPTIONS.actions[TOGGLE_ACTION] = async function toggleCreationMode(
		event,
	) {
		event?.preventDefault?.();
		event?.stopPropagation?.();

		const actor = this.document;
		if (!CharacterCreationMode.canToggle(actor, game.user)) return;

		try {
			const enabled = await CharacterCreationMode.toggle(actor);
			syncCreationModePresentation(this);
			ui.notifications.info(enabled
				? localize(
					`Character Creation Mode enabled for ${actor.name}.`,
					`Włączono Tryb tworzenia postaci dla: ${actor.name}.`,
				)
				: localize(
					`Character Creation Mode disabled for ${actor.name}.`,
					`Wyłączono Tryb tworzenia postaci dla: ${actor.name}.`,
				));
		} catch (error) {
			console.error("WFRP1ED | Unable to toggle Character Creation Mode.", error);
			ui.notifications.error(error?.message ?? String(error));
		}
	};

	const original = ClassicActorSheet.prototype._getFrameButtons;
	if (typeof original !== "function") {
		console.error(
			"WFRP1ED | ClassicActorSheet has no _getFrameButtons method; Character Creation Mode header control was not installed.",
		);
		return;
	}

	ClassicActorSheet.prototype._getFrameButtons = function characterCreationFrameButtons(options) {
		const buttons = original.call(this, options) ?? [];
		const actor = this.document;
		if (!CharacterCreationMode.canToggle(actor, game.user)) return buttons;

		const enabled = CharacterCreationMode.enabled(actor);
		return [
			...buttons,
			{
				action: TOGGLE_ACTION,
				icon: "fa-solid fa-scroll",
				label: creationModeButtonLabel(enabled),
				visible: true,
				classes: `${FRAME_BUTTON_CLASS} ${enabled ? "is-active" : "is-inactive"}`,
			},
		];
	};

	Object.defineProperty(
		ClassicActorSheet,
		"__wfrpCharacterCreationModeInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/**
 * Do not derive the whole-window highlight from the frame button DOM. Foundry
 * can keep the already-rendered frame button while rerendering only the sheet
 * content, which made the button class/tooltip stale after toggling the Actor
 * flag. Instead, copy the authoritative Actor flag onto the Application root
 * on every render and immediately after the toggle action.
 */
function installCharacterCreationPresentationSync() {
	Hooks.on("renderApplicationV2", (application) => {
		if (!isClassicCharacterSheet(application)) return;
		syncCreationModePresentation(application);
	});
}

function syncCreationModePresentation(application) {
	if (!isClassicCharacterSheet(application)) return;
	const root = asElement(application?.element);
	if (!(root instanceof HTMLElement)) return;

	const enabled = CharacterCreationMode.enabled(application.document);
	root.classList.toggle(MODE_WINDOW_CLASS, enabled);

	/* Keep the already-rendered frame control visually and textually in sync as
	 * well. This is presentation only; the Actor flag remains the sole state. */
	const button = root.querySelector(`[data-action="${TOGGLE_ACTION}"]`);
	if (!(button instanceof HTMLElement)) return;
	button.classList.add(FRAME_BUTTON_CLASS);
	button.classList.toggle("is-active", enabled);
	button.classList.toggle("is-inactive", !enabled);

	const label = creationModeButtonLabel(enabled);
	button.title = label;
	button.setAttribute("aria-label", label);
	button.dataset.tooltip = label;
}

function isClassicCharacterSheet(application) {
	const actor = application?.document;
	return application instanceof ClassicActorSheet &&
		actor?.documentName === "Actor" &&
		actor.type === "character";
}

Hooks.on("updateActor", (actor, changes) => {
	if (!characterCreationFlagChanged(changes)) return;
	const sheet = actor?.sheet;
	if (!(sheet instanceof ClassicActorSheet)) return;
	syncCreationModePresentation(sheet);
	if (sheet.rendered) void sheet.render({ force: true });
});

function characterCreationFlagChanged(changes) {
	const path = `flags.${FLAG_SCOPE}.${FLAG_KEY}`;
	return Object.hasOwn(changes ?? {}, path) ||
		foundry.utils.getProperty(changes ?? {}, path) !== undefined;
}

function creationModeButtonLabel(enabled) {
	return enabled
		? localize(
			"Disable Character Creation Mode",
			"Wyłącz Tryb tworzenia postaci",
		)
		: localize(
			"Enable Character Creation Mode",
			"Włącz Tryb tworzenia postaci",
		);
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") {
		return value;
	}
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") {
		return value[0];
	}
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
