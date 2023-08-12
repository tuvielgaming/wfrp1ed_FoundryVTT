export class Wfrp1edItemSheet extends ItemSheet {
	static get defaultOptions() {
		console.log("Item");
		console.log(this);
		return mergeObject(super.defaultOptions, {
			classes: [],
			width: 520,
			height: 500,
			tabs: [
				{
					navSelector: ".sheet-tabs",
					contentSelector: ".sheet-body",
					initial: "description",
				},
			],
		});
	}

	get template() {
		const path = "systems/wfrp1ed/templates/item";

		return `${path}/item-${this.item.type}-sheet.hbs`;
	}

	getData() {
		const data = super.getData();
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
