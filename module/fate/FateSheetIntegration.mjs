import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

const FATE_INPUT_SELECTOR = "[data-wfrp-fate-value]";
const MAGIC_POINTS_SELECTOR = "[data-wfrp-magic-points]";
const POWER_LEVEL_SELECTOR = "[data-wfrp-power-level]";

const MAGIC_RESOURCE_FIELDS = Object.freeze(new Map([
	[
		MAGIC_POINTS_SELECTOR,
		Object.freeze({
			path: "system.status.magicPoints",
			englishLabel: "Magic Points",
			polishLabel: "Punkty Magii",
		}),
	],
	[
		POWER_LEVEL_SELECTOR,
		Object.freeze({
			path: "system.status.powerLevel",
			englishLabel: "Power Level",
			polishLabel: "Poziom Mocy",
		}),
	],
]));

installMagicResourceFormPersistence();

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;

	if (!(actor instanceof foundry.documents.Actor) || actor.type !== "character") {
		return;
	}

	configureFateInput(actor, element);
	configureMagicResourceInput(
		application,
		element?.querySelector?.(MAGIC_POINTS_SELECTOR),
	);
	configureMagicResourceInput(
		application,
		element?.querySelector?.(POWER_LEVEL_SELECTOR),
	);
});

/**
 * Persist the two explicitly-owned magic resources from the native
 * ApplicationV2 form-change lifecycle.
 *
 * ClassicActorSheet uses submitOnChange. The Magic inputs deliberately have no
 * `name` attribute so they do not participate in generic FormData submission.
 * Therefore their update must be intercepted here, before the inherited
 * DocumentSheetV2 change handler submits the rest of the form and rerenders the
 * Actor sheet.
 */
function installMagicResourceFormPersistence() {
	if (ClassicActorSheet.prototype.__wfrpMagicResourcePersistenceInstalled === true) {
		return;
	}

	const originalOnChangeForm = ClassicActorSheet.prototype._onChangeForm;
	if (typeof originalOnChangeForm !== "function") {
		throw new Error(
			"WFRP1ED | ClassicActorSheet has no _onChangeForm method; " +
				"Magic resource persistence cannot be installed.",
		);
	}

	ClassicActorSheet.prototype._onChangeForm = function wfrpMagicResourceChange(
		formConfig,
		event,
	) {
		const input = event?.target;
		const field = magicResourceField(input);

		if (!field) {
			return originalOnChangeForm.call(this, formConfig, event);
		}

		if (this.isEditable !== true || !(input instanceof HTMLInputElement)) {
			return;
		}

		/*
		 * This control has one persistence owner: this native change handler.
		 * Do not invoke the inherited generic form submission for it.
		 */
		event?.preventDefault?.();
		event?.stopPropagation?.();

		void persistMagicResource(
			this.document,
			input,
			field.path,
			field.englishLabel,
			field.polishLabel,
		);
	};

	Object.defineProperty(
		ClassicActorSheet.prototype,
		"__wfrpMagicResourcePersistenceInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function magicResourceField(input) {
	if (!(input instanceof HTMLInputElement)) return null;

	for (const [selector, field] of MAGIC_RESOURCE_FIELDS) {
		if (input.matches(selector)) return field;
	}

	return null;
}

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

function configureMagicResourceInput(application, input) {
	if (!(input instanceof HTMLInputElement)) {
		return;
	}

	const editable = application?.isEditable === true;
	input.readOnly = !editable;
	input.tabIndex = editable ? 0 : -1;

	if (!editable) {
		return;
	}

	/* Enter commits through the same native change lifecycle as leaving focus. */
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") {
			return;
		}

		event.preventDefault();
		input.blur();
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
		/*
		 * CharacterPartialMigrationFix makes dotted Character updates safe during
		 * Foundry's partial data migration, so persist the exact canonical field
		 * rather than replacing the whole status SchemaField.
		 */
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
