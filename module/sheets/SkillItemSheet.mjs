import {
	STANDARD_TEST_SKILL_IDENTITIES,
} from "../tests/standard-test-skill-identities.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } =
	foundry.applications.api;

/**
 * Native Foundry v14 sheet for WFRP 1e Skill Items.
 *
 * The sheet edits only data owned by SkillData:
 *
 * - Item.name
 * - system.rulesId
 * - system.specialisation
 * - system.description
 *
 * `system.rulesId` is a language-neutral mechanical identity. It is selected
 * from an audited catalog rather than typed freehand so localized or renamed
 * Skill Items can participate in Standard Tests without brittle name matching.
 */
export class SkillItemSheet extends HandlebarsApplicationMixin(
	ItemSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"skill-item-sheet",
			"wfrp1ed-parchment-window",
		],

		position: {
			width: 560,
			height: 520,
		},

		tag: "form",

		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},
	};

	static PARTS = {
		form: {
			template:
				"systems/wfrp1ed/templates/item/skill-sheet.hbs",
		},
	};

	/**
	 * Prepare the Skill Item rendering context.
	 *
	 * The native Item Document remains the persistent source. No presentation
	 * copy is allowed to become an alternative data owner.
	 *
	 * @param {Object} options
	 * @returns {Promise<Object>}
	 */
	async _prepareContext(options) {
		const context =
			await super._prepareContext(options);

		context.item = this.document;
		context.system = this.document.system;
		context.editable = this.isEditable;
		context.rulesIdOptions = buildRulesIdOptions(
			this.document.system?.rulesId,
		);

		return context;
	}
}

/**
 * Build localized, immutable options for the audited Skill rules identity.
 *
 * The blank option is intentional: custom Skills and core Skills which are not
 * yet part of Standard Test automation remain valid Skill Items. If an Item
 * contains a non-empty unknown id, preserve it as a selected option so opening
 * and submitting the sheet cannot silently erase data from a future or
 * external rules package.
 *
 * @param {string} currentRulesId
 * @returns {readonly Object[]}
 */
function buildRulesIdOptions(currentRulesId) {
	const currentId = String(currentRulesId ?? "").trim();

	const options = Object.entries(
		STANDARD_TEST_SKILL_IDENTITIES,
	).map(([value, identity]) => ({
		value,
		label: localizeWithFallback(
			identity.labelKey,
			identity.label,
		),
		selected: value === currentId,
	}));

	options.sort((first, second) =>
		first.label.localeCompare(
			second.label,
			game.i18n.lang,
			{ sensitivity: "base" },
		),
	);

	const result = [
		{
			value: "",
			label: game.i18n.localize(
				"WFRP1ED.SkillSheet.RulesIdUnlinked",
			),
			selected: currentId.length === 0,
		},
		...options,
	];

	if (
		currentId &&
		!STANDARD_TEST_SKILL_IDENTITIES[currentId]
	) {
		result.splice(1, 0, {
			value: currentId,
			label: game.i18n.format(
				"WFRP1ED.SkillSheet.RulesIdUnknown",
				{ id: currentId },
			),
			selected: true,
		});
	}

	return Object.freeze(
		result.map((option) => Object.freeze(option)),
	);
}

/**
 * Localize one catalog label while preserving the audited English name as a
 * safe fallback during development or third-party localization work.
 *
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function localizeWithFallback(key, fallback) {
	const localized = game.i18n.localize(key);

	return localized === key
		? fallback
		: localized;
}
