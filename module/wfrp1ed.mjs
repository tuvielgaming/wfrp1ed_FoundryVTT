import { CharacterData } from "./data-models/actor/CharacterData.mjs";
import { Wfrp1edActor } from "./documents/Wfrp1edActor.mjs";
import { Wfrp1edItem } from "./documents/Wfrp1edItem.mjs";
import { WFRP1ED } from "./helpers/config.mjs";
import { ClassicActorSheet } from "./sheets/ClassicActorSheet.mjs";
import { TestManager } from "./tests/TestManager.mjs";
import { STANDARD_TESTS } from "./tests/standard-tests.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { loadTemplates } = foundry.applications.handlebars;
const { Actor } = foundry.documents;

Hooks.once("init", async () => {
	console.info("WFRP1ED | Initializing WFRP 1st Edition");

	configureSystem();
	registerHandlebarsHelpers();
	registerStandardTests();
	registerDocumentSheets();
	exposeSystemApi();

	await loadTemplates(WFRP1ED.partialTemplates);
});

/**
 * Configure the system's custom Documents and native Foundry v14 data models.
 *
 * Only the Character Actor model is registered at this stage. Other Actor and
 * Item subtypes must remain on their temporary data contracts until dedicated
 * TypeDataModels have been implemented and audited.
 *
 * @returns {void}
 */
function configureSystem() {
	CONFIG.WFRP1ED = WFRP1ED;

	CONFIG.Actor.documentClass = Wfrp1edActor;
	CONFIG.Item.documentClass = Wfrp1edItem;

	CONFIG.Actor.dataModels.character = CharacterData;
}

/**
 * Register the audited Classic Character sheet.
 *
 * Core Foundry sheets remain registered for document subtypes which do not yet
 * have an audited WFRP1ED sheet implementation.
 *
 * @returns {void}
 */
function registerDocumentSheets() {
	DocumentSheetConfig.registerSheet(
		Actor,
		game.system.id,
		ClassicActorSheet,
		{
			types: ["character"],
			makeDefault: true,
		},
	);
}

/**
 * Register all currently available test definitions.
 *
 * Definition mechanics are validated separately in standard-tests.mjs.
 *
 * @returns {void}
 */
function registerStandardTests() {
	for (const definition of Object.values(STANDARD_TESTS)) {
		TestManager.register(definition);
	}
}

/**
 * Expose the supported public API for macros, modules, and future optional
 * rules packages.
 *
 * @returns {void}
 */
function exposeSystemApi() {
	game.WFRP1ED = Object.freeze({
		config: WFRP1ED,

		dataModels: Object.freeze({
			Character: CharacterData,
		}),

		documents: Object.freeze({
			Actor: Wfrp1edActor,
			Item: Wfrp1edItem,
		}),

		tests: Object.freeze({
			manager: TestManager,
			definitions: STANDARD_TESTS,
		}),
	});
}

/**
 * Register the small set of project-specific Handlebars helpers.
 *
 * Mechanical calculations do not belong in these helpers.
 *
 * @returns {void}
 */
function registerHandlebarsHelpers() {
	Handlebars.registerHelper(
		"times",
		function times(value, options) {
			const count = Math.max(
				0,
				Math.trunc(Number(value) || 0),
			);

			let output = "";

			for (
				let index = 0;
				index < count;
				index += 1
			) {
				const data = Handlebars.createFrame(
					options.data,
				);

				data.index = index;

				output += options.fn(this, {
					data,
				});
			}

			return output;
		},
	);

	Handlebars.registerHelper(
		"add",
		(first, second) => {
			const firstNumber = Number(first);
			const secondNumber = Number(second);

			if (
				!Number.isFinite(firstNumber) ||
				!Number.isFinite(secondNumber)
			) {
				return 0;
			}

			return firstNumber + secondNumber;
		},
	);
}