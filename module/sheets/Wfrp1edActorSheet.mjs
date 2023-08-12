export class Wfrp1edActorSheet extends ActorSheet {
	static get defaultOptions() {
		return mergeObject(super.defaultOptions, {
			template:
				"systems/wfrp1ed/templates/actors/character/character-sheet.html",
			width: 900,
			height: 1264,
			// resizable: false,
		});
	}

	get template() {
		return `systems/wfrp1ed/templates/actor/actor-${this.actor.type}-sheet.html`;
	}

	getData() {
		const context = super.getData();
		const actorData = this.actor.toObject(false);
		// const actorData = context.actor.data;
		context.system = actorData.system;
		context.flags = actorData.flags;

		context.config = CONFIG.wfrp1ed;
		if (actorData.type == "character") {
			this._prepareItems(context);
			this._prepareCharacterData(context);
		}
		console.log("Karta Postaci kontekst");
		console.log(context);
		// console.log(this.actor.toObject(false));

		context.rollData = context.actor.getRollData();

		return context;
	}

	_prepareItems(context) {}

	_prepareCharacterData(context) {
		// const systemData = context.system;
		// for (let [key, atr] of Object.entries(systemData.characteristics)) {
		// 	if (atr.oneDigit) {
		// 		atr.actual = atr.initial + atr.modifier * 1;
		// 	} else {
		// 		atr.actual = atr.initial + atr.modifier * 10;
		// 	}
		// 	if (atr.advances) {
		// 		atr.advances = "+" + atr.advances;
		// 	} else {
		// 		atr.advances = "";
		// 	}
		// }
	}

	activateListeners(html) {
		super.activateListeners(html);

		html.find(".rollable").dblclick(this._onRoll.bind(this));
	}

	_onRoll(event) {
		event.preventDefault();
		const element = event.currentTarget;
		const dataset = element.dataset;

		if (dataset.roll) {
			let roll = new Roll(dataset.roll, this.actor.getRollData());
			let label = dataset.label
				? `${game.i18n.localize("WFRP1ed.Chat.Rolling")} ${dataset.label}`
				: "";
			roll.toMessage({
				spealer: ChatMessage.getSpeaker({ actor: this.actor }),
				flavor: label,
			});
			return roll;
		}
	}
}
