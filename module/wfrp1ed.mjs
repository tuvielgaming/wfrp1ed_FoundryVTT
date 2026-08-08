import { CharacterData } from "./data-models/actor/CharacterData.mjs";
import { SkillData } from "./data-models/item/SkillData.mjs";
import { Wfrp1edActor } from "./documents/Wfrp1edActor.mjs";
import { Wfrp1edItem } from "./documents/Wfrp1edItem.mjs";
import { WFRP1ED } from "./helpers/config.mjs";
import { ClassicActorSheet } from "./sheets/ClassicActorSheet.mjs";
import { SkillItemSheet } from "./sheets/SkillItemSheet.mjs";
import { NAMED_STANDARD_TESTS } from "./tests/named-standard-tests.mjs";
import { PendingStandardTest } from "./tests/PendingStandardTest.mjs";
import { StandardTestSkillResolver } from "./tests/StandardTestSkillResolver.mjs";
import { TestManager } from "./tests/TestManager.mjs";
import { TestResultChat } from "./tests/TestResultChat.mjs";
import {
	STANDARD_TEST_SKILL_RULES,
} from "./tests/standard-test-skill-rules.mjs";
import { STANDARD_TESTS } from "./tests/standard-tests.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { loadTemplates } = foundry.applications.handlebars;
const { Actor, Item } = foundry.documents;

Hooks.once("init", async () => {
	console.info("WFRP1ED | Initializing WFRP 1st Edition");

	configureSystem();
	registerHandlebarsHelpers();
	registerStandardTests();
	registerDocumentSheets();
	registerChatHooks();
	exposeSystemApi();

	await loadTemplates(WFRP1ED.partialTemplates);
});

/**
 * Configure the system's custom Documents and native Foundry v14 data models.
 *
 * The Character Actor and Skill Item models are currently registered.
 * Other Actor and Item subtypes must remain on their temporary data contracts
 * until dedicated TypeDataModels have been implemented and audited.
 *
 * @returns {void}
 */
function configureSystem() {
	CONFIG.WFRP1ED = WFRP1ED;

	CONFIG.Actor.documentClass = Wfrp1edActor;
	CONFIG.Item.documentClass = Wfrp1edItem;

	CONFIG.Actor.dataModels.character = CharacterData;
	CONFIG.Item.dataModels.skill = SkillData;
}

/**
 * Register audited WFRP1ED Document sheets.
 *
 * The Classic sheet owns Character Actors.
 * SkillItemSheet owns Skill Items.
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

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		SkillItemSheet,
		{
			types: ["skill"],
			makeDefault: true,
		},
	);
}

/**
 * Register all currently executable test definitions.
 *
 * `STANDARD_TESTS` contains the direct characteristic tests used by clicks on
 * the current profile row. `NAMED_STANDARD_TESTS` contains the audited named
 * Standard Tests whose targets can be expressed by the current TestContext and
 * FormulaResolver contracts.
 *
 * Special procedures such as Gambling, Employment, Busking and Movement are
 * deliberately not registered until their complete execution contracts exist.
 *
 * @returns {void}
 */
function registerStandardTests() {
	const definitions = [
		...Object.values(STANDARD_TESTS),
		...Object.values(NAMED_STANDARD_TESTS),
	];

	for (const definition of definitions) {
		TestManager.register(definition);
	}
}

/**
 * Attach interaction to rendered WFRP1ED ChatMessages.
 *
 * Pending Standard Tests expose GM target-resolution controls. Completed test
 * results expose the general adjudication modifier as a GM-editable value while
 * all clients share the same persisted message content and result snapshot.
 *
 * @returns {void}
 */
function registerChatHooks() {
	Hooks.on(
		"renderChatMessageHTML",
		(message, html) => {
			PendingStandardTest.activateListeners(
				message,
				html,
			);

			TestResultChat.activateListeners(
				message,
				html,
			);
		},
	);
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
			Skill: SkillData,
		}),

		documents: Object.freeze({
			Actor: Wfrp1edActor,
			Item: Wfrp1edItem,
		}),

		tests: Object.freeze({
			manager: TestManager,

			/*
			 * `definitions` is preserved for compatibility with callers which
			 * already use it for direct characteristic tests.
			 */
			definitions: STANDARD_TESTS,
			characteristicDefinitions: STANDARD_TESTS,
			standardDefinitions: NAMED_STANDARD_TESTS,
			standardSkillRules: STANDARD_TEST_SKILL_RULES,
			standardSkillResolver: StandardTestSkillResolver,
			pendingStandardTest: PendingStandardTest,
			resultChat: TestResultChat,
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
