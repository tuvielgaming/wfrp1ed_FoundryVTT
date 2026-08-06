const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class Wfrp1edFoundryStyleActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
	static get defaultOptions() {
		return foundry.utils.mergeObject(super.defaultOptions, {
			template:
				"systems/wfrp1ed/templates/actor/actor-FoundryStyleCharacter-sheet.hbs",
			width: 820,
			height: 600,
			resizable: false,
			tabs: [
				{
					navSelector: ".sheet-tabs",
					contentSelector: ".sheet-body",
					initial: "general",
				},
			],
		});
	}

	// get template() {
	// 	return "systems/wfrp1ed/templates/actor/actor-FoundryStyleCharacter-sheet.html";
	// }

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
		console.log("Karta Postaci kontekst", context);
		// console.log(this.actor.toObject(false));

		context.rollData = context.actor.getRollData();

		return context;
	}

	_prepareItems(context) {
		const gear = [];
		const features = [];
		const spells = [];
		const weapons = [];
		let career = null;
		for (let i of context.items) {
			i.img = i.img || DEFAULT_TOKEN;
			// Append to gear.
			if (i.type === "item") {
				gear.push(i);
			}
			// Append to features.
			else if (i.type === "feature") {
				features.push(i);
			}
			// Append to spells.
			else if (i.type === "spell") {
				if (i.data.spellLevel != undefined) {
					spells.push(i);
				}
			}
			// Append to weapons.
			else if (i.type === "weapon") {
				weapons.push(i);
			}
			// Set career.
			else if (i.type === "career") {
				career = i;
			}
		}
		context.gear = gear;
		context.features = features;
		context.spells = spells;
		context.weapons = weapons;
		context.career = career;
	}

	_prepareCharacterData(context) {
		// const systemData = context.system;
		// for (let [key, atr] of Object.entries(systemData.characteristics)) {
		// 	if (atr.oneDigit) {
		// 		atr.actual = atr.initial + atr.modifier * 1;
		// 	} else {
		// 		atr.actual = atr.initial + atr.modifier * 10;
		// 	}
		// 	if (atr.career) {
		// 		atr.career = "+" + atr.career;
		// 	} else {
		// 		atr.career = "";
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
				speaker: ChatMessage.getSpeaker({ actor: this.actor }),
				flavor: label,
			});
			return roll;
		}
	}
}
