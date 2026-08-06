const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class Wfrp1edActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
	static get defaultOptions() {
		return foundry.utils.mergeObject(super.defaultOptions, {
			template:
				"systems/wfrp1ed/templates/actors/character/character-sheet.html",
			width: 1200,
			height: 1697,
			resizable: false,
		});
	}

	get template() {
		return `systems/wfrp1ed/templates/actor/actor-${this.actor.type}-sheet.hbs`;
	}

	async getData(options) {
		const context = await super.getData(options);
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
		console.log("context", context);
		context.system.details.careerTrackString = context.system.details.careerTrack.value.join(", ");
		// const careerTrack = context.system.details.careerTrack.value.join(", ");
		// let careerTrackString = "";
		// for (let i = 0; i < careerTrack.length; i++) {
		// 	if (i == careerTrack.length - 1) {
		// 		careerTrackString += `${careerTrack[i]} `;
		// 	} else {
		// 		careerTrackString += `${careerTrack[i]}, `;
		// 	}
		// }
		// careerTrack.forEach((career) => {
		// 	careerTrackString += `${career}, `;
		// });
		// context.system.details.careerTrackString = careerTrackString;
	}

	activateListeners(html) {
		super.activateListeners(html);

		html.find(".rollable").dblclick(this._onRoll.bind(this));
		html.find(".advance-box").click(this._onAdvanceClick.bind(this));
	}

	// activateListeners(html) {
	// 	super.activateListeners(html);

	// 	html.find(".advance-box").click(this._onAdvanceClick.bind(this));
	// }

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
				speaker: ChatMessage.getSpeaker({ actor: this.actor }),
				flavor: label,
			});
			return roll;
		}
	}

	async _onAdvanceClick(event) {
		event.preventDefault();

		const box = event.currentTarget;

		const characteristic = box.dataset.characteristic;
		const value = Number(box.dataset.value);

		await this.actor.update({
			[`system.characteristics.${characteristic}.purchased`]: value,
		});
	}
}
