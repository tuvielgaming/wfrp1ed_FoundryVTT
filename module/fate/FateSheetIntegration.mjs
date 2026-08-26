const FATE_INPUT_SELECTOR = "[data-wfrp-fate-value]";
const MAGIC_POINTS_SELECTOR = "input[name=\"system.status.magicPoints\"]";
const POWER_LEVEL_SELECTOR = "input[name=\"system.status.powerLevel\"]";

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;

	if (!(actor instanceof foundry.documents.Actor) || actor.type !== "character") {
		return;
	}

	configureFateInput(actor, element);
	configureMagicResourceInput(
		application,
		actor,
		element?.querySelector?.(MAGIC_POINTS_SELECTOR),
		"system.status.magicPoints",
		"Magic Points",
		"Punkty Magii",
	);
	configureMagicResourceInput(
		application,
		actor,
		element?.querySelector?.(POWER_LEVEL_SELECTOR),
		"system.status.powerLevel",
		"Power Level",
		"Poziom Mocy",
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

function configureMagicResourceInput(
	application,
	actor,
	input,
	path,
	englishLabel,
	polishLabel,
) {
	if (!(input instanceof HTMLInputElement)) {
		return;
	}

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

	input.addEventListener("change", () => {
		void persistMagicResource(
			actor,
			input,
			path,
			englishLabel,
			polishLabel,
		);
	});
}

async function persistMagicResource(
	actor,
	input,
	path,
	englishLabel,
	polishLabel,
) {
	const previous = nonNegativeInteger(
		foundry.utils.getProperty(actor, path),
	);
	const value = Number(input.value);

	if (!Number.isInteger(value) || value < 0) {
		input.value = String(previous);
		ui.notifications.error(
			localize(
				`${englishLabel} must be a non-negative whole number.`,
				`${polishLabel} muszą być nieujemną liczbą całkowitą.`,
			),
		);
		return;
	}

	try {
		await actor.update({ [path]: value });
	} catch (error) {
		input.value = String(previous);
		console.error(
			`WFRP1ED | Unable to update ${englishLabel}.`,
			error,
		);
		ui.notifications.error(
			error?.message ?? localize(
				`Unable to update ${englishLabel}.`,
				`Nie można zaktualizować: ${polishLabel}.`,
			),
		);
	}
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
		/*
		 * CharacterData still accepts the transitional {value,max} storage.
		 * WFRP 1e has only one Fate Points resource, so the sheet deliberately
		 * exposes one value and keeps the compatibility maximum synchronized.
		 */
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

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 0 ? number : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
