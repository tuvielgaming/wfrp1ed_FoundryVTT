// import { prepareActiveEffectCategories } from "../helpers/effects.mjs";

// const { api, sheets } = foundry.applications;
// const DragDrop = foundry.applications.ux.DragDrop;
const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

// export class Wfrp1edItemSheet extends ItemSheet {
export class Wfrp1edItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	// export class Wfrp1edItemSheet extends HandlebarsApplicationMixin(
	// 	sheets.ItemSheetV2
	// ) {
	// static get defaultOptions() {
	// 	return foundry.utils.mergeObject(super.defaultOptions, {
	// 		classes: [],
	// 		width: 520,
	// 		height: 800,
	// 		tabs: [
	// 			{
	// 				navSelector: ".sheet-tabs",
	// 				contentSelector: ".sheet-body",
	// 				initial: "description",
	// 			},
	// 		],
	// 	});
	// }

	constructor(options = {}) {
		super(options);
	}

	static DEFAULT_OPTIONS = {
		id: "item-form",
		form: {
			template: "systems/wfrp1ed/templates/item/weapon-sheet.hbs",
			// handler: TemplateApplication.#onSubmit,
			closeOnSubmit: true,
		},
		position: {
			width: 520,
			height: 800,
		},
		tag: "form",
		window: {
			icon: "fas fa-gear",
			title: "FOO.form.title",
		},
	};

	// static TABS = {
	// 	navSelector: ".sheet-tabs",
	// 	contentSelector: ".sheet-body",
	// 	initial: "description",
	// };
	static TABS = {
		primary: {
			tabs: [{ id: "traits" }, { id: "aptitudes" }],
			labelPrefix: "MYSYS.tab", // Optional. Prepended to the id to generate a localization key
			initial: "traits", // Set the initial tab
		},
	};

	static PARTS = {
		header: {
			template: "systems/wfrp1ed/templates/item/weapon-sheet.hbs",
		},
	};

	/** @override */
	_configureRenderOptions(options) {
		super._configureRenderOptions(options);
		// Not all parts always render
		options.parts = ["header", "tabs", "description"];
		// Don't show the other tabs if only limited view
		// if (this.document.limited) return;
		// Control which parts show based on document subtype
		// switch (this.document.type) {
		// 	case "feature":
		// 		options.parts.push("attributesFeature", "effects");
		// 		break;
		// 	case "gear":
		// 		options.parts.push("attributesGear");
		// 		break;
		// 	case "spell":
		// 		options.parts.push("attributesSpell");
		// 		break;
		// }
	}

	get template() {
		const path = "systems/wfrp1ed/templates/item";

		return `${path}/${this.item.type}-sheet.hbs`;
	}

	// getData() {
	async _prepareContext(options) {
		const data = await super._prepareContext(options);
		// data.enrichedDescription = await TextEditor.enrichHTML(
		// 	this.object.system.description.value,
		// 	{ async: true }
		// );
		data.enrichedDescription = "";
		console.log("ItemData", data);

		if (this.item.type == "career") {
			console.log("ItemData", data);
			console.log("skills", typeof data.data.system.skills);
			data["skills"] = data.data.system.skills.join(", ").toString();
			data["earningSkills"] = data.data.system.incomeSkill.map(function (item) {
				return data.data.system.skills[item];
			});
			data["talents"] = data.data.system.talents.toString();
			data["trappings"] = data.data.system.trappings.toString();
			let characteristicList = duplicate(CONFIG.WFRP1ED.characteristicsAbbrev);
			for (let char in characteristicList) {
				if (data.data.system.characteristics.includes(char))
					characteristicList[char] = {
						abrev: CONFIG.WFRP1ED.characteristicsAbbrev[char],
						checked: true,
					};
				else
					characteristicList[char] = {
						abrev: CONFIG.WFRP1ED.characteristicsAbbrev[char],
						checked: false,
					};
			}
			data["characteristicList"] = characteristicList;
		}

		return data;
	}

	setPosition(options = {}) {
		const position = super.setPosition(options);
		const sheetBody = this.element.find(".sheet-body");
		const bodyHeight = position.height - 192;
		sheetBody.css("height", bodyHeight);
		return position;
	}

	// activateListeners(html) {
	// 	super.activateListeners(html);

	// 	if (!this.options.editable) return;

	// 	html.find(".rollable").click(this._onRoll.bind(this));
	// }
}
