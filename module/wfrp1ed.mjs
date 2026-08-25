import { CombatAttackEconomy } from "./combat/CombatAttackEconomy.mjs";
import { CharacterData } from "./data-models/actor/CharacterData.mjs";
import { CriticalWoundData } from "./data-models/item/CriticalWoundData.mjs";
import { SkillData } from "./data-models/item/SkillData.mjs";
import { Wfrp1edActor } from "./documents/Wfrp1edActor.mjs";
import { Wfrp1edCombat } from "./documents/Wfrp1edCombat.mjs";
import { Wfrp1edItem } from "./documents/Wfrp1edItem.mjs";
import {
	configureWfrpRuleEffectType,
	RULE_EFFECT_APPLICABILITY,
	RULE_EFFECT_OPERATIONS,
	RULE_EFFECT_SIDES,
	RuleEffectRegistry,
} from "./effects/RuleEffectRegistry.mjs";
import { RuleEffectResolver } from "./effects/RuleEffectResolver.mjs";
import {
	DAMAGE_AMOUNT_MODIFIER_TARGET_ID,
	DAMAGE_ARMOUR_PENETRATION_TARGET_ID,
	DAMAGE_IGNORE_ARMOUR_TARGET_ID,
	DAMAGE_IGNORE_TOUGHNESS_TARGET_ID,
	DAMAGE_UNMITIGATED_MODIFIER_TARGET_ID,
} from "./damage/DamageRuleEffects.mjs";
import {
	PERIODIC_DIRECT_DAMAGE_TARGET_ID,
} from "./damage/PeriodicDirectDamageRule.mjs";
import { WFRP1ED } from "./helpers/config.mjs";
import { ClassicActorSheet } from "./sheets/ClassicActorSheet.mjs";
import { CriticalWoundItemSheet } from "./sheets/CriticalWoundItemSheet.mjs";
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

const PROFILE_FORMULA_VARIABLES = new Set([
	"m",
	"sp",
	"ws",
	"bs",
	"s",
	"t",
	"w",
	"i",
	"a",
	"dex",
	"ld",
	"int",
	"cl",
	"wp",
	"fel",
]);

Hooks.once("init", async () => {
	console.info("WFRP1ED | Initializing WFRP 1st Edition");

	configureSystem();
	configureWfrpRuleEffectType();
	registerHandlebarsHelpers();
	registerStandardTests();
	registerRuleEffectTargets();
	registerDocumentSheets();
	registerChatHooks();
	exposeSystemApi();

	await loadTemplates(WFRP1ED.partialTemplates);
});

/**
 * Configure the system's custom Documents and native Foundry v14 data models.
 *
 * Character, Skill, and Critical Wound now have explicit native TypeDataModels.
 * Combat uses a custom document only for audited WFRP round/turn lifecycle
 * state. Other Actor and Item subtypes remain on their temporary data contracts
 * until their own dependency-ordered audits are complete.
 *
 * @returns {void}
 */
function configureSystem() {
	CONFIG.WFRP1ED = WFRP1ED;

	CONFIG.Actor.documentClass = Wfrp1edActor;
	CONFIG.Combat.documentClass = Wfrp1edCombat;
	CONFIG.Item.documentClass = Wfrp1edItem;

	CONFIG.Actor.dataModels.character = CharacterData;
	CONFIG.Item.dataModels.skill = SkillData;
	CONFIG.Item.dataModels.criticalWound = CriticalWoundData;
}

/**
 * Register audited WFRP1ED Document sheets.
 *
 * The Classic sheet owns Character Actors. Dedicated native ItemSheetV2
 * implementations own Skill and Critical Wound Items. Core Foundry sheets
 * remain available for document subtypes which have not yet been audited.
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

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		CriticalWoundItemSheet,
		{
			types: ["criticalWound"],
			makeDefault: true,
		},
	);
}

/**
 * Register all currently executable percentile test definitions.
 *
 * `STANDARD_TESTS` contains direct characteristic tests used by clicks on the
 * current profile row. `NAMED_STANDARD_TESTS` contains audited named Standard
 * Tests whose targets can be expressed by TestContext/FormulaResolver.
 *
 * Non-d100 procedures such as movement remain outside TestManager even though
 * they can share the Standard Test launcher.
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
 * Register stable rule parameters which current subsystems can consume from
 * declarative Active Effects.
 *
 * Item authors select these localized targets rather than typing arbitrary data
 * paths. Future combat/damage/healing/magic subsystems extend this same registry
 * when their contracts exist.
 *
 * @returns {void}
 */
function registerRuleEffectTargets() {
	for (const test of TestManager.all()) {
		const isCharacteristic = test.tags.includes("characteristic");
		const isStandard = test.tags.includes("standard");

		if (!isCharacteristic && !isStandard) {
			continue;
		}

		RuleEffectRegistry.registerTarget({
			id: isCharacteristic
				? `test.characteristic.${test.id}.target`
				: `test.standard.${test.id}.target`,
			category: isCharacteristic
				? "test-characteristic"
				: "test-standard",
			label: test.label,
			labelKey: test.labelKey,
			sides: [
				RULE_EFFECT_SIDES.SELF,
				RULE_EFFECT_SIDES.TARGET,
				RULE_EFFECT_SIDES.OPPONENT,
			],
			operations: [
				RULE_EFFECT_OPERATIONS.ADD,
				RULE_EFFECT_OPERATIONS.SUBTRACT,
				RULE_EFFECT_OPERATIONS.OVERRIDE,
			],
			metadata: {
				consumer: "test",
				testId: test.id,
				testKind: isCharacteristic
					? "characteristic"
					: "standard",
			},
		});
	}

	RuleEffectRegistry.registerTarget({
		id: "procedure.movement.jump.reductionDie",
		category: "procedure-movement",
		label: "Jumping: damage-reduction d6",
		labels: {
			pl: "Zeskok: K6 redukcji obrażeń",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [
			RULE_EFFECT_OPERATIONS.ADD,
			RULE_EFFECT_OPERATIONS.SUBTRACT,
		],
		metadata: {
			consumer: "movement",
			procedureId: "jump",
			parameter: "reductionDie",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: "procedure.movement.leap.distance",
		category: "procedure-movement",
		label: "Leaping: achieved distance",
		labels: {
			pl: "Skok: osiągnięty dystans",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [
			RULE_EFFECT_OPERATIONS.ADD,
			RULE_EFFECT_OPERATIONS.SUBTRACT,
		],
		metadata: {
			consumer: "movement",
			procedureId: "leap",
			parameter: "distance",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: DAMAGE_AMOUNT_MODIFIER_TARGET_ID,
		category: "damage",
		label: "Damage modifier",
		labels: {
			pl: "Modyfikator obrażeń",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [
			RULE_EFFECT_OPERATIONS.ADD,
			RULE_EFFECT_OPERATIONS.SUBTRACT,
		],
		applicabilities: [RULE_EFFECT_APPLICABILITY.AUTOMATIC],
		metadata: {
			consumer: "damage",
			parameter: "damageModifier",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: DAMAGE_ARMOUR_PENETRATION_TARGET_ID,
		category: "damage",
		label: "Armour penetration",
		labels: {
			pl: "Przebicie pancerza",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [
			RULE_EFFECT_OPERATIONS.ADD,
			RULE_EFFECT_OPERATIONS.SUBTRACT,
		],
		applicabilities: [RULE_EFFECT_APPLICABILITY.AUTOMATIC],
		metadata: {
			consumer: "damage",
			parameter: "armourPenetration",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: DAMAGE_UNMITIGATED_MODIFIER_TARGET_ID,
		category: "damage",
		label: "Direct damage",
		labels: {
			pl: "Obrażenia bezpośrednie",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [
			RULE_EFFECT_OPERATIONS.ADD,
			RULE_EFFECT_OPERATIONS.SUBTRACT,
		],
		applicabilities: [RULE_EFFECT_APPLICABILITY.AUTOMATIC],
		metadata: {
			consumer: "damage",
			parameter: "unmitigatedDamageModifier",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: DAMAGE_IGNORE_ARMOUR_TARGET_ID,
		category: "damage",
		label: "Ignore Armour",
		labels: {
			pl: "Ignorowanie pancerza",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [RULE_EFFECT_OPERATIONS.GRANT],
		applicabilities: [RULE_EFFECT_APPLICABILITY.AUTOMATIC],
		valueRequired: false,
		metadata: {
			consumer: "damage",
			parameter: "armourPolicy",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: DAMAGE_IGNORE_TOUGHNESS_TARGET_ID,
		category: "damage",
		label: "Ignore Toughness",
		labels: {
			pl: "Ignorowanie Wytrzymałości",
		},
		sides: [RULE_EFFECT_SIDES.SELF],
		operations: [RULE_EFFECT_OPERATIONS.GRANT],
		applicabilities: [RULE_EFFECT_APPLICABILITY.AUTOMATIC],
		valueRequired: false,
		metadata: {
			consumer: "damage",
			parameter: "toughnessPolicy",
		},
	});

	RuleEffectRegistry.registerTarget({
		id: PERIODIC_DIRECT_DAMAGE_TARGET_ID,
		category: "damage",
		label: "Periodic direct damage",
		labels: {
			pl: "Okresowe obrażenia bezpośrednie",
		},
		sides: [RULE_EFFECT_SIDES.TARGET],
		operations: [RULE_EFFECT_OPERATIONS.ADD],
		applicabilities: [RULE_EFFECT_APPLICABILITY.AUTOMATIC],
		metadata: {
			consumer: "periodicDirectDamage",
			parameter: "damagePerRound",
		},
	});
}

/**
 * Attach interaction and context-menu controls to WFRP1ED ChatMessages.
 *
 * Pending Standard Tests expose GM target-resolution controls. Completed test
 * results expose the GM-editable general modifier and apply their own persisted
 * detail-visibility setting per client. The GM can also change that visibility
 * later from the ChatMessage right-click menu.
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

			TestResultChat.applyClientVisibility(
				message,
				html,
			);
		},
	);

	Hooks.on(
		"getChatMessageContextOptions",
		(_application, menuItems) => {
			TestResultChat.addContextMenuOptions(menuItems);
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
			CriticalWound: CriticalWoundData,
		}),

		documents: Object.freeze({
			Actor: Wfrp1edActor,
			Combat: Wfrp1edCombat,
			Item: Wfrp1edItem,
		}),

		combat: Object.freeze({
			attacks: CombatAttackEconomy,
		}),

		effects: Object.freeze({
			registry: RuleEffectRegistry,
			resolver: RuleEffectResolver,
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

	Handlebars.registerHelper(
		"wfrpIsTargetVariable",
		(key) => String(key ?? "")
			.trim()
			.toLowerCase()
			.startsWith("target."),
	);

	Handlebars.registerHelper(
		"wfrpTargetDisplay",
		(value, characteristic, variables) => {
			const numeric = Number(value);
			const display = Number.isFinite(numeric)
				? String(numeric)
				: String(value ?? "");

			return isPureChanceTarget(
				characteristic,
				variables,
			)
				? `${display}%`
				: display;
		},
	);
}

/**
 * Identify a target expressed directly as a percentage chance rather than as
 * a profile-characteristic calculation.
 *
 * Constant formulas such as Risk and chance inputs such as Listen qualify.
 * Any formula which references the acting profile, Movement, or an opponent
 * profile remains a normal characteristic-derived target display.
 *
 * @param {Object|null|undefined} characteristic
 * @param {Array<Object>|null|undefined} variables
 * @returns {boolean}
 */
function isPureChanceTarget(characteristic, variables) {
	if (characteristic) {
		return false;
	}

	const entries = Array.isArray(variables)
		? variables
		: [];

	return !entries.some((entry) => {
		const key = String(entry?.key ?? "")
			.trim()
			.toLowerCase();

		if (!key) {
			return false;
		}

		if (key.startsWith("target.")) {
			return true;
		}

		return (
			PROFILE_FORMULA_VARIABLES.has(key) ||
			key === "movement"
		);
	});
}
