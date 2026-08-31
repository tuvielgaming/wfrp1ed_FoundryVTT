const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class DiseaseItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: ["wfrp1ed", "sheet", "item", "disease-item-sheet", "wfrp1ed-parchment-window"],
		position: { width: 620, height: 700 },
		tag: "form",
		form: { submitOnChange: true, closeOnSubmit: false },
	};

	static PARTS = { form: { template: "systems/wfrp1ed/templates/item/disease-sheet.hbs" } };

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		context.item = this.document;
		context.system = this.document.system;
		context.editable = this.isEditable;
		context.ui = {
			name: localize("Name", "Nazwa"),
			rulesId: localize("Rules ID", "Identyfikator reguły"),
			rulesIdHint: localize("Stable language-neutral identifier used by rules and references.", "Stały, niezależny od języka identyfikator używany przez reguły i odwołania."),
			exposure: localize("Exposure / transmission", "Narażenie / sposób zarażenia"),
			testModifier: localize("Disease Test modifier", "Modyfikator Testu Choroby"),
			testModifierHint: localize("Base modifier from the disease description. Situational modifiers remain part of the actual Disease Test.", "Bazowy modyfikator z opisu choroby. Modyfikatory sytuacyjne pozostają częścią właściwego Testu Choroby."),
			incubation: localize("Incubation", "Okres inkubacji"),
			duration: localize("Duration", "Czas trwania"),
			formulaHint: localize("Use a Foundry roll formula when the Core rule gives one, for example 2d10.", "Użyj formuły rzutu Foundry, gdy zasada podręcznika ją podaje, np. 2d10."),
			symptoms: localize("Symptoms / effects", "Objawy / skutki"),
			recovery: localize("Recovery", "Wyzdrowienie"),
			description: localize("Additional rules / notes", "Dodatkowe zasady / uwagi"),
		};
		return context;
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
