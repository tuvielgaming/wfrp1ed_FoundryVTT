export class Wfrp1edActor extends Actor {
	prepareData() {
		super.prepareData();

		//if you need to reorder how its submethods are called, which by default are:
		// this.data.reset(); - Resets actor data back to its unmodified state (equivalent to how it is stored in the database).
		// this.prepareBaseData(); - Prepare any data related to the Document itself, before any embedded Documents or derived data is computed.
		// this.prepareEmbeddedEntities(); Prepare all embedded Documents within the parent Document, such as owned items or Active Effects. Additionally, Active Effects are called in a submethod of this called this.applyActiveEffects(); which can be overridden.

		// this.prepareDerivedData(); Apply all transformations to data that will adjust its derived values. Most calculations and derived data should occur during this step.
	}

	prepareBaseData() {
		console.log("prepareBase");
		// Data modifications in this step occur before processing embedded
		// documents or derived data.
		//there are cases where it can be useful. For example, if you need an Active Effect to modify a derived value, you can calculate the derived value in this step (such as an ability score modifier) so that the Active Effect can modify it later.
	}

	prepareDerivedData() {
		const actorData = this;
		// const systemData = actorData.system;
		// const flags = actorData.flags.wfrp1e || {};
		console.log("prepareDerived");
		// console.log(this);
		const systemData = this.system;
		const flags = this.flags.wfrp1e || {};

		// Make separate methods for each Actor type (character, npc, etc.) to keep
		// things organized.
		// this._prepareCharacterData(actorData);
		// this._prepareNpcData(actorData);

		this._prepareCharacterData(this);
		this._prepareNpcData(this);
	}

	_prepareCharacterData(actorData) {
		console.log("_prepareCharData");
		if (actorData.type !== "character") return;
		// Make modifications to data here. For example:
		const characteristics = actorData.system.characteristics;
		for (let [key, atr] of Object.entries(characteristics)) {
			if (atr.oneDigit) {
				atr.actual = atr.initial + atr.purchasedAdvances * 1;
				if (atr.advances > 9) {
					atr.advances = 9;
				}
			} else {
				atr.actual = atr.initial + atr.purchasedAdvances * 10;
				if (atr.advances > 40) {
					atr.advances = 40;
				} else if (atr.advances < 10) {
					atr.advances *= 10;
				} else if (atr.advances % 10 > 0) {
					atr.advances = Math.floor(atr.advances / 10);
					atr.advances < 10 ? (atr.advances *= 10) : null;
				}
			}
			if (atr.advances) {
				atr.advances = "+" + atr.advances;
			} else {
				atr.advances = "";
			}
			if (!atr.purchasedAdvances) {
				atr.purchasedAdvances = "";
			}
		}
	}

	/**
	 * Prepare NPC type specific data.
	 */
	_prepareNpcData(actorData) {
		if (actorData.type !== "npc") return;

		// Make modifications to data here. For example:
		const systemData = actorData.system;
		// systemData.xp = systemData.cr * systemData.cr * 100;
	}

	getRollData() {
		const data = super.getRollData();

		this._getCharacterRollData(data);
		this._getNpcRollData(data);

		return data;
	}

	_getCharacterRollData(data) {
		if (this.type !== "character") {
			return;
		}
		console.log("ROllData");
		console.log(data);
		if (data.characteristics) {
			for (let [k, v] of Object.entries(data.characteristics)) {
				data[k] = foundry.utils.deepClone(v);
			}
		}
	}

	_getNpcRollData(data) {}
}
