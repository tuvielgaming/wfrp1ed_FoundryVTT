import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "characterCreationMode";
const TOGGLE_ACTION = "toggleCharacterCreationMode";
const FRAME_BUTTON_CLASS = "wfrp1ed-character-creation-toggle";

/**
 * Explicit per-Actor Character Creation Mode.
 *
 * This first integration deliberately establishes only the authoritative mode
 * state and its GM-facing sheet control. It does not yet bypass Experience,
 * progression or managed-edit rules. Those mechanics can consume this one flag
 * in later audited steps instead of inferring character creation from unrelated
 * history such as current spent Experience.
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

installCharacterCreationFrameControl();

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
				label: enabled
					? localize(
						"Disable Character Creation Mode",
						"Wyłącz Tryb tworzenia postaci",
					)
					: localize(
						"Enable Character Creation Mode",
						"Włącz Tryb tworzenia postaci",
					),
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

Hooks.on("updateActor", (actor, changes) => {
	if (!characterCreationFlagChanged(changes)) return;
	if (actor?.sheet?.rendered) void actor.sheet.render({ force: true });
});

function characterCreationFlagChanged(changes) {
	const path = `flags.${FLAG_SCOPE}.${FLAG_KEY}`;
	return Object.hasOwn(changes ?? {}, path) ||
		foundry.utils.getProperty(changes ?? {}, path) !== undefined;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
