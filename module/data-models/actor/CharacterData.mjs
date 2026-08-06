const {
	ArrayField,
	BooleanField,
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

export class CharacterData extends TypeDataModel {
	/**
	 * Define persistent WFRP 1e Character data.
	 *
	 * Characteristic current values, Wounds maximum, and available Experience
	 * are derived and are therefore not part of the persisted schema.
	 *
	 * @returns {Object}
	 */
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
				race: textField(),
				gender: textField(),
				careerClass: textField(),
				alignment: textField(),

				age: textField(),
				height: textField(),
				weight: textField(),
				hairColour: textField(),
				eyeColour: textField(),
				description: textField(),

				currentCareer: textField(),

				careerHistory: new ArrayField(
					careerHistoryEntryField(),
				),

				careerExits: new ArrayField(
					textField(),
				),

				birthplace: textField(),
				parentsCareer: textField(),
				family: textField(),
				socialLevel: textField(),
				religion: textField(),

				languages: new ArrayField(
					textField(),
				),

				psychology: new ArrayField(
					textField(),
				),

				/*
				 * These fields preserve existing Character data during the
				 * transition from template.json. Their final sheet placement
				 * will be decided during the relevant field audit.
				 */
				starSign: textField(),
				distinguishingMark: textField(),
				motivation: textField(),
				notes: textField(),
				playerName: textField(),
			}),

			status: new SchemaField({
				/*
				 * This is the persistent number of remaining Wounds.
				 * Its maximum is derived from characteristics.w.current.
				 *
				 * Negative values are permitted because damage exceeding
				 * remaining Wounds determines critical damage.
				 */
				wounds: new SchemaField({
					value: integerField({
						initial: 0,
					}),
				}),

				fate: new SchemaField({
					value: nonNegativeIntegerField(),
					max: nonNegativeIntegerField(),
				}),

				insanity: nonNegativeIntegerField(),
				magicPoints: nonNegativeIntegerField(),
				powerLevel: nonNegativeIntegerField(),

				/*
				 * Armour Points are stored separately for each hit location.
				 * Their application to damage is owned by combat mechanics,
				 * not by the actor data model.
				 */
				armourPoints: new SchemaField({
					head: nonNegativeIntegerField(),
					rightArm: nonNegativeIntegerField(),
					leftArm: nonNegativeIntegerField(),
					body: nonNegativeIntegerField(),
					rightLeg: nonNegativeIntegerField(),
					leftLeg: nonNegativeIntegerField(),
				}),
			}),

			experience: new SchemaField({
				totalAwarded: nonNegativeIntegerField(),
				spent: nonNegativeIntegerField(),
			}),
		};
	}

	/**
	 * Convert legacy template.json Character data into this model.
	 *
	 * @param {Object} source
	 * @param {Object} options
	 * @returns {Object}
	 */
	static migrateData(source, options = {}) {
		const migrated = foundry.utils.deepClone(
			source ?? {},
		);

		migrateCharacteristics(migrated);
		migrateDetails(migrated);
		migrateStatus(migrated);
		migrateExperience(migrated);

		return super.migrateData(
			migrated,
			options,
		);
	}

	/**
	 * Validate relationships involving multiple schema fields.
	 *
	 * @param {Object} data
	 * @returns {void}
	 */
	static validateJoint(data) {
		super.validateJoint(data);

		if (
			data.status.fate.value >
			data.status.fate.max
		) {
			throw new Error(
				"Current Fate Points cannot exceed " +
					"maximum Fate Points.",
			);
		}

		if (
			data.experience.spent >
			data.experience.totalAwarded
		) {
			throw new Error(
				"Spent Experience cannot exceed total " +
					"awarded Experience.",
			);
		}
	}

	/** @inheritDoc */
	prepareDerivedData() {
		super.prepareDerivedData();

		for (
			const [id, definition]
			of Object.entries(
				CHARACTERISTIC_DEFINITIONS,
			)
		) {
			const characteristic =
				this.characteristics[id];

			characteristic.advanceStep =
				definition.advanceStep;

			characteristic.current =
				characteristic.initial +
				characteristic.purchased *
					definition.advanceStep;

			characteristic.label =
				definition.label;

			characteristic.abrev =
				definition.abbreviation;
		}

		this.#installLegacyMovementAlias();
	}

	/**
	 * Current Wounds maximum derived from the profile.
	 *
	 * @returns {number}
	 */
	get woundsMaximum() {
		return this.characteristics.w.current;
	}

	/**
	 * Experience Points currently available to spend.
	 *
	 * @returns {number}
	 */
	get availableExperience() {
		return (
			this.experience.totalAwarded -
			this.experience.spent
		);
	}

	/**
	 * Install a temporary, non-persistent `sp` alias.
	 *
	 * The canonical Movement key is `m`. Existing formula code currently
	 * expects `sp`, so the alias prevents a temporary runtime failure while
	 * that consumer is migrated in its own replacement step.
	 *
	 * Because it is non-enumerable, the characteristic table renders only
	 * the canonical `m` entry.
	 *
	 * @returns {void}
	 * @protected
	 */
	#installLegacyMovementAlias() {
		if (
			Object.hasOwn(
				this.characteristics,
				"sp",
			)
		) {
			return;
		}

		Object.defineProperty(
			this.characteristics,
			"sp",
			{
				configurable: true,
				enumerable: false,

				get: () =>
					this.characteristics.m,
			},
		);
	}
}

/**
 * Construct one persistent characteristic record.
 *
 * `advanceStep`, `current`, `label`, and `abrev` are derived from the
 * canonical characteristic definition and are not stored.
 *
 * @returns {SchemaField}
 */
function characteristicField() {
	return new SchemaField({
		initial: nonNegativeIntegerField(),
		purchased: nonNegativeIntegerField(),
		career: nonNegativeIntegerField(),
	});
}

/**
 * Construct one career-history record.
 *
 * @returns {SchemaField}
 */
function careerHistoryEntryField() {
	return new SchemaField({
		name: textField(),
		uuid: textField(),

		completed: new BooleanField({
			required: true,
			nullable: false,
			initial: false,
		}),
	});
}

/**
 * Construct a required, non-null text field.
 *
 * @returns {StringField}
 */
function textField() {
	return new StringField({
		required: true,
		nullable: false,
		blank: true,
		initial: "",
		trim: true,
	});
}

/**
 * Construct a non-negative persistent integer.
 *
 * @returns {NumberField}
 */
function nonNegativeIntegerField() {
	return integerField({
		initial: 0,
		min: 0,
	});
}

/**
 * Construct a persistent integer.
 *
 * @param {Object} options
 * @returns {NumberField}
 */
function integerField(options = {}) {
	return new NumberField({
		required: true,
		nullable: false,
		integer: true,
		...options,
	});
}

/**
 * Rename the legacy Polish-derived `sp` key to canonical `m`.
 *
 * @param {Object} source
 * @returns {void}
 */
function migrateCharacteristics(source) {
	const characteristics =
		source.characteristics ?? {};

	if (
		!characteristics.m &&
		characteristics.sp
	) {
		characteristics.m =
			characteristics.sp;
	}

	delete characteristics.sp;

	source.characteristics =
		characteristics;
}

/**
 * Unwrap the legacy template.json detail records and rename them to their
 * canonical properties.
 *
 * @param {Object} source
 * @returns {void}
 */
function migrateDetails(source) {
	const details = source.details ?? {};

	source.details = {
		...details,

		race: unwrapText(
			details.race,
		),

		gender: unwrapText(
			details.gender,
		),

		careerClass: unwrapText(
			details.careerClass ??
				details.class,
		),

		alignment: unwrapText(
			details.alignment,
		),

		age: unwrapText(
			details.age,
		),

		height: unwrapText(
			details.height,
		),

		weight: unwrapText(
			details.weight,
		),

		hairColour: unwrapText(
			details.hairColour ??
				details.haircolour,
		),

		eyeColour: unwrapText(
			details.eyeColour ??
				details.eyecolour,
		),

		description: unwrapText(
			details.description,
		),

		currentCareer: unwrapText(
			details.currentCareer ??
				details.career,
		),

		careerHistory:
			normalizeCareerHistory(
				details.careerHistory ??
					details.careerTrack,
			),

		careerExits:
			normalizeTextArray(
				details.careerExits,
			),

		birthplace: unwrapText(
			details.birthplace,
		),

		parentsCareer: unwrapText(
			details.parentsCareer,
		),

		family: unwrapText(
			details.family,
		),

		socialLevel: unwrapText(
			details.socialLevel,
		),

		religion: unwrapText(
			details.religion,
		),

		languages:
			normalizeTextArray(
				details.languages,
			),

		psychology:
			normalizeTextArray(
				details.psychology,
			),

		starSign: unwrapText(
			details.starSign ??
				details.starsign,
		),

		distinguishingMark:
			unwrapText(
				details.distinguishingMark ??
					details.distinguishingmark,
			),

		motivation: unwrapText(
			details.motivation,
		),

		notes: unwrapText(
			details.notes,
		),

		playerName: unwrapText(
			details.playerName ??
				details.player,
		),
	};
}

/**
 * Migrate Character status resources.
 *
 * The obsolete WFRP 2e-style Fortune resource is deliberately discarded.
 *
 * @param {Object} source
 * @returns {void}
 */
function migrateStatus(source) {
	const status = source.status ?? {};
	const legacyFate = status.fate ?? {};
	const legacyArmourPoints =
		status.armourPoints ?? {};

	const fateValue = toInteger(
		unwrapValue(legacyFate),
		0,
	);

	const fateMax = Math.max(
		fateValue,
		toInteger(
			legacyFate.max,
			fateValue,
		),
	);

	source.status = {
		...status,

		wounds: {
			value: toInteger(
				unwrapValue(
					status.wounds,
				),
				0,
			),
		},

		fate: {
			value: Math.max(
				0,
				fateValue,
			),

			max: Math.max(
				0,
				fateMax,
			),
		},

		insanity: Math.max(
			0,
			toInteger(
				status.insanity,
				0,
			),
		),

		magicPoints: Math.max(
			0,
			toInteger(
				status.magicPoints ??
					status.magic?.points,
				0,
			),
		),

		powerLevel: Math.max(
			0,
			toInteger(
				status.powerLevel ??
					status.magic?.powerLevel,
				0,
			),
		),

		armourPoints: {
			head: nonNegativeIntegerValue(
				legacyArmourPoints.head,
			),

			rightArm: nonNegativeIntegerValue(
				legacyArmourPoints.rightArm,
			),

			leftArm: nonNegativeIntegerValue(
				legacyArmourPoints.leftArm,
			),

			body: nonNegativeIntegerValue(
				legacyArmourPoints.body,
			),

			rightLeg: nonNegativeIntegerValue(
				legacyArmourPoints.rightLeg,
			),

			leftLeg: nonNegativeIntegerValue(
				legacyArmourPoints.leftLeg,
			),
		},
	};

	delete source.status.fortune;
}

/**
 * Replace the ambiguous legacy Experience structure with one persistent pair.
 *
 * When only a legacy `value` is present, it is interpreted as currently
 * available Experience and combined with `spent` to reconstruct total awarded.
 *
 * @param {Object} source
 * @returns {void}
 */
function migrateExperience(source) {
	const legacy =
		source.experience ??
		source.details?.experience ??
		{};

	const spent = Math.max(
		0,
		toInteger(
			legacy.spent,
			0,
		),
	);

	let totalAwarded;

	if (
		hasNumericValue(
			legacy.totalAwarded,
		)
	) {
		totalAwarded = toInteger(
			legacy.totalAwarded,
			0,
		);
	} else if (
		hasNumericValue(
			legacy.total,
		)
	) {
		totalAwarded = toInteger(
			legacy.total,
			0,
		);
	} else if (
		hasNumericValue(
			legacy.value,
		)
	) {
		totalAwarded =
			toInteger(
				legacy.value,
				0,
			) +
			spent;
	} else {
		totalAwarded = spent;
	}

	source.experience = {
		totalAwarded: Math.max(
			spent,
			totalAwarded,
			0,
		),

		spent,
	};
}

/**
 * Convert legacy career-history strings and records into one structure.
 *
 * @param {*} value
 * @returns {Object[]}
 */
function normalizeCareerHistory(value) {
	const entries = unwrapValue(value);

	if (!Array.isArray(entries)) {
		const text = unwrapText(entries);

		return text
			? [
					{
						name: text,
						uuid: "",
						completed: false,
					},
				]
			: [];
	}

	return entries
		.map((entry) => {
			if (
				typeof entry === "string"
			) {
				return {
					name: entry.trim(),
					uuid: "",
					completed: false,
				};
			}

			if (
				!entry ||
				typeof entry !== "object"
			) {
				return null;
			}

			return {
				name: unwrapText(
					entry.name ??
						entry.label,
				),

				uuid: unwrapText(
					entry.uuid ??
						entry.id,
				),

				completed: Boolean(
					entry.completed,
				),
			};
		})
		.filter(
			(entry) =>
				entry &&
				(
					entry.name ||
					entry.uuid
				),
		);
}

/**
 * Convert a legacy scalar or array into a clean text array.
 *
 * @param {*} value
 * @returns {string[]}
 */
function normalizeTextArray(value) {
	const unwrapped =
		unwrapValue(value);

	if (Array.isArray(unwrapped)) {
		return unwrapped
			.map((entry) =>
				unwrapText(entry),
			)
			.filter(Boolean);
	}

	const text =
		unwrapText(unwrapped);

	return text ? [text] : [];
}

/**
 * Convert a value to a non-negative integer.
 *
 * @param {*} value
 * @returns {number}
 */
function nonNegativeIntegerValue(value) {
	return Math.max(
		0,
		toInteger(
			value,
			0,
		),
	);
}

/**
 * Unwrap and normalize a legacy text value.
 *
 * @param {*} value
 * @returns {string}
 */
function unwrapText(value) {
	const unwrapped =
		unwrapValue(value);

	if (
		unwrapped === undefined ||
		unwrapped === null
	) {
		return "";
	}

	return String(unwrapped).trim();
}

/**
 * Read the `value` property used by the legacy template.json schema.
 *
 * @param {*} value
 * @returns {*}
 */
function unwrapValue(value) {
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(
			value,
			"value",
		)
	) {
		return value.value;
	}

	return value;
}

/**
 * Determine whether a value can be converted to a finite number.
 *
 * @param {*} value
 * @returns {boolean}
 */
function hasNumericValue(value) {
	return (
		value !== undefined &&
		value !== null &&
		value !== "" &&
		Number.isFinite(
			Number(value),
		)
	);
}

/**
 * Convert a value to an integer without producing NaN.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function toInteger(value, fallback) {
	const unwrapped =
		unwrapValue(value);

	const number =
		Number(unwrapped);

	return Number.isFinite(number)
		? Math.trunc(number)
		: fallback;
}