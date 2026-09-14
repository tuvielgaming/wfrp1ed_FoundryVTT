const {
	NumberField,
	SchemaField,
	StringField,
} = foundry.data.fields;

const { TypeDataModel } = foundry.abstract;

const CHARACTERISTIC_DEFINITIONS = Object.freeze({
	m: Object.freeze({
		advanceStep: 1,
		label: "WFRP1ed.CHAR.sp",
		abbreviation: "WFRP1ed.CHARAbbrev.sp",
	}),
	ws: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.ws",
		abbreviation: "WFRP1ed.CHARAbbrev.ws",
	}),
	bs: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.bs",
		abbreviation: "WFRP1ed.CHARAbbrev.bs",
	}),
	s: Object.freeze({
		advanceStep: 1,
		label: "WFRP1ed.CHAR.s",
		abbreviation: "WFRP1ed.CHARAbbrev.s",
	}),
	t: Object.freeze({
		advanceStep: 1,
		label: "WFRP1ed.CHAR.t",
		abbreviation: "WFRP1ed.CHARAbbrev.t",
	}),
	w: Object.freeze({
		advanceStep: 1,
		label: "WFRP1ed.CHAR.w",
		abbreviation: "WFRP1ed.CHARAbbrev.w",
	}),
	i: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.i",
		abbreviation: "WFRP1ed.CHARAbbrev.i",
	}),
	a: Object.freeze({
		advanceStep: 1,
		label: "WFRP1ed.CHAR.a",
		abbreviation: "WFRP1ed.CHARAbbrev.a",
	}),
	dex: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.dex",
		abbreviation: "WFRP1ed.CHARAbbrev.dex",
	}),
	ld: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.ld",
		abbreviation: "WFRP1ed.CHARAbbrev.ld",
	}),
	int: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.int",
		abbreviation: "WFRP1ed.CHARAbbrev.int",
	}),
	cl: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.cl",
		abbreviation: "WFRP1ed.CHARAbbrev.cl",
	}),
	wp: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.wp",
		abbreviation: "WFRP1ed.CHARAbbrev.wp",
	}),
	fel: Object.freeze({
		advanceStep: 10,
		label: "WFRP1ed.CHAR.fel",
		abbreviation: "WFRP1ed.CHARAbbrev.fel",
	}),
});

/**
 * Native WFRP 1e profile data shared by NPC and Creature Actors.
 *
 * Adversaries use the same fourteen-characteristic profile and combat/status
 * resources as Characters, but deliberately do not own Character-only Career,
 * Experience, Fate-generation, or Character Creation state.
 *
 * `purchased` and `career` remain neutral zero-valued compatibility fields for
 * the current shared presentation/combat helpers. They are not exposed as NPC
 * or Creature advancement mechanics and may be removed when the Character and
 * Adversary profile models are later extracted onto one audited common base.
 */
export class AdversaryData extends TypeDataModel {
	static defineSchema() {
		return {
			characteristics: new SchemaField(
				Object.fromEntries(
					Object.keys(CHARACTERISTIC_DEFINITIONS).map(
						(id) => [id, characteristicField()],
					),
				),
			),

			details: new SchemaField({
				species: textField(),
				description: textField(),
				notes: textField(),
			}),

			status: new SchemaField({
				wounds: new SchemaField({
					value: nonNegativeIntegerField(),
				}),

				insanity: nonNegativeIntegerField(),
				magicPoints: nonNegativeIntegerField(),
				powerLevel: nonNegativeIntegerField(),

				armourPoints: new SchemaField({
					head: nonNegativeIntegerField(),
					rightArm: nonNegativeIntegerField(),
					leftArm: nonNegativeIntegerField(),
					body: nonNegativeIntegerField(),
					rightLeg: nonNegativeIntegerField(),
					leftLeg: nonNegativeIntegerField(),
				}),
			}),
		};
	}

	prepareDerivedData() {
		super.prepareDerivedData();

		for (
			const [id, definition]
			of Object.entries(CHARACTERISTIC_DEFINITIONS)
		) {
			const characteristic = this.characteristics[id];

			characteristic.advanceStep = definition.advanceStep;
			characteristic.current =
				characteristic.initial +
				characteristic.purchased * definition.advanceStep;
			characteristic.label = definition.label;
			characteristic.abrev = definition.abbreviation;
		}

		this.#installLegacyMovementAlias();
	}

	get woundsMaximum() {
		return this.characteristics.w.current;
	}

	#installLegacyMovementAlias() {
		if (Object.hasOwn(this.characteristics, "sp")) return;

		Object.defineProperty(this.characteristics, "sp", {
			configurable: true,
			enumerable: false,
			get: () => this.characteristics.m,
		});
	}
}

function characteristicField() {
	return new SchemaField({
		initial: nonNegativeIntegerField(),
		purchased: nonNegativeIntegerField(),
		career: nonNegativeIntegerField(),
	});
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

function nonNegativeIntegerField() {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		initial: 0,
		min: 0,
	});
}
