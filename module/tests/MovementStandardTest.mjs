import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "./standard-test-procedures.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const MOVEMENT_STATE_VERSION = 2;
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/movement-test-result.hbs";

const JUMP_EFFECT_TARGET =
	"procedure.movement.jump.reductionDie";
const LEAP_EFFECT_TARGET =
	"procedure.movement.leap.distance";

const LUCK_ROLL = Object.freeze({
	JUMP_D6: "movement.jump.reduction",
	JUMP_HELD_ITEMS: "movement.jump.heldItems",
	LEAP_D6: "movement.leap.distance",
});

/**
 * Execute audited WFRP 1e movement procedures.
 *
 * Mechanical source:
 * - English Core Rulebook, printed p. 75, Jumping/Falling/Leaping/Climbing.
 * - Polish Core Rulebook, printed p. 75, Zeskok/Upadek/Skok/Wspinaczka.
 *
 * Post-roll Luck support is intentionally expressed as roll descriptors.
 * LuckIntegration asks this class which concrete rolls are adjustable instead
 * of hard-coding Jump or Leap names in the Luck subsystem.
 */
export class MovementStandardTest {
	static async execute(actor, procedureId, options = {}) {
		if (!actor) {
			throw new Error(
				"Movement Standard Test requires an Actor.",
			);
		}

		const id = String(procedureId ?? "").trim();
		const procedure = STANDARD_TEST_PROCEDURES[id];

		if (!procedure) {
			throw new Error(
				`Unknown movement Standard Test procedure '${id}'.`,
			);
		}

		switch (id) {
			case "jump":
				return this._executeJump(actor, procedure, options);
			case "leap":
				return this._executeLeap(actor, procedure, options);
			default:
				throw new Error(
					`Unsupported movement Standard Test procedure '${id}'.`,
				);
		}
	}

	static async _executeJump(actor, procedure, options) {
		const enteredHeight = this._positiveNumber(
			options.jumpHeight,
			"jumpHeight",
		);
		const height = Math.ceil(enteredHeight);
		const effects = RuleEffectRollSelection.resolveNumeric(
			actor,
			JUMP_EFFECT_TARGET,
			options.ruleEffects,
		);
		const effectBonus = effects.total;

		const roll = await new Roll("1d6").evaluate();
		const die = this._finiteNumber(roll.total, "jump roll");
		const initialWounds = Math.max(
			0,
			height - (die + effectBonus),
		);

		let dropRoll = null;
		let dropsHeldItems = false;

		if (initialWounds > 0) {
			dropRoll = await new Roll("1d100").evaluate();
			dropsHeldItems =
				this._finiteNumber(dropRoll.total, "drop roll") <= 50;
		}

		const state = {
			version: MOVEMENT_STATE_VERSION,
			kind: "jump",
			actorUuid: actor.uuid,
			procedureId: procedure.id ?? "jump",
			enteredHeight,
			height,
			effectBonus,
			effects: effects.entries.map((effect) => ({
				source: String(effect.source ?? ""),
				value: this._finiteNumber(
					effect.value,
					"jump effect",
				),
			})),
			die,
			dropRoll: dropRoll
				? this._finiteNumber(dropRoll.total, "drop roll")
				: null,
			dropsHeldItems,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const message = await this._publish(
			actor,
			this._presentation(state),
			{
				rolls: dropRoll ? [roll, dropRoll] : [roll],
				flags: {
					[FLAG_SCOPE]: {
						[MOVEMENT_STATE_FLAG_KEY]: state,
					},
				},
			},
		);

		await this._synchronizeJumpDamage(message, state);
		return message;
	}

	static async _executeLeap(actor, procedure, options) {
		const gap = this._positiveNumber(
			options.leapGap,
			"leapGap",
		);
		const runUp = options.runUp === true;
		const movement = this._finiteNumber(
			actor.getCharacteristicValue?.("m") ??
				actor.system?.characteristics?.m?.current ??
				actor.system?.characteristics?.sp?.current,
			"Movement",
		);
		const effects = RuleEffectRollSelection.resolveNumeric(
			actor,
			LEAP_EFFECT_TARGET,
			options.ruleEffects,
		);
		const effectBonus = effects.total;
		const diceFormula = runUp ? "1d6" : "2d6";
		const roll = await new Roll(diceFormula).evaluate();
		const dice = this._finiteNumber(roll.total, "leap roll");

		const state = {
			version: MOVEMENT_STATE_VERSION,
			kind: "leap",
			actorUuid: actor.uuid,
			procedureId: procedure.id ?? "leap",
			gap,
			runUp,
			movement,
			effectBonus,
			effects: effects.entries.map((effect) => ({
				source: String(effect.source ?? ""),
				value: this._finiteNumber(
					effect.value,
					"leap effect",
				),
			})),
			diceFormula,
			dice,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		return this._publish(
			actor,
			this._presentation(state),
			{
				rolls: [roll],
				flags: {
					[FLAG_SCOPE]: {
						[MOVEMENT_STATE_FLAG_KEY]: state,
					},
				},
			},
		);
	}

	/**
	 * Return persisted movement state.
	 */
	static stateFor(message) {
		const state = message?.getFlag?.(
			FLAG_SCOPE,
			MOVEMENT_STATE_FLAG_KEY,
		);

		return state &&
			typeof state === "object" &&
			!Array.isArray(state)
			? state
			: null;
	}

	/**
	 * Describe every currently relevant roll which the Luck subsystem may
	 * modify. The descriptor contains the die family and the rule-useful
	 * direction. LuckIntegration only cares about descriptors, not procedure
	 * names.
	 *
	 * WFRP 1e Luck changes d6 by 1 and d100 by 10. For the concrete movement
	 * procedures below only the favourable direction is exposed:
	 * - Jump reduction d6: +1 reduces damage.
	 * - Jump held-items d100: +10 moves toward the 51-100 retained range.
	 * - Leap d6/2d6 total: -1 increases achieved distance.
	 *
	 * For a 2d6 Leap, reducing the total by one is mechanically equivalent to
	 * applying Luck's -1 to one constituent d6.
	 */
	static luckOptions(message) {
		const state = this.stateFor(message);
		if (!state) return [];

		if (state.kind === "jump") {
			const options = [
				Object.freeze({
					id: LUCK_ROLL.JUMP_D6,
					die: "d6",
					delta: 1,
					value: this._finiteNumber(
						state.die,
						"jump roll",
					),
					label: this._localize(
						"WFRP1ED.Luck.Roll.Jump",
						"Jump d6",
						"K6 Zeskoku",
					),
					blocksAfterDamage: true,
				}),
			];

			const resolution = this._jumpResolution(state);
			if (
				resolution.wounds > 0 &&
				state.dropRoll !== null &&
				state.dropRoll !== undefined
			) {
				options.push(Object.freeze({
					id: LUCK_ROLL.JUMP_HELD_ITEMS,
					die: "d100",
					delta: 10,
					value: this._finiteNumber(
						state.dropRoll,
						"held-items roll",
					),
					label: this._localize(
						"WFRP1ED.Luck.Roll.HeldItems",
						"Held-items d100",
						"K100 utrzymania przedmiotów",
					),
					blocksAfterDamage: false,
				}));
			}

			return options;
		}

		if (state.kind === "leap") {
			return [
				Object.freeze({
					id: LUCK_ROLL.LEAP_D6,
					die: "d6",
					delta: -1,
					value: this._finiteNumber(
						state.dice,
						"leap dice",
					),
					label: this._localize(
						"WFRP1ED.Luck.Roll.Leap",
						"Leap dice",
						"Kości Skoku",
					),
					blocksAfterDamage: false,
				}),
			];
		}

		return [];
	}

	static canApplyLuck(message, rollId, delta) {
		const id = String(rollId ?? "");
		const number = Number(delta);

		return this.luckOptions(message).some(
			(option) =>
				option.id === id &&
				option.delta === number,
		);
	}

	/**
	 * Re-resolve one concrete movement roll after Luck.
	 */
	static async applyLuck(message, rollId, delta) {
		if (!this.canApplyLuck(message, rollId, delta)) {
			throw new Error(
				"This movement roll cannot be adjusted by Luck.",
			);
		}

		const state = foundry.utils.deepClone(
			this.stateFor(message),
		);
		const number = Number(delta);
		let originalRoll;
		let adjustedRoll;

		switch (String(rollId)) {
			case LUCK_ROLL.JUMP_D6:
				originalRoll = this._finiteNumber(
					state.die,
					"jump roll",
				);
				adjustedRoll = originalRoll + number;
				state.die = adjustedRoll;
				break;

			case LUCK_ROLL.JUMP_HELD_ITEMS:
				originalRoll = this._finiteNumber(
					state.dropRoll,
					"held-items roll",
				);
				adjustedRoll = originalRoll + number;
				state.dropRoll = adjustedRoll;
				state.dropsHeldItems = adjustedRoll <= 50;
				break;

			case LUCK_ROLL.LEAP_D6:
				originalRoll = this._finiteNumber(
					state.dice,
					"leap dice",
				);
				adjustedRoll = originalRoll + number;
				state.dice = adjustedRoll;
				break;

			default:
				throw new Error(
					`Unknown movement Luck roll '${String(rollId)}'.`,
				);
		}

		state.updatedAt = Date.now();

		const content = await this._render(
			this._presentation(state),
		);

		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${MOVEMENT_STATE_FLAG_KEY}`]: state,
		});

		if (rollId === LUCK_ROLL.JUMP_D6) {
			await this._synchronizeJumpDamage(message, state);
		}

		return Object.freeze({
			rollId: String(rollId),
			originalRoll,
			adjustedRoll,
			delta: number,
		});
	}

	/**
	 * Localize a movement card for the language of the client currently
	 * rendering it. ChatMessage.content is shared persisted HTML, so without
	 * this final render-time pass a message would remain in its author's
	 * language for every other connected user.
	 */
	static applyClientLocalization(message, html) {
		const state = this.stateFor(message);
		if (!state) return;

		const root = this._asElement(html);
		const card = root?.matches?.(".wfrp1e-test-card")
			? root
			: root?.querySelector?.(".wfrp1e-test-card");
		if (!card) return;

		const data = this._presentation(state);
		this._patchRenderedCard(card, data);
	}

	static _patchRenderedCard(card, data) {
		card.classList.toggle("is-success", data.success === true);
		card.classList.toggle("is-failure", data.success !== true);

		const title = card.querySelector(
			".wfrp1e-test-card__header h2",
		);
		if (title) title.textContent = data.procedureName;

		const status = card.querySelector(
			".wfrp1e-test-card__status",
		);
		if (status) {
			status.textContent = data.success
				? this._localize(
					"WFRP1ED.TestResult.Success",
					"Success",
					"Sukces",
				)
				: this._localize(
					"WFRP1ED.TestResult.Failure",
					"Failure",
					"Porażka",
				);
		}

		const details = card.querySelector(
			".wfrp1e-test-card__target",
		);
		const summary = details?.querySelector(":scope > summary");
		if (summary) {
			summary.title = this._localize(
				"WFRP1ED.Movement.DetailsHint",
				"Click to show movement calculation",
				"Kliknij, aby pokazać obliczenie ruchu",
			);
		}

		const primaryLabel = card.querySelector(
			".wfrp1e-test-card__target-label",
		);
		if (primaryLabel) {
			primaryLabel.textContent = data.primaryLabel;
		}

		const primaryValue = card.querySelector(
			".wfrp1e-test-card__target-value",
		);
		if (primaryValue) {
			primaryValue.textContent = String(data.primaryValue);
		}

		const sections = [
			...card.querySelectorAll(
				".wfrp1e-test-card__breakdown-section",
			),
		];
		const calculationSection = sections[0] ?? null;

		const sectionTitle = calculationSection?.querySelector(
			".wfrp1e-test-card__section-title",
		);
		if (sectionTitle) {
			sectionTitle.textContent = this._localize(
				"WFRP1ED.Movement.FullRound",
				"Full-round action",
				"Czynność na pełną rundę",
			);
		}

		const rows = calculationSection
			? [
				...calculationSection.querySelectorAll(
					".wfrp1e-test-card__breakdown-row",
				),
			]
			: [];

		data.rows.forEach((row, index) => {
			const rendered = rows[index];
			if (!rendered) return;

			const label = rendered.querySelector("span");
			const value = rendered.querySelector("strong");
			if (label) label.textContent = String(row.label);
			if (value) value.textContent = String(row.value);
		});

		const subtitles = [
			...card.querySelectorAll(
				".wfrp1e-test-card__section-subtitle",
			),
		];
		const localizedNotes = [
			data.note,
			data.secondaryNote,
		].filter(Boolean);

		subtitles.forEach((element, index) => {
			element.textContent = String(
				localizedNotes[index] ?? "",
			);
		});

		const metrics = [
			...card.querySelectorAll(
				".wfrp1e-test-card__metric",
			),
		];
		this._patchMetric(
			metrics[0],
			data.metricLeftLabel,
			data.metricLeftValue,
		);
		this._patchMetric(
			metrics[1],
			data.metricRightLabel,
			data.metricRightValue,
		);
	}

	static _patchMetric(metric, labelText, valueText) {
		if (!metric) return;
		const label = metric.querySelector("span");
		const value = metric.querySelector("strong");
		if (label) label.textContent = String(labelText);
		if (value) value.textContent = String(valueText);
	}

	static _presentation(state) {
		switch (state?.kind) {
			case "jump":
				return this._jumpPresentation(state);
			case "leap":
				return this._leapPresentation(state);
			default:
				throw new Error(
					`Unsupported movement state '${String(state?.kind)}'.`,
				);
		}
	}

	static _jumpPresentation(state) {
		const { die, effectiveDie, wounds } =
			this._jumpResolution(state);
		const effects = Array.isArray(state.effects)
			? state.effects
			: [];
		const dropRoll =
			state.dropRoll === null ||
			state.dropRoll === undefined
				? null
				: this._finiteNumber(
					state.dropRoll,
					"drop roll",
				);

		return {
			kind: "jump",
			procedureName: this._procedureName(state),
			success: wounds === 0,
			primaryLabel: this._localize(
				"WFRP1ED.Movement.Height",
				"Height",
				"Wysokość",
			),
			primaryValue:
				`${state.height} ${this._distanceUnit()}`,
			metricLeftLabel: this._dieLabel("d6"),
			metricLeftValue: die,
			metricRightLabel: this._localize(
				"WFRP1ED.Movement.Wounds",
				"Wounds",
				"Obrażenia",
			),
			metricRightValue: wounds,
			rows: [
				{
					label: this._localize(
						"WFRP1ED.Movement.EnteredHeight",
						"Entered height",
						"Podana wysokość",
					),
					value:
						`${state.enteredHeight} ${this._distanceUnit()}`,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.RoundedHeight",
						"Rounded height",
						"Wysokość po zaokrągleniu",
					),
					value:
						`${state.height} ${this._distanceUnit()}`,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.DieRoll",
						"d6 roll",
						"Rzut K6",
					),
					value: die,
				},
				...effects.map((effect) => ({
					label: effect.source,
					value: this._signed(effect.value),
				})),
				{
					label: this._localize(
						"WFRP1ED.Movement.EffectiveDie",
						"Effective d6",
						"Efektywny wynik K6",
					),
					value: effectiveDie,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.DamageCalculation",
						"Damage calculation",
						"Obliczenie obrażeń",
					),
					value:
						`${state.height} - ${effectiveDie} = ${wounds}`,
				},
			],
			note: wounds > 0
				? this._localize(
					"WFRP1ED.Movement.JumpDamageNote",
					"These Wounds ignore armour and Toughness modifiers.",
					"Te obrażenia ignorują pancerz i modyfikatory Wytrzymałości.",
				)
				: this._localize(
					"WFRP1ED.Movement.NoJumpDamage",
					"No Wounds are suffered.",
					"Bohater nie odnosi obrażeń.",
				),
			secondaryNote:
				wounds > 0 && dropRoll !== null
					? this._dropNoteValue(
						dropRoll,
						state.dropsHeldItems === true,
					)
					: "",
			fullRound: true,
		};
	}

	static _leapPresentation(state) {
		const {
			dice,
			distance,
			unboundedDistance,
			success,
		} = this._leapResolution(state);
		const effects = Array.isArray(state.effects)
			? state.effects
			: [];

		return {
			kind: "leap",
			procedureName: this._procedureName(state),
			success,
			primaryLabel: this._localize(
				"WFRP1ED.Movement.Distance",
				"Distance",
				"Dystans",
			),
			primaryValue:
				`${distance} ${this._distanceUnit()}`,
			metricLeftLabel: this._localize(
				"WFRP1ED.Movement.Required",
				"Required",
				"Wymagane",
			),
			metricLeftValue:
				`${state.gap} ${this._distanceUnit()}`,
			metricRightLabel: this._localize(
				"WFRP1ED.Movement.Achieved",
				"Achieved",
				"Osiągnięto",
			),
			metricRightValue:
				`${distance} ${this._distanceUnit()}`,
			rows: [
				{
					label: this._localize(
						"WFRP1ED.Movement.Movement",
						"Movement",
						"Szybkość",
					),
					value: state.movement,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.RunUp",
						"Run-up",
						"Rozbieg",
					),
					value: state.runUp
						? this._localize(
							"WFRP1ED.Yes",
							"Yes",
							"Tak",
						)
						: this._localize(
							"WFRP1ED.No",
							"No",
							"Nie",
						),
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.Dice",
						"Dice",
						"Kości",
					),
					value:
						`${state.diceFormula}: ${dice}`,
				},
				...effects.map((effect) => ({
					label: effect.source,
					value: this._signed(effect.value),
				})),
				{
					label: this._localize(
						"WFRP1ED.Movement.Calculation",
						"Calculation",
						"Obliczenie",
					),
					value:
						`${2 * state.movement} - ${dice}` +
						(state.effectBonus
							? ` + ${state.effectBonus}`
							: "") +
						` = ${unboundedDistance}`,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.MinimumDistance",
						"Minimum distance",
						"Minimalny dystans",
					),
					value: `1 ${this._distanceUnit()}`,
				},
			],
			note: success
				? this._localize(
					"WFRP1ED.Movement.LeapSuccess",
					"The character reaches the other side.",
					"Bohater doskakuje na drugą stronę.",
				)
				: this._localize(
					"WFRP1ED.Movement.LeapFailure",
					"The character does not reach the other side and falls. The GM determines the actual fall distance from the scene.",
					"Bohater nie doskakuje na drugą stronę i spada. MG ustala rzeczywistą wysokość upadku na podstawie sytuacji.",
				),
			secondaryNote: "",
			fullRound: true,
		};
	}

	static _jumpResolution(state) {
		const die = this._finiteNumber(
			state.die,
			"jump roll",
		);
		const effectBonus = this._finiteNumber(
			state.effectBonus ?? 0,
			"jump effect bonus",
		);
		const height = this._positiveNumber(
			state.height,
			"jump height",
		);
		const effectiveDie = die + effectBonus;
		const wounds = Math.max(
			0,
			height - effectiveDie,
		);

		return {
			die,
			effectBonus,
			effectiveDie,
			wounds,
		};
	}

	static _leapResolution(state) {
		const movement = this._finiteNumber(
			state.movement,
			"Movement",
		);
		const dice = this._finiteNumber(
			state.dice,
			"leap dice",
		);
		const effectBonus = this._finiteNumber(
			state.effectBonus ?? 0,
			"leap effect bonus",
		);
		const gap = this._positiveNumber(
			state.gap,
			"leap gap",
		);
		const unboundedDistance =
			2 * movement - dice + effectBonus;
		const distance = Math.max(1, unboundedDistance);
		const success = distance >= gap;

		return {
			dice,
			unboundedDistance,
			distance,
			success,
		};
	}

	static async _synchronizeJumpDamage(message, state) {
		const { wounds } = this._jumpResolution(state);
		const existingDamage = message?.getFlag?.(
			FLAG_SCOPE,
			"damageState",
		);

		if (wounds <= 0) {
			if (existingDamage) {
				await message.unsetFlag(
					FLAG_SCOPE,
					"damageState",
				);
			}
			return;
		}

		const actor = await foundry.utils.fromUuid(
			state.actorUuid,
		);
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error(
				`Jump Actor '${state.actorUuid}' is not available.`,
			);
		}

		const packet = new DamagePacket({
			rawAmount: wounds,
			targetActorUuid: actor.uuid,
			source: {
				kind: "movement-procedure",
				id: state.procedureId ?? "jump",
				/*
				 * Store a stable English fallback in the packet rather than
				 * creator-localized UI. The movement card itself localizes per
				 * viewer at render time.
				 */
				label:
					STANDARD_TEST_PROCEDURES.jump?.label ??
					"Jump",
			},
			armour: DAMAGE_MITIGATION_POLICY.IGNORE,
			toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
			criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		});
		const resolution = DamageResolver.resolve(packet);

		await DamageChat.attach(message, {
			packet,
			resolution,
		});
	}

	static async _publish(actor, data, options = {}) {
		const content = await this._render(data);

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content,
			rolls: options.rolls ?? [],
			flags: options.flags ?? {},
		});
	}

	static async _render(data) {
		return foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			{
				...data,
				statusLabel: data.success
					? this._localize(
						"WFRP1ED.TestResult.Success",
						"Success",
						"Sukces",
					)
					: this._localize(
						"WFRP1ED.TestResult.Failure",
						"Failure",
						"Porażka",
					),
				fullRoundLabel: this._localize(
					"WFRP1ED.Movement.FullRound",
					"Full-round action",
					"Czynność na pełną rundę",
				),
				detailsHint: this._localize(
					"WFRP1ED.Movement.DetailsHint",
					"Click to show movement calculation",
					"Kliknij, aby pokazać obliczenie ruchu",
				),
			},
		);
	}

	static _procedureName(state) {
		const procedure =
			STANDARD_TEST_PROCEDURES[
				String(state?.procedureId ?? "")
			];

		if (procedure) {
			return standardTestProcedureName(procedure);
		}

		return String(
			state?.procedureName ??
			state?.procedureId ??
			"Movement",
		);
	}

	static _dropNoteValue(roll, dropsHeldItems) {
		const outcome = dropsHeldItems
			? this._localize(
				"WFRP1ED.Movement.DropOutcome",
				"drop everything held",
				"upuszcza wszystko, co trzyma",
			)
			: this._localize(
				"WFRP1ED.Movement.RetainOutcome",
				"retain held items",
				"utrzymuje trzymane przedmioty",
			);

		return this._localize(
			"WFRP1ED.Movement.HeldItemsFormula",
			`Held-items check: ${roll} on d100; 01-50 = drop everything held, 51-100 = retain items → ${outcome}.`,
			`Test utrzymania przedmiotów: ${roll} na K100; 01-50 = upuszcza wszystko, 51-100 = utrzymuje przedmioty → ${outcome}.`,
		);
	}

	static _dieLabel(die) {
		if (die === "d100") {
			return game.i18n.lang === "pl" ? "K100" : "d100";
		}
		return game.i18n.lang === "pl" ? "K6" : "d6";
	}

	static _distanceUnit() {
		return game.i18n.lang === "pl" ? "m" : "yd";
	}

	static _positiveNumber(value, label) {
		const number = this._finiteNumber(value, label);
		if (number <= 0) {
			throw new Error(
				`${label} must be greater than zero.`,
			);
		}
		return number;
	}

	static _finiteNumber(value, label) {
		const number = Number(value);
		if (!Number.isFinite(number)) {
			throw new Error(
				`Movement Standard Test '${label}' must be finite: ${String(value)}.`,
			);
		}
		return number;
	}

	static _signed(value) {
		const number = Number(value);
		return number >= 0
			? `+${number}`
			: String(number);
	}

	static _asElement(html) {
		if (html instanceof HTMLElement) return html;
		if (html?.[0] instanceof HTMLElement) return html[0];
		return null;
	}

	static _localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);
		if (localized !== key) {
			return localized;
		}

		return game.i18n.lang === "pl"
			? polishFallback
			: englishFallback;
	}
}
