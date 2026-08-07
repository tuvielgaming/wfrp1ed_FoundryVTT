import { RollTestAction } from "../actions/RollTestAction.mjs";
import { CharacterData } from "../data-models/actor/CharacterData.mjs";
import { TestManager } from "../tests/TestManager.mjs";

const PROFILE_ACTOR_TYPES = Object.freeze([
	"character",
	"npc",
]);

const CHARACTERISTIC_ALIASES = Object.freeze({
	sp: "m",
});

const CHARACTERISTIC_ADVANCE_COST = 100;

const ADVANCEMENT_FLAG_SCOPE = "wfrp1ed";
const ADVANCEMENT_FLAG_KEY = "lastCharacteristicAdvance";

const ADVANCEMENT_TRANSACTION_KIND =
	"characteristicAdvance";

const ADVANCEMENT_TRANSACTION_STATE = Object.freeze({
	APPLIED: "applied",
	UNDONE: "undone",
});

export class Wfrp1edActor extends Actor {
	/**
	 * The WFRP 1e Experience Point cost of one characteristic advance.
	 *
	 * @returns {number}
	 */
	static get characteristicAdvanceCost() {
		return CHARACTERISTIC_ADVANCE_COST;
	}

	/**
	 * Prepare Actor-level derived data.
	 *
	 * Registered TypeDataModels own derived data for their subtype. The
	 * legacy fallback remains temporarily for Actor types that still use
	 * template.json during the staged Foundry v14 migration.
	 *
	 * Foundry may invoke this method from the base Document constructor before
	 * subclass private fields and methods are branded on the instance. Helpers
	 * used by this lifecycle path therefore deliberately use normal protected
	 * methods rather than JavaScript private methods.
	 *
	 * @returns {void}
	 */
	prepareDerivedData() {
		super.prepareDerivedData();

		if (!PROFILE_ACTOR_TYPES.includes(this.type)) {
			return;
		}

		if (this._usesNativeCharacterModel()) {
			return;
		}

		this._prepareLegacyCharacteristics();
	}

	/**
	 * Return one characteristic from the Actor profile.
	 *
	 * The canonical Movement identifier is `m`. The legacy `sp` identifier
	 * remains accepted while existing Actors, formulas, and sheets are
	 * migrated.
	 *
	 * @param {string} id
	 * @returns {Object}
	 */
	getCharacteristic(id) {
		const { characteristic } =
			this.#resolveCharacteristic(id);

		return characteristic;
	}

	/**
	 * Return the finite current value of one characteristic.
	 *
	 * @param {string} id
	 * @returns {number}
	 */
	getCharacteristicValue(id) {
		const characteristic =
			this.getCharacteristic(id);

		return this._finiteNumber(
			characteristic.current,
			`characteristics.${String(id)}.current`,
		);
	}

	/**
	 * Current Wounds maximum derived from the profile.
	 *
	 * @returns {number}
	 */
	get woundsMaximum() {
		return this.getCharacteristicValue("w");
	}

	/**
	 * Experience Points currently available to spend.
	 *
	 * The direct `experience` structure is canonical. Reading the legacy
	 * details structure is temporary compatibility for Actors that have not
	 * yet passed through CharacterData migration.
	 *
	 * @returns {number}
	 */
	get availableExperience() {
		const modelValue =
			this.system?.availableExperience;

		if (Number.isFinite(Number(modelValue))) {
			return Number(modelValue);
		}

		return this.#readExperienceLedger({
			strict: false,
		}).available;
	}

	/**
	 * Return the current purchase state of one characteristic.
	 *
	 * @param {string} characteristicId
	 * @returns {Object}
	 */
	getCharacteristicAdvanceState(characteristicId) {
		const {
			canonicalId,
			storageKey,
			characteristic,
		} = this.#resolveCharacteristic(characteristicId);

		const purchased = this.#nonNegativeInteger(
			characteristic.purchased,
			`characteristics.${storageKey}.purchased`,
		);

		const career = this.#nonNegativeInteger(
			characteristic.career,
			`characteristics.${storageKey}.career`,
		);

		const experience =
			this.#readExperienceLedger();

		return Object.freeze({
			characteristicId: canonicalId,
			storageKey,
			purchased,
			career,
			cost: CHARACTERISTIC_ADVANCE_COST,
			availableExperience:
				experience.available,

			canPurchase:
				purchased < career &&
				experience.available >=
					CHARACTERISTIC_ADVANCE_COST,
		});
	}

	/**
	 * Purchase one characteristic advance for 100 Experience Points.
	 *
	 * The characteristic increase, Experience expenditure, and reversible
	 * transaction record are persisted by one Document update. A later
	 * purchase replaces the reversible record, so a player can undo only the
	 * most recent advancement purchase.
	 *
	 * @param {string} characteristicId
	 * @returns {Promise<Object>}
	 */
	async purchaseCharacteristicAdvance(
		characteristicId,
	) {
		this.#assertCharacterAdvancementPermission();

		const {
			canonicalId,
			storageKey,
			characteristic,
		} = this.#resolveCharacteristic(characteristicId);

		const purchasedBefore =
			this.#nonNegativeInteger(
				characteristic.purchased,
				`characteristics.${storageKey}.purchased`,
			);

		const career =
			this.#nonNegativeInteger(
				characteristic.career,
				`characteristics.${storageKey}.career`,
			);

		if (purchasedBefore >= career) {
			throw new Error(
				`No unused career advance remains for ` +
					`'${canonicalId}'.`,
			);
		}

		const experience =
			this.#readExperienceLedger();

		if (
			experience.available <
			CHARACTERISTIC_ADVANCE_COST
		) {
			throw new Error(
				`The Actor needs ` +
					`${CHARACTERISTIC_ADVANCE_COST} ` +
					`available Experience Points to buy ` +
					`this advance.`,
			);
		}

		const purchasedAfter =
			purchasedBefore + 1;

		const spentAfter =
			experience.spent +
			CHARACTERISTIC_ADVANCE_COST;

		const transaction = Object.freeze({
			id: foundry.utils.randomID(),
			kind: ADVANCEMENT_TRANSACTION_KIND,
			state:
				ADVANCEMENT_TRANSACTION_STATE.APPLIED,

			characteristic: canonicalId,
			storageKey,

			userId: game.user?.id ?? "",

			cost: CHARACTERISTIC_ADVANCE_COST,

			purchasedBefore,
			purchasedAfter,

			spentBefore: experience.spent,
			spentAfter,

			createdAt: Date.now(),
		});

		await this.update({
			[
				`system.characteristics.` +
					`${storageKey}.purchased`
			]: purchasedAfter,

			...experience.updateForSpent(
				spentAfter,
			),

			[
				`flags.${ADVANCEMENT_FLAG_SCOPE}.` +
					ADVANCEMENT_FLAG_KEY
			]: transaction,
		});

		return transaction;
	}

	/**
	 * Undo the latest eligible characteristic-advance purchase.
	 *
	 * A non-GM user may undo only a transaction created by that same user.
	 * Current purchased advances and spent Experience must still match the
	 * transaction's post-purchase values. Any later purchase or correction
	 * therefore makes the older transaction ineligible.
	 *
	 * @param {string} characteristicId
	 * @returns {Promise<Object>}
	 */
	async undoLastCharacteristicAdvance(
		characteristicId,
	) {
		this.#assertCharacterAdvancementPermission();

		const {
			canonicalId,
			storageKey,
			characteristic,
		} = this.#resolveCharacteristic(characteristicId);

		const transaction = this.getFlag(
			ADVANCEMENT_FLAG_SCOPE,
			ADVANCEMENT_FLAG_KEY,
		);

		this.#validateUndoTransaction(
			transaction,
			canonicalId,
			storageKey,
		);

		const currentPurchased =
			this.#nonNegativeInteger(
				characteristic.purchased,
				`characteristics.${storageKey}.purchased`,
			);

		const experience =
			this.#readExperienceLedger();

		if (
			currentPurchased !==
				transaction.purchasedAfter ||
			experience.spent !==
				transaction.spentAfter
		) {
			throw new Error(
				"The latest advancement purchase can no " +
					"longer be undone because the Actor's " +
					"advancement or Experience data has changed.",
			);
		}

		const undoneTransaction = Object.freeze({
			...transaction,

			state:
				ADVANCEMENT_TRANSACTION_STATE.UNDONE,

			undoneBy: game.user?.id ?? "",
			undoneAt: Date.now(),
		});

		await this.update({
			[
				`system.characteristics.` +
					`${storageKey}.purchased`
			]: transaction.purchasedBefore,

			...experience.updateForSpent(
				transaction.spentBefore,
			),

			[
				`flags.${ADVANCEMENT_FLAG_SCOPE}.` +
					ADVANCEMENT_FLAG_KEY
			]: undoneTransaction,
		});

		return undoneTransaction;
	}

	/**
	 * Execute a registered test for this Actor.
	 *
	 * @param {string} testId
	 * @param {Object} options
	 * @returns {Promise<TestResult|null>}
	 */
	async rollTest(testId, options = {}) {
		const normalizedTestId =
			String(testId ?? "").trim();

		if (!normalizedTestId) {
			ui.notifications.error(
				"A WFRP 1e test id is required.",
			);

			return null;
		}

		const test =
			TestManager.get(normalizedTestId);

		if (!test) {
			ui.notifications.error(
				`Unknown WFRP 1e test ` +
					`'${normalizedTestId}'.`,
			);

			return null;
		}

		return RollTestAction.execute(
			this,
			test,
			options,
		);
	}

	/**
	 * Execute the registered standard test for a characteristic.
	 *
	 * @param {string} characteristicId
	 * @param {Object} options
	 * @returns {Promise<TestResult|null>}
	 */
	async rollCharacteristic(
		characteristicId,
		options = {},
	) {
		const normalizedId =
			String(characteristicId ?? "")
				.trim()
				.toLowerCase();

		this.getCharacteristic(normalizedId);

		return this.rollTest(
			normalizedId,
			options,
		);
	}

	/**
	 * Determine whether this Character uses the native v14 model.
	 *
	 * This method participates in prepareDerivedData(), which Foundry can call
	 * while the base constructor is still running. It must therefore not use
	 * JavaScript private-method branding.
	 *
	 * @returns {boolean}
	 * @protected
	 */
	_usesNativeCharacterModel() {
		return (
			this.type === "character" &&
			this.system instanceof CharacterData
		);
	}

	/**
	 * Prepare current characteristic values for legacy template.json Actors.
	 *
	 * This method participates in prepareDerivedData(), which Foundry can call
	 * while the base constructor is still running. It and its numeric helper
	 * must therefore remain callable before subclass private branding occurs.
	 *
	 * @returns {void}
	 * @protected
	 */
	_prepareLegacyCharacteristics() {
		const characteristics =
			this.system?.characteristics;

		if (
			!characteristics ||
			typeof characteristics !== "object"
		) {
			return;
		}

		for (
			const [id, characteristic]
			of Object.entries(characteristics)
		) {
			if (
				!characteristic ||
				typeof characteristic !== "object"
			) {
				throw new Error(
					`Actor '${this.name ?? this.id}' ` +
						`characteristic '${id}' must be ` +
						"an object.",
				);
			}

			const initial = this._finiteNumber(
				characteristic.initial,
				`characteristics.${id}.initial`,
			);

			const purchased = this._finiteNumber(
				characteristic.purchased,
				`characteristics.${id}.purchased`,
			);

			const advanceStep = this._finiteNumber(
				characteristic.advanceStep,
				`characteristics.${id}.advanceStep`,
			);

			characteristic.current =
				initial +
				purchased * advanceStep;
		}
	}

	/**
	 * Resolve a canonical characteristic id and its current storage key.
	 *
	 * @param {string} id
	 * @returns {Object}
	 * @protected
	 */
	#resolveCharacteristic(id) {
		const requestedId = String(id ?? "")
			.trim()
			.toLowerCase();

		if (!requestedId) {
			throw new Error(
				"Characteristic id must not be empty.",
			);
		}

		const canonicalId =
			CHARACTERISTIC_ALIASES[requestedId] ??
			requestedId;

		const characteristics =
			this.system?.characteristics;

		if (
			!characteristics ||
			typeof characteristics !== "object"
		) {
			throw new Error(
				`Actor '${this.name ?? this.id}' has no ` +
					"characteristic profile.",
			);
		}

		let storageKey = canonicalId;

		if (
			!Object.hasOwn(
				characteristics,
				storageKey,
			) &&
			canonicalId === "m" &&
			Object.hasOwn(
				characteristics,
				"sp",
			)
		) {
			storageKey = "sp";
		}

		if (
			!Object.hasOwn(
				characteristics,
				storageKey,
			) &&
			Object.hasOwn(
				characteristics,
				requestedId,
			)
		) {
			storageKey = requestedId;
		}

		const characteristic =
			characteristics[storageKey];

		if (!characteristic) {
			throw new Error(
				`Actor '${this.name ?? this.id}' has no ` +
					`'${requestedId}' characteristic.`,
			);
		}

		return {
			requestedId,
			canonicalId,
			storageKey,
			characteristic,
		};
	}

	/**
	 * Read one consistent Experience ledger and prepare its update paths.
	 *
	 * @param {Object} options
	 * @param {boolean} [options.strict=true]
	 * @returns {Object}
	 * @protected
	 */
	#readExperienceLedger({
		strict = true,
	} = {}) {
		const direct =
			this.system?.experience;

		if (
			direct &&
			typeof direct === "object" &&
			direct.totalAwarded !== undefined
		) {
			const totalAwarded =
				this.#nonNegativeInteger(
					direct.totalAwarded,
					"experience.totalAwarded",
				);

			const spent =
				this.#nonNegativeInteger(
					direct.spent,
					"experience.spent",
				);

			if (spent > totalAwarded) {
				throw new Error(
					"Spent Experience cannot exceed total " +
						"awarded Experience.",
				);
			}

			return {
				totalAwarded,
				spent,
				available:
					totalAwarded - spent,

				updateForSpent: (nextSpent) => ({
					"system.experience.spent":
						nextSpent,
				}),
			};
		}

		const legacy =
			this.system?.details?.experience;

		if (
			legacy &&
			typeof legacy === "object"
		) {
			return this.#readLegacyExperienceLedger(
				legacy,
			);
		}

		if (!strict) {
			return {
				totalAwarded: 0,
				spent: 0,
				available: 0,
				updateForSpent: () => ({}),
			};
		}

		throw new Error(
			`Actor '${this.name ?? this.id}' has no ` +
				"Experience ledger.",
		);
	}

	/**
	 * Read and normalize the temporary template.json Experience structure.
	 *
	 * @param {Object} legacy
	 * @returns {Object}
	 * @protected
	 */
	#readLegacyExperienceLedger(legacy) {
		const spent =
			this.#nonNegativeInteger(
				legacy.spent ?? 0,
				"details.experience.spent",
			);

		const hasTotal =
			this.#hasNumericValue(
				legacy.total,
			);

		const hasValue =
			this.#hasNumericValue(
				legacy.value,
			);

		let totalAwarded;
		let available;

		if (hasTotal) {
			totalAwarded =
				this.#nonNegativeInteger(
					legacy.total,
					"details.experience.total",
				);

			if (spent > totalAwarded) {
				throw new Error(
					"Legacy spent Experience cannot exceed " +
						"legacy total Experience.",
				);
			}

			available =
				totalAwarded - spent;

			if (hasValue) {
				const storedAvailable =
					this.#nonNegativeInteger(
						legacy.value,
						"details.experience.value",
					);

				if (
					storedAvailable !== available
				) {
					if (
						totalAwarded === 0 &&
						spent === 0
					) {
						totalAwarded =
							storedAvailable;

						available =
							storedAvailable;
					} else {
						throw new Error(
							"Legacy Experience fields are " +
								"inconsistent. Migrate the " +
								"Actor before purchasing advances.",
						);
					}
				}
			}
		} else if (hasValue) {
			available =
				this.#nonNegativeInteger(
					legacy.value,
					"details.experience.value",
				);

			totalAwarded =
				available + spent;
		} else {
			totalAwarded = spent;
			available = 0;
		}

		return {
			totalAwarded,
			spent,
			available,

			updateForSpent: (nextSpent) => ({
				"system.details.experience.total":
					totalAwarded,

				"system.details.experience.spent":
					nextSpent,

				"system.details.experience.value":
					totalAwarded - nextSpent,
			}),
		};
	}

	/**
	 * Validate permission and Actor type for advancement changes.
	 *
	 * @returns {void}
	 * @protected
	 */
	#assertCharacterAdvancementPermission() {
		if (this.type !== "character") {
			throw new Error(
				"Characteristic advancement is available " +
					"only for Character Actors.",
			);
		}

		if (!game.user) {
			throw new Error(
				"Characteristic advancement requires an " +
					"active Foundry user.",
			);
		}

		if (!this.isOwner && !game.user.isGM) {
			throw new Error(
				"You do not have permission to modify " +
					"this Actor.",
			);
		}
	}

	/**
	 * Validate that a stored transaction is the latest eligible undo target.
	 *
	 * @param {*} transaction
	 * @param {string} canonicalId
	 * @param {string} storageKey
	 * @returns {void}
	 * @protected
	 */
	#validateUndoTransaction(
		transaction,
		canonicalId,
		storageKey,
	) {
		if (
			!transaction ||
			typeof transaction !== "object"
		) {
			throw new Error(
				"There is no characteristic-advance " +
					"purchase available to undo.",
			);
		}

		if (
			transaction.kind !==
				ADVANCEMENT_TRANSACTION_KIND ||
			transaction.state !==
				ADVANCEMENT_TRANSACTION_STATE.APPLIED
		) {
			throw new Error(
				"The latest characteristic-advance " +
					"transaction has already been closed.",
			);
		}

		if (
			transaction.characteristic !==
				canonicalId ||
			transaction.storageKey !==
				storageKey
		) {
			throw new Error(
				"Only the latest purchased characteristic " +
					"advance can be undone.",
			);
		}

		if (
			!game.user.isGM &&
			transaction.userId !==
				game.user.id
		) {
			throw new Error(
				"Only the user who purchased the latest " +
					"advance or a GM can undo it.",
			);
		}

		for (const field of [
			"cost",
			"purchasedBefore",
			"purchasedAfter",
			"spentBefore",
			"spentAfter",
		]) {
			this.#nonNegativeInteger(
				transaction[field],
				`advancementTransaction.${field}`,
			);
		}

		if (
			transaction.cost !==
				CHARACTERISTIC_ADVANCE_COST ||
			transaction.purchasedAfter !==
				transaction.purchasedBefore + 1 ||
			transaction.spentAfter !==
				transaction.spentBefore +
					transaction.cost
		) {
			throw new Error(
				"The stored characteristic-advance " +
					"transaction is invalid and cannot be " +
					"undone automatically.",
			);
		}
	}

	/**
	 * Convert Actor data into a finite number.
	 *
	 * This helper is also used during prepareDerivedData(), which Foundry may
	 * invoke before subclass private branding is complete.
	 *
	 * @param {*} value
	 * @param {string} path
	 * @returns {number}
	 * @protected
	 */
	_finiteNumber(value, path) {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`Actor '${this.name ?? this.id}' value ` +
					`'${path}' must be a finite number: ` +
					String(value),
			);
		}

		return number;
	}

	/**
	 * Convert Actor data into a non-negative integer.
	 *
	 * @param {*} value
	 * @param {string} path
	 * @returns {number}
	 * @protected
	 */
	#nonNegativeInteger(value, path) {
		const number =
			this._finiteNumber(value, path);

		if (
			!Number.isInteger(number) ||
			number < 0
		) {
			throw new Error(
				`Actor '${this.name ?? this.id}' value ` +
					`'${path}' must be a non-negative ` +
					`integer: ${String(value)}`,
			);
		}

		return number;
	}

	/**
	 * Determine whether a legacy field contains a numeric value.
	 *
	 * @param {*} value
	 * @returns {boolean}
	 * @protected
	 */
	#hasNumericValue(value) {
		return (
			value !== undefined &&
			value !== null &&
			value !== "" &&
			Number.isFinite(Number(value))
		);
	}
}
