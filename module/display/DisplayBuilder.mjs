import {
	TESTABLE_CHARACTERISTIC_IDS,
} from "../tests/standard-tests.mjs";

const CHARACTERISTIC_IDS = Object.freeze([
	"m",
	"ws",
	"bs",
	"s",
	"t",
	"w",
	"i",
	"a",
	"dex",
	"ld",
	"int",
	"cl",
	"wp",
	"fel",
]);

const TESTABLE_CHARACTERISTICS = new Set(
	TESTABLE_CHARACTERISTIC_IDS,
);

const WEAPON_CATEGORY = Object.freeze({
	MELEE: "melee",
	RANGED: "ranged",
	UNCLASSIFIED: "unclassified",
});

const ARMOUR_CLASSIFICATIONS = new Set([
	"armour",
	"armor",
]);

/**
 * Build immutable presentation data from an already-prepared Actor.
 *
 * This class localizes labels, formats values, and groups embedded Items. It
 * does not mutate Documents or own game-rule calculations.
 */
export class DisplayBuilder {
	/**
	 * @param {Actor} document
	 * @returns {Readonly<Object>}
	 */
	static build(document) {
		this._assertActor(document);

		const characteristics =
			this.characteristics(document);

		const weapons =
			this.weapons(document);

		return deepFreeze({
			actor: this.actor(document),
			details: this.details(document),
			characteristics,

			movement:
				this.movement(characteristics),

			status: this.status(document),

			armourPoints:
				this.armourPoints(document),

			experience: this.experience(document),

			weapons,

			meleeWeapons: weapons.filter(
				(weapon) =>
					weapon.category ===
					WEAPON_CATEGORY.MELEE,
			),

			rangedWeapons: weapons.filter(
				(weapon) =>
					weapon.category ===
					WEAPON_CATEGORY.RANGED,
			),

			unclassifiedWeapons: weapons.filter(
				(weapon) =>
					weapon.category ===
					WEAPON_CATEGORY.UNCLASSIFIED,
			),

			armour:
				this.armour(document),

			careers:
				this.itemsByType(
					document,
					"career",
				),

			equipment:
				this.equipment(document),

			traits:
				this.itemsByType(
					document,
					"trait",
				),

			spells:
				this.itemsByType(
					document,
					"spell",
				),

			notes: this.notes(document),
		});
	}

	/**
	 * @param {Actor} document
	 * @returns {Object}
	 */
	static actor(document) {
		return {
			id: document.id,
			uuid: document.uuid,
			name: document.name ?? "",
			img: document.img ?? "",
			type: document.type,
		};
	}

	/**
	 * Read both native direct fields and legacy `{ value }` fields.
	 *
	 * @param {Actor} document
	 * @returns {Object}
	 */
	static details(document) {
		const details =
			document.system?.details ?? {};

		return {
			race: this._text(
				details.race,
			),

			gender: this._text(
				details.gender,
			),

			careerClass: this._text(
				details.careerClass ??
					details.class,
			),

			alignment: this._text(
				details.alignment,
			),

			age: this._text(
				details.age,
			),

			height: this._text(
				details.height,
			),

			weight: this._text(
				details.weight,
			),

			hairColour: this._text(
				details.hairColour ??
					details.haircolour,
			),

			eyeColour: this._text(
				details.eyeColour ??
					details.eyecolour,
			),

			description: this._text(
				details.description,
			),

			currentCareer: this._text(
				details.currentCareer ??
					details.career,
			),

			careerHistory:
				this._careerHistory(
					details.careerHistory ??
						details.careerTrack,
				),

			careerExits:
				this._textArray(
					details.careerExits,
				),

			birthplace: this._text(
				details.birthplace,
			),

			parentsCareer: this._text(
				details.parentsCareer,
			),

			family: this._text(
				details.family,
			),

			socialLevel: this._text(
				details.socialLevel,
			),

			religion: this._text(
				details.religion,
			),

			languages:
				this._textArray(
					details.languages,
				),

			psychology:
				this._textArray(
					details.psychology,
				),

			starSign: this._text(
				details.starSign ??
					details.starsign,
			),

			distinguishingMark:
				this._text(
					details.distinguishingMark ??
						details.distinguishingmark,
				),

			motivation: this._text(
				details.motivation,
			),

			playerName: this._text(
				details.playerName ??
					details.player,
			),
		};
	}

	/**
	 * Present characteristics in the fixed WFRP 1e profile order.
	 *
	 * Movement, Wounds, and Attacks are displayed but are not test bases.
	 * Test availability is taken from standard-tests.mjs rather than being
	 * independently duplicated here.
	 *
	 * @param {Actor} document
	 * @returns {Object[]}
	 */
	static characteristics(document) {
		const characteristics =
			document.system?.characteristics ?? {};

		return CHARACTERISTIC_IDS.map((id) => {
			const localizationId =
				id === "m" ? "sp" : id;

			const key =
				id === "m" &&
				!Object.hasOwn(
					characteristics,
					"m",
				)
					? "sp"
					: id;

			const characteristic =
				characteristics[key];

			if (!characteristic) {
				throw new Error(
					`Actor '${document.name ?? document.id}' ` +
						`has no '${id}' characteristic.`,
				);
			}

			const initial = this._number(
				characteristic.initial,
				`characteristics.${key}.initial`,
			);

			const purchased = this._number(
				characteristic.purchased,
				`characteristics.${key}.purchased`,
			);

			const career = this._number(
				characteristic.career,
				`characteristics.${key}.career`,
			);

			const current = this._number(
				characteristic.current,
				`characteristics.${key}.current`,
			);

			const rollable =
				TESTABLE_CHARACTERISTICS.has(id);

			return {
				id,
				key,

				label: this._localize(
					characteristic.label ??
						`WFRP1ed.CHAR.${localizationId}`,
				),

				abbreviation: this._localize(
					characteristic.abrev ??
						characteristic.abbreviation ??
						`WFRP1ed.CHARAbbrev.${localizationId}`,
				),

				initial,
				purchased,
				career,
				current,

				displayPurchased:
					this.formatAdvances(
						purchased,
						career,
					),

				rollable,

				testId:
					rollable ? id : null,

				improved:
					current > initial,

				reduced:
					current < initial,
			};
		});
	}

	/**
	 * Present only the prepared Movement characteristic.
	 *
	 * Additional movement rates remain absent until they have a verified
	 * mechanical owner.
	 *
	 * @param {Object[]} characteristics
	 * @returns {Object}
	 */
	static movement(characteristics) {
		const movement =
			characteristics.find(
				(characteristic) =>
					characteristic.id === "m",
			);

		if (!movement) {
			throw new Error(
				"Display characteristics contain no Movement value.",
			);
		}

		return {
			value: movement.current,
			abbreviation:
				movement.abbreviation,
		};
	}

	/**
	 * @param {Actor} document
	 * @returns {Object}
	 */
	static status(document) {
		const status =
			document.system?.status ?? {};

		const wounds =
			status.wounds ?? {};

		const fate =
			status.fate ?? {};

		return {
			wounds: {
				value: this._number(
					this._unwrap(wounds) ?? 0,
					"status.wounds.value",
				),

				max: this._number(
					document.woundsMaximum,
					"woundsMaximum",
				),
			},

			fate: {
				value: this._number(
					this._unwrap(fate) ?? 0,
					"status.fate.value",
				),

				max: this._number(
					fate.max ??
						this._unwrap(fate) ??
						0,
					"status.fate.max",
				),
			},

			insanity: this._number(
				this._unwrap(
					status.insanity,
				) ?? 0,
				"status.insanity",
			),

			magicPoints: this._number(
				this._unwrap(
					status.magicPoints ??
						status.magic?.points,
				) ?? 0,
				"status.magicPoints",
			),

			powerLevel: this._number(
				this._unwrap(
					status.powerLevel ??
						status.magic?.powerLevel,
				) ?? 0,
				"status.powerLevel",
			),
		};
	}

	/**
	 * Present persisted Armour Points for each humanoid hit location.
	 *
	 * These values are display and form data only. Damage reduction remains
	 * the responsibility of combat mechanics.
	 *
	 * @param {Actor} document
	 * @returns {Object}
	 */
	static armourPoints(document) {
		const armourPoints =
			document.system?.status?.armourPoints ??
			{};

		return {
			head: this._number(
				this._unwrap(
					armourPoints.head,
				) ?? 0,
				"status.armourPoints.head",
			),

			rightArm: this._number(
				this._unwrap(
					armourPoints.rightArm,
				) ?? 0,
				"status.armourPoints.rightArm",
			),

			leftArm: this._number(
				this._unwrap(
					armourPoints.leftArm,
				) ?? 0,
				"status.armourPoints.leftArm",
			),

			body: this._number(
				this._unwrap(
					armourPoints.body,
				) ?? 0,
				"status.armourPoints.body",
			),

			rightLeg: this._number(
				this._unwrap(
					armourPoints.rightLeg,
				) ?? 0,
				"status.armourPoints.rightLeg",
			),

			leftLeg: this._number(
				this._unwrap(
					armourPoints.leftLeg,
				) ?? 0,
				"status.armourPoints.leftLeg",
			),
		};
	}

	/**
	 * @param {Actor} document
	 * @returns {Object}
	 */
	static experience(document) {
		const experience =
			document.system?.experience ??
			document.system?.details?.experience ??
			{};

		return {
			totalAwarded:
				this._optionalNumber(
					experience.totalAwarded ??
						experience.total,
					"experience.totalAwarded",
				),

			spent: this._number(
				experience.spent ?? 0,
				"experience.spent",
			),

			available: this._number(
				document.availableExperience,
				"availableExperience",
			),
		};
	}

	/**
	 * @param {Actor} document
	 * @returns {Object[]}
	 */
	static weapons(document) {
		return this._items(document)
			.filter((item) =>
				[
					"weapon",
					"meleeWeapon",
					"rangedWeapon",
				].includes(item.type),
			)
			.map((item) =>
				this.weapon(item),
			);
	}

	/**
	 * Build one weapon presentation record.
	 *
	 * `effectiveStrength` is canonical for the ranged-weapon table. Legacy
	 * weapon records may still store that value in `damage`, so `damage`
	 * remains a temporary fallback until the Weapon TypeDataModel migration.
	 *
	 * @param {Item} item
	 * @returns {Object}
	 */
	static weapon(item) {
		const system =
			item.system ?? {};

		const range =
			system.range ?? {};

		return {
			...this.item(item),

			category:
				this._weaponCategory(item),

			quantity: this._number(
				this._unwrap(
					system.quantity,
				) ?? 1,
				`${item.name}.quantity`,
			),

			encumbrance: this._number(
				this._unwrap(
					system.encumbrance ??
						system.weight,
				) ?? 0,
				`${item.name}.encumbrance`,
			),

			damage: this._displayValue(
				system.damage,
			),

			effectiveStrength:
				this._displayValue(
					system.effectiveStrength ??
						system.damage,
				),

			initiative:
				this._displayValue(
					system.initiative,
				),

			weaponSkill:
				this._displayValue(
					system.weaponSkill,
				),

			parry: this._displayValue(
				system.parry,
			),

			reload: this._displayValue(
				system.reload,
			),

			range: {
				short: this._displayValue(
					range.short,
				),

				long: this._displayValue(
					range.long,
				),

				max: this._displayValue(
					range.max,
				),
			},

			qualities:
				this._textArray(
					system.qualities,
				).join(", "),

			equipped: Boolean(
				system.equipped,
			),

			broken: Boolean(
				system.broken,
			),
		};
	}

	/**
	 * Return only items that explicitly declare themselves as armour.
	 *
	 * No item-name matching is used. Generic equipment remains outside the
	 * armour table unless its stored data contains an armour classification.
	 *
	 * @param {Actor} document
	 * @returns {Object[]}
	 */
	static armour(document) {
		return this._items(document)
			.filter((item) =>
				this._isArmourItem(item),
			)
			.map((item) =>
				this.armourItem(item),
			);
	}

	/**
	 * Build one armour presentation record.
	 *
	 * @param {Item} item
	 * @returns {Object}
	 */
	static armourItem(item) {
		const system =
			item.system ?? {};

		return {
			...this.item(item),

			location:
				this._textArray(
					system.location ??
						system.locations ??
						system.coverage,
				).join(", "),

			encumbrance: this._number(
				this._unwrap(
					system.encumbrance ??
						system.weight,
				) ?? 0,
				`${item.name}.encumbrance`,
			),

			equipped: Boolean(
				this._unwrap(
					system.equipped,
				),
			),
		};
	}

	/**
	 * @param {Actor} document
	 * @returns {Object[]}
	 */
	static equipment(document) {
		return this._items(document)
			.filter((item) =>
				item.type === "equipment" &&
				!this._isArmourItem(item),
			)
			.map((item) => ({
				...this.item(item),

				quantity: this._number(
					this._unwrap(
						item.system?.quantity,
					) ?? 1,
					`${item.name}.quantity`,
				),

				encumbrance: this._number(
					this._unwrap(
						item.system?.encumbrance ??
							item.system?.weight,
					) ?? 0,
					`${item.name}.encumbrance`,
				),
			}));
	}

	/**
	 * @param {Actor} document
	 * @param {string} type
	 * @returns {Object[]}
	 */
	static itemsByType(document, type) {
		return this._items(document)
			.filter((item) =>
				item.type === type,
			)
			.map((item) =>
				this.item(item),
			);
	}

	/**
	 * @param {Item} item
	 * @returns {Object}
	 */
	static item(item) {
		return {
			id: item.id,
			uuid: item.uuid,
			name: item.name ?? "",
			img: item.img ?? "",
			type: item.type,
		};
	}

	/**
	 * @param {Actor} document
	 * @returns {Object}
	 */
	static notes(document) {
		return {
			text: this._text(
				document.system?.details?.notes,
			),
		};
	}

	/**
	 * Format purchased and available career advances as sheet markers.
	 *
	 * @param {number} purchased
	 * @param {number} career
	 * @returns {string}
	 */
	static formatAdvances(purchased, career) {
		const purchasedCount = Math.max(
			0,
			Math.trunc(
				Number(purchased) || 0,
			),
		);

		const careerCount = Math.max(
			purchasedCount,
			Math.trunc(
				Number(career) || 0,
			),
		);

		if (careerCount === 0) {
			return "\u00A0";
		}

		return (
			"●".repeat(purchasedCount) +
			"○".repeat(
				careerCount -
					purchasedCount,
			)
		);
	}

	/**
	 * Classify a weapon only from explicit stored data.
	 *
	 * Generic weapons with no explicit category remain unclassified instead of
	 * being silently placed in an incorrect sheet section.
	 *
	 * @param {Item} item
	 * @returns {string}
	 * @protected
	 */
	static _weaponCategory(item) {
		if (item.type === "meleeWeapon") {
			return WEAPON_CATEGORY.MELEE;
		}

		if (item.type === "rangedWeapon") {
			return WEAPON_CATEGORY.RANGED;
		}

		if (item.system?.isRanged === true) {
			return WEAPON_CATEGORY.RANGED;
		}

		if (item.system?.isRanged === false) {
			return WEAPON_CATEGORY.MELEE;
		}

		const weaponClass = this._text(
			item.system?.weaponClass,
		)
			.toLowerCase()
			.replace(/[\s_-]+/g, "");

		if (weaponClass === "melee") {
			return WEAPON_CATEGORY.MELEE;
		}

		if (weaponClass === "ranged") {
			return WEAPON_CATEGORY.RANGED;
		}

		return WEAPON_CATEGORY.UNCLASSIFIED;
	}

	/**
	 * Determine whether an Item explicitly declares an armour classification.
	 *
	 * @param {Item} item
	 * @returns {boolean}
	 * @protected
	 */
	static _isArmourItem(item) {
		if (
			item.type === "armour" ||
			item.type === "armor"
		) {
			return true;
		}

		if (
			item.system?.isArmour === true ||
			item.system?.isArmor === true
		) {
			return true;
		}

		const classifications = [
			item.system?.equipmentType,
			item.system?.itemType,
			item.system?.category,
			item.system?.subtype,
			item.system?.type,
		];

		return classifications.some(
			(classification) =>
				ARMOUR_CLASSIFICATIONS.has(
					this._normalizeClassification(
						classification,
					),
				),
		);
	}

	/**
	 * @param {*} value
	 * @returns {string}
	 * @protected
	 */
	static _normalizeClassification(value) {
		return this._text(value)
			.toLowerCase()
			.replace(/[\s_-]+/g, "");
	}

	/**
	 * @param {*} value
	 * @returns {Object[]}
	 * @protected
	 */
	static _careerHistory(value) {
		const entries =
			this._unwrap(value);

		if (!Array.isArray(entries)) {
			const name =
				this._text(entries);

			return name
				? [
						{
							name,
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
					name: this._text(
						entry.name ??
							entry.label,
					),

					uuid: this._text(
						entry.uuid ??
							entry.id,
					),

					completed: Boolean(
						entry.completed,
					),
				};
			})
			.filter((entry) =>
				Boolean(
					entry?.name ||
						entry?.uuid,
				),
			);
	}

	/**
	 * @param {*} value
	 * @returns {string[]}
	 * @protected
	 */
	static _textArray(value) {
		const unwrapped =
			this._unwrap(value);

		const entries =
			Array.isArray(unwrapped)
				? unwrapped
				: [unwrapped];

		return entries
			.map((entry) => {
				if (
					entry &&
					typeof entry === "object"
				) {
					return this._text(
						entry.name ??
							entry.label ??
							entry.value,
					);
				}

				return this._text(entry);
			})
			.filter(Boolean);
	}

	/**
	 * @param {*} value
	 * @returns {string|number}
	 * @protected
	 */
	static _displayValue(value) {
		const unwrapped =
			this._unwrap(value);

		if (
			unwrapped === undefined ||
			unwrapped === null
		) {
			return "";
		}

		return typeof unwrapped === "number"
			? unwrapped
			: String(unwrapped).trim();
	}

	/**
	 * @param {*} value
	 * @returns {*}
	 * @protected
	 */
	static _unwrap(value) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.hasOwn(value, "value")
		) {
			return value.value;
		}

		return value;
	}

	/**
	 * @param {*} value
	 * @returns {string}
	 * @protected
	 */
	static _text(value) {
		const unwrapped =
			this._unwrap(value);

		if (
			unwrapped === undefined ||
			unwrapped === null
		) {
			return "";
		}

		return String(unwrapped).trim();
	}

	/**
	 * @param {*} key
	 * @returns {string}
	 * @protected
	 */
	static _localize(key) {
		const normalizedKey =
			this._text(key);

		return normalizedKey
			? game.i18n.localize(
					normalizedKey,
				)
			: "";
	}

	/**
	 * @param {*} value
	 * @param {string} path
	 * @returns {number}
	 * @protected
	 */
	static _number(value, path) {
		const number =
			Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`Display value '${path}' must be a finite ` +
					`number: ${String(value)}`,
			);
		}

		return number;
	}

	/**
	 * @param {*} value
	 * @param {string} path
	 * @returns {number|null}
	 * @protected
	 */
	static _optionalNumber(value, path) {
		if (
			value === undefined ||
			value === null ||
			value === ""
		) {
			return null;
		}

		return this._number(
			value,
			path,
		);
	}

	/**
	 * @param {Actor} document
	 * @returns {Item[]}
	 * @protected
	 */
	static _items(document) {
		return Array.from(
			document.items ?? [],
		);
	}

	/**
	 * @param {*} document
	 * @returns {void}
	 * @protected
	 */
	static _assertActor(document) {
		if (
			!document?.system ||
			!document?.items
		) {
			throw new Error(
				"DisplayBuilder requires an Actor Document.",
			);
		}
	}
}

/**
 * Recursively freeze plain presentation data.
 *
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Object.isFrozen(value)
	) {
		return value;
	}

	for (const child of Object.values(value)) {
		deepFreeze(child);
	}

	return Object.freeze(value);
}