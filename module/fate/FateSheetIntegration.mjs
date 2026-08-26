import "../sheets/CharacterStatusUpdateGuard.mjs";

const FATE_INPUT_SELECTOR = "[data-wfrp-fate-value]";
const MAGIC_POINTS_SELECTOR = "[data-wfrp-magic-points]";
const POWER_LEVEL_SELECTOR = "[data-wfrp-power-level]";

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;

	if (!(actor instanceof foundry.documents.Actor) || actor.type !== "character") {
		return;
	}

	configureFateInput(actor, element);
	configureMagicResourceInput(
		application,
		element?.querySelector?.(MAGIC_POINTS_SELECTOR),
		"system.status.magicPoints",
	);
	configureMagicResourceInput(
		application,
		element?.querySelector?.(POWER_LEVEL_SELECTOR),
		"system.status.powerLevel",
	);
});

function configureFateInput(actor, element) {
	const input = element?.querySelector?.(FATE_INPUT_SELECTOR);
	if (!(input instanceof HTMLInputElement)) {
		return;
	}

	const editable = game.user?.isGM === true;
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;

	if (!editable) {
		return;
	}

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") {
			return;
		}

		event.preventDefault();
		input.blur();
	});

	input.addEventListener("change", () => {
		void persistFateValue(actor, input);
	});
}

/**
 * Restore the native ActorSheetV2 form contract for one Magic resource.
 *
 * ClassicActorSheet uses submitOnChange. These controls must therefore have
 * their canonical `name` attributes so every form submission carries their
 * current values. Persistence itself belongs to ActorSheetV2's normal form
 * lifecycle. CharacterStatusUpdateGuard preserves the complete native status
 * SchemaField while Foundry applies each partial form update.
 */
function configureMagicResourceInput(application, input, fieldName) {
	if (!(input instanceof HTMLInputElement)) {
		return;
	}

	input.name = fieldName;

	const editable = application?.isEditable === true;
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;

	if (!editable) {
		return;
	}

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") {
			return;
		}

		event.preventDefault();
		input.blur();
	});
}

async function persistFateValue(actor, input) {
	const previous = fateValue(actor);
	const value = Number(input.value);

	if (!Number.isInteger(value) || value < 0) {
		input.value = String(previous);
		ui.notifications.error(
			localize(
				"Fate Points must be a non-negative whole number.",
				"Punkty Przeznaczenia muszą być nieujemną liczbą całkowitą.",
			),
		);
		return;
	}

	try {
		await actor.update({
			"system.status.fate.value": value,
			"system.status.fate.max": value,
		});
	} catch (error) {
		input.value = String(previous);
		console.error("WFRP1ED | Unable to update Fate Points.", error);
		ui.notifications.error(
			error?.message ?? localize(
				"Unable to update Fate Points.",
				"Nie można zaktualizować Punktów Przeznaczenia.",
			),
		);
	}
}

function fateValue(actor) {
	const fate = actor?.system?.status?.fate;
	const raw = fate && typeof fate === "object" && !Array.isArray(fate)
		? fate.value
		: fate;
	const number = Number(raw);

	return Number.isInteger(number) && number >= 0 ? number : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
