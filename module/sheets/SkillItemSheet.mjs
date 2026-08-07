const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } =
	foundry.applications.api;

/**
 * Native Foundry v14 sheet for WFRP 1e Skill Items.
 *
 * The sheet edits only data owned by SkillData:
 *
 * - Item.name
 * - system.specialisation
 * - system.description
 *
 * Skill-specific mechanics are deliberately not implemented here. Individual
 * skills can later receive audited automation without forcing every WFRP 1e
 * skill into one generic test contract.
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

		return context;
	}
}