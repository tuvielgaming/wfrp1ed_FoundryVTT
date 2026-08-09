import { StandardTestSkillResolver } from "./StandardTestSkillResolver.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "./standard-test-procedures.mjs";

const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/movement-test-result.hbs";

const MOVEMENT_SKILL_BONUSES = Object.freeze({
	acrobatics: Object.freeze({
		jumpDie: 2,
		leapDistance: 2,
	}),
	clown: Object.freeze({
		jumpDie: 1,
		leapDistance: 0,
	}),
});

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
	/**
	 * Execute one registered movement procedure.
	 *
	 * @param {Actor} actor
	 * @param {string} procedureId
	 * @param {Object} options
	 * @returns {Promise<ChatMessage>}
	 */
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
	 * Distance is rounded up to the next whole yard/metre. Roll 1d6, add the
	 * applicable Acrobatics/Clown die bonuses, then subtract that effective die
	 * result from the rounded distance. A positive remainder is Wounds suffered,
	 * ignoring armour and Toughness. If Wounds are suffered, a separate 50%
	 * check determines whether held items are dropped.
	 *
	 * This procedure reports Wounds but does not mutate Actor Wounds yet because
	 * the repository does not currently provide one audited common Wounds update
	 * contract for Character and NPC Actor types.
	 *
	 * @protected
	 */
	static async _executeJump(actor, procedure, options) {
		const enteredHeight = this._positiveNumber(
			options.jumpHeight,
			"jumpHeight",
		);
		const height = Math.ceil(enteredHeight);
		const skills = this._movementSkills(actor, "jump");
		const skillBonus = skills.reduce(
			(total, skill) =>
				total + (MOVEMENT_SKILL_BONUSES[skill.rulesId]?.jumpDie ?? 0),
			0,
		);

		const roll = await new Roll("1d6").evaluate();
		const die = this._finiteNumber(roll.total, "jump roll");
		const effectiveDie = die + skillBonus;
		const wounds = Math.max(0, height - effectiveDie);

		let dropRoll = null;
		let dropsHeldItems = false;

		if (wounds > 0) {
			dropRoll = await new Roll("1d100").evaluate();
			dropsHeldItems =
				this._finiteNumber(dropRoll.total, "drop roll") <= 50;
		}

		return this._publish(actor, {
			kind: "jump",
			procedureName: standardTestProcedureName(procedure),
			success: wounds === 0,
			primaryLabel: this._localize(
				"WFRP1ED.Movement.Height",
				"Height",
				"Wysokość",
			),
			primaryValue: `${height} ${this._distanceUnit()}`,
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
					value: `${enteredHeight} ${this._distanceUnit()}`,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.RoundedHeight",
						"Rounded height",
						"Wysokość po zaokrągleniu",
					),
					value: `${height} ${this._distanceUnit()}`,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.DieRoll",
						"d6 roll",
						"Rzut K6",
					),
					value: die,
				},
				...skills.map((skill) => ({
					label: skill.name,
					value: this._signed(
						MOVEMENT_SKILL_BONUSES[skill.rulesId]?.jumpDie ?? 0,
					),
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
					value: `${height} - ${effectiveDie} = ${wounds}`,
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
		secondaryNote: wounds > 0
				? this._dropNote(dropRoll, dropsHeldItems)
				: "",
		fullRound: true,
		rolls: dropRoll ? [roll, dropRoll] : [roll],
		});
	}

	/**
	 * Resolve horizontal Leaping / Skok.
	 *
	 * With at least two yards/metres run-up the achieved distance is
	 * 2 * Movement - 1d6. Without sufficient run-up it is 2 * Movement - 2d6.
	 * The minimum result is one yard/metre. Acrobatics adds two yards/metres.
	 * A character who does not reach the required gap falls.
	 *
	 * @protected
	 */
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
		const skills = this._movementSkills(actor, "leap");
		const skillBonus = skills.reduce(
			(total, skill) =>
				total +
					(MOVEMENT_SKILL_BONUSES[skill.rulesId]?.leapDistance ?? 0),
			0,
		);
		const diceFormula = runUp ? "1d6" : "2d6";
		const roll = await new Roll(diceFormula).evaluate();
		const dice = this._finiteNumber(roll.total, "leap roll");
		const unboundedDistance =
			2 * movement - dice + skillBonus;
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
				"Osiągnięte",
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
				...skills.map((skill) => ({
					label: skill.name,
					value: this._signed(
						MOVEMENT_SKILL_BONUSES[skill.rulesId]?.leapDistance ?? 0,
					),
				})),
				{
					label: this._localize(
						"WFRP1ED.Movement.Calculation",
						"Calculation",
						"Obliczenie",
					),
					value:
						`${2 * movement} - ${dice}` +
						(skillBonus ? ` + ${skillBonus}` : "") +
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
		rolls: [roll],
		});
	}

	/**
	 * Return owned movement-relevant Skills through the existing stable
	 * StandardTestSkillResolver contract.
	 *
	 * @protected
	 */
	static _movementSkills(actor, procedureId) {
		return StandardTestSkillResolver.candidates(
			actor,
			procedureId,
		).filter((candidate) =>
			Object.hasOwn(MOVEMENT_SKILL_BONUSES, candidate.rulesId),
		);
	}

	/** @protected */
	static async _publish(actor, data) {
		const content =
			await foundry.applications.handlebars.renderTemplate(
				TEMPLATE_PATH,
				{
					...data,
					actorName: actor.name,
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

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content,
			rolls: data.rolls ?? [],
		});
	}

	/** @protected */
	static _dropNote(dropRoll, dropsHeldItems) {
		const roll = this._finiteNumber(
			dropRoll?.total,
			"drop roll",
		);

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

	/** @protected */
	static _distanceUnit() {
		return game.i18n.lang === "pl" ? "m" : "yd";
	}

	/** @protected */
	static _positiveNumber(value, label) {
		const number = this._finiteNumber(value, label);

		if (number <= 0) {
			throw new Error(`${label} must be greater than zero.`);
		}

		return number;
	}

	/** @protected */
	static _finiteNumber(value, label) {
		const number = Number(value);

		if (!Number.isFinite(number)) {
			throw new Error(
				`Movement Standard Test '${label}' must be finite: ${String(value)}.`,
			);
		}

		return number;
	}

	/** @protected */
	static _signed(value) {
		return value >= 0 ? `+${value}` : String(value);
	}

	/** @protected */
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
