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
const MOVEMENT_STATE_VERSION = 1;
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/movement-test-result.hbs";
const JUMP_EFFECT_TARGET =
	"procedure.movement.jump.reductionDie";
const LEAP_EFFECT_TARGET =
	"procedure.movement.leap.distance";

/**
 * Execute WFRP 1e movement procedures exposed through the Standard Test
 * launcher but deliberately kept outside the percentile Test/TestResult model.
 *
 * Mechanics authority:
 * - English Core Rulebook, printed p. 75, Jumping/Falling/Leaping/Climbing.
 * - Polish Core Rulebook, printed p. 75, Zeskok/Upadek/Skok/Wspinaczka.
 * - English Skills, printed pp. 46 and 48, Acrobatics and Clown.
 * - Polish Skills, printed p. 46, Akrobatyka and Błaznowanie.
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

	/**
	 * Resolve controlled vertical Jumping / Zeskok.
	 *
	 * The resolved inputs are persisted on the ChatMessage so Luck/Szczęście can
	 * change the d6 by +1 after the roll and safely rebuild both the presentation
	 * and the still-unapplied generic DamagePacket without parsing rendered HTML.
	 */
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
		const initialWounds = Math.max(0, height - (die + effectBonus));

		let dropRoll = null;
		let dropsHeldItems = false;

		if (initialWounds > 0) {
			dropRoll = await new Roll("1d100").evaluate();
			dropsHeldItems =
				this._finiteNumber(dropRoll.total, "drop roll") <= 50;
		}

		const procedureName = standardTestProcedureName(procedure);
		const state = {
			version: MOVEMENT_STATE_VERSION,
			kind: "jump",
			actorUuid: actor.uuid,
			procedureId: procedure.id ?? "jump",
			procedureName,
			enteredHeight,
			height,
			effectBonus,
			effects: effects.entries.map((effect) => ({
				source: String(effect.source ?? ""),
				value: this._finiteNumber(effect.value, "jump effect"),
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
			this._jumpPresentation(state),
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

	/**
	 * Return persisted movement state when the message supports post-roll
	 * movement adjudication.
	 */
	static stateFor(message) {
		const state = message?.getFlag?.(
			FLAG_SCOPE,
			MOVEMENT_STATE_FLAG_KEY,
		);

		return state && typeof state === "object" && !Array.isArray(state)
			? state
			: null;
	}

	/**
	 * Whether Luck may modify this movement result.
	 *
	 * Current audited support is intentionally limited to controlled Jumping:
	 * its single d6 is a direct result where +1 is always beneficial. Leaping
	 * can use 1d6 or 2d6 and needs its own dedicated Luck audit before exposure.
	 */
	static canApplyLuck(message, delta) {
		const state = this.stateFor(message);
		return state?.kind === "jump" && Number(delta) === 1;
	}

	/**
	 * Apply the audited +1 Luck adjustment to an unresolved Jump result.
	 *
	 * Damage must still be unapplied. The original Roll object remains attached
	 * to the ChatMessage as the physical dice audit; the movement state records
	 * the effective post-Luck d6 and the card is recalculated from that state.
	 */
	static async applyLuck(message, delta) {
		if (!this.canApplyLuck(message, delta)) {
			throw new Error(
				"This movement result cannot be adjusted by Luck.",
			);
		}

		const state = foundry.utils.deepClone(this.stateFor(message));
		const originalRoll = this._finiteNumber(state.die, "jump roll");
		const adjustedRoll = originalRoll + Number(delta);

		state.die = adjustedRoll;
		state.updatedAt = Date.now();

		const content = await this._render(
			this._jumpPresentation(state),
		);

		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${MOVEMENT_STATE_FLAG_KEY}`]: state,
		});

		await this._synchronizeJumpDamage(message, state);

		return Object.freeze({
			originalRoll,
			adjustedRoll,
			delta: Number(delta),
		});
	}

	/**
	 * Rebuild the generic damage attachment after a post-roll Jump adjustment.
	 *
	 * Polish note: nie modyfikujemy Żywotności tutaj. Zmieniamy wyłącznie
	 * oczekujący DamagePacket; faktyczne obrażenia nadal wymagają jawnej akcji
	 * „Zastosuj obrażenia”.
	 */
	static async _synchronizeJumpDamage(message, state) {
		const { wounds } = this._jumpResolution(state);
		const existingDamage = message?.getFlag?.(FLAG_SCOPE, "damageState");

		if (wounds <= 0) {
			if (existingDamage) {
				await message.unsetFlag(FLAG_SCOPE, "damageState");
			}
			return;
		}

		const actor = await foundry.utils.fromUuid(state.actorUuid);
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
				label: state.procedureName,
			},
			armour: DAMAGE_MITIGATION_POLICY.IGNORE,
			toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
			criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		});
		const resolution = DamageResolver.resolve(packet);

		await DamageChat.attach(message, { packet, resolution });
	}

	static _jumpResolution(state) {
		const die = this._finiteNumber(state.die, "jump roll");
		const effectBonus = this._finiteNumber(
			state.effectBonus ?? 0,
			"jump effect bonus",
		);
		const height = this._positiveNumber(state.height, "jump height");
		const effectiveDie = die + effectBonus;
		const wounds = Math.max(0, height - effectiveDie);

		return { die, effectBonus, effectiveDie, wounds };
	}

	static _jumpPresentation(state) {
		const { die, effectiveDie, wounds } = this._jumpResolution(state);
		const effects = Array.isArray(state.effects) ? state.effects : [];
		const dropRoll = state.dropRoll === null || state.dropRoll === undefined
			? null
			: this._finiteNumber(state.dropRoll, "drop roll");

		return {
			kind: "jump",
			procedureName: state.procedureName,
			success: wounds === 0,
			primaryLabel: this._localize(
				"WFRP1ED.Movement.Height",
				"Height",
				"Wysokość",
			),
			primaryValue: `${state.height} ${this._distanceUnit()}`,
			metricLeftLabel: "K6",
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
					value: `${state.enteredHeight} ${this._distanceUnit()}`,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.RoundedHeight",
						"Rounded height",
						"Wysokość po zaokrągleniu",
					),
					value: `${state.height} ${this._distanceUnit()}`,
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
					value: `${state.height} - ${effectiveDie} = ${wounds}`,
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
			secondaryNote: wounds > 0 && dropRoll !== null
				? this._dropNoteValue(dropRoll, state.dropsHeldItems === true)
				: "",
			fullRound: true,
		};
	}

	/** Resolve horizontal Leaping / Skok. */
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
		const unboundedDistance =
			2 * movement - dice + effectBonus;
		const distance = Math.max(1, unboundedDistance);
		const success = distance >= gap;

		return this._publish(actor, {
			kind: "leap",
			procedureName: standardTestProcedureName(procedure),
			success,
			primaryLabel: this._localize(
				"WFRP1ED.Movement.Distance",
				"Distance",
				"Dystans",
			),
			primaryValue: `${distance} ${this._distanceUnit()}`,
			metricLeftLabel: this._localize(
				"WFRP1ED.Movement.Required",
				"Required",
				"Wymagane",
			),
			metricLeftValue: `${gap} ${this._distanceUnit()}`,
			metricRightLabel: this._localize(
				"WFRP1ED.Movement.Achieved",
				"Achieved",
				"Osiągnięto",
			),
			metricRightValue: `${distance} ${this._distanceUnit()}`,
			rows: [
				{
					label: this._localize(
						"WFRP1ED.Movement.Movement",
						"Movement",
						"Szybkość",
					),
					value: movement,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.RunUp",
						"Run-up",
						"Rozbieg",
					),
					value: runUp
						? this._localize("Yes", "Yes", "Tak")
						: this._localize("No", "No", "Nie"),
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.Dice",
						"Dice",
						"Kości",
					),
					value: `${diceFormula}: ${dice}`,
				},
				...effects.entries.map((effect) => ({
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
						`${2 * movement} - ${dice}` +
						(effectBonus ? ` + ${effectBonus}` : "") +
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
		}, { rolls: [roll] });
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

	static _dropNote(dropRoll, dropsHeldItems) {
		return this._dropNoteValue(
			this._finiteNumber(dropRoll?.total, "drop roll"),
			dropsHeldItems,
		);
	}

	static _dropNoteValue(roll, dropsHeldItems) {
		return dropsHeldItems
			? this._localize(
				"WFRP1ED.Movement.DropHeldYes",
				`Held items: ${roll} on d100 - drop everything held.`,
				`Trzymane przedmioty: ${roll} na K100 - bohater upuszcza wszystko, co trzyma.`,
			)
			: this._localize(
				"WFRP1ED.Movement.DropHeldNo",
				`Held items: ${roll} on d100 - retained.`,
				`Trzymane przedmioty: ${roll} na K100 - bohater utrzymuje trzymane przedmioty.`,
			);
	}

	static _distanceUnit() {
		return game.i18n.lang === "pl" ? "m" : "yd";
	}

	static _positiveNumber(value, label) {
		const number = this._finiteNumber(value, label);
		if (number <= 0) {
			throw new Error(`${label} must be greater than zero.`);
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
		return number >= 0 ? `+${number}` : String(number);
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
