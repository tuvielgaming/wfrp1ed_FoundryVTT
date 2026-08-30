const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

/** Native Foundry v14 sheet for reusable WFRP 1e Language Items. */
export class LanguageItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"language-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 560,
			height: 500,
		},
		tag: "form",
		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},
	};

	static PARTS = {
		form: {
			template: "systems/wfrp1ed/templates/item/language-sheet.hbs",
		},
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
				"Stable language-neutral identifier used by rules and references. Example: reikspiel, khazalid, eltharin.",
				"Stały, niezależny od języka identyfikator używany przez reguły i odwołania. Przykład: reikspiel, khazalid, eltharin.",
			),
			description: localize("Description", "Opis"),
		};
		return context;
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
