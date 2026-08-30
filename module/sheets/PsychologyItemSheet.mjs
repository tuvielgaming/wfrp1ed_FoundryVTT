const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

/** Native Foundry v14 sheet for reusable WFRP 1e Psychology Items. */
export class PsychologyItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"psychology-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: { width: 560, height: 500 },
		tag: "form",
		form: { submitOnChange: true, closeOnSubmit: false },
	};

	static PARTS = {
		form: { template: "systems/wfrp1ed/templates/item/psychology-sheet.hbs" },
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		context.item = this.document;
		context.system = this.document.system;
		context.editable = this.isEditable;
		context.ui = {
			name: localize("Name", "Nazwa"),
			rulesId: localize("Rules ID", "Identyfikator reguły"),
			rulesIdHint: localize(
				"Stable language-neutral identifier used by rules and references. Example: hatred-orcs, fear-undead.",
				"Stały, niezależny od języka identyfikator używany przez reguły i odwołania. Przykład: hatred-orcs, fear-undead.",
			),
			description: localize("Description / rules", "Opis / zasady"),
		};
		return context;
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
