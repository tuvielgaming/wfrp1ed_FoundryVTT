const {
	BooleanField,
	NumberField,
	StringField,
} = foundry.data.fields;
const { TypeDataModel } = foundry.abstract;

/**
 * Minimal persistent container behind WFRP loot Chat cards.
 *
 * Physical Items remain normal embedded Item documents. The Actor exists so
 * Item transfer uses Foundry's normal document persistence instead of storing
 * mutable inventory snapshots inside ChatMessage HTML/flags.
 */
export class LootPileData extends TypeDataModel {
	static defineSchema() {
		return {
			sourceActorUuid: textField(),
			sourceLabel: textField(),
			reason: textField(),
			exhausted: new BooleanField({
				required: true,
				nullable: false,
				initial: false,
			}),
			createdAt: new NumberField({
				required: true,
				nullable: false,
				integer: true,
				initial: 0,
				min: 0,
			}),
		};
	}
}

function textField() {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial: "",
		trim: true,
	});
}
