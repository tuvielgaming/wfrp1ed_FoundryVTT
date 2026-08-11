import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { HeldItemsCheck } from "../movement/HeldItemsCheck.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "./standard-test-procedures.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const MOVEMENT_STATE_VERSION = 3;
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/movement-test-result.hbs";

const JUMP_EFFECT_TARGET =
	"procedure.movement.jump.reductionDie";
const LEAP_EFFECT_TARGET =
	"procedure.movement.leap.distance";

const HELD_ITEMS_PHASE = Object.freeze({
	PENDING: "pending",
	ROLLING: "rolling",
	RESOLVED: "resolved",
});

const LUCK_ROLL = Object.freeze({
	JUMP_D6: "movement.jump.reduction",
	LEAP_D6: "movement.leap.distance",
});

/**
 * Execute audited WFRP 1e movement procedures.
 *
 * Mechanical source:
 * - English Core Rulebook, printed p. 75, Jumping/Falling/Leaping/Climbing.
 * - Polish Core Rulebook, printed p. 75, Zeskok/Upadek/Skok/Wspinaczka.
 *
 * Movement owns only its primary procedure roll. The 50% held-items check is
 * a dependent consequence and is deliberately resolved later as a separate
 * ChatMessage through HeldItemsCheck. This allows Luck to finalize the Jump
 * first and makes the secondary d100 auditable and independently adjustable.
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
			heldItemsPhase: HELD_ITEMS_PHASE.PENDING,
			heldItemsCheckMessageId: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const message = await this._publish(
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
	 * Describe the currently useful primary movement roll for Luck.
	 *
	 * LuckIntegration consumes only the descriptor. It does not know Jump or
	 * Leap formulas. A dependent held-items roll has its own provider and is not
	 * exposed here anymore.
	 */
	static luckOptions(message) {
		const state = this.stateFor(message);
		if (!state) return [];

		if (state.kind === "jump") {
			const resolution = this._jumpResolution(state);
			if (
				resolution.wounds <= 0 ||
				this._jumpIsFinalizedForHeldItems(state)
			) {
				return [];
			}

			return [
				Object.freeze({
					id: LUCK_ROLL.JUMP_D6,
					die: "d6",
					delta: 1,
					value: resolution.die,
					label: this._localize(
						"WFRP1ED.Luck.Roll.Jump",
						"Jump d6",
						"K6 Zeskoku",
					),
					blocksAfterDamage: true,
				}),
			];
		}

		if (state.kind === "leap") {
			const resolution = this._leapResolution(state);
			if (resolution.success) return [];

			return [
				Object.freeze({
					id: LUCK_ROLL.LEAP_D6,
					die: "d6",
					delta: -1,
					value: resolution.dice,
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

	static async applyLuck(message, rollId, delta) {
		const option = this.luckOptions(message).find(
			(entry) =>
				entry.id === String(rollId ?? "") &&
				entry.delta === Number(delta),
		);
		if (!option) {
			throw new Error(
				"This movement roll cannot be adjusted by Luck.",
			);
		}

		const state = foundry.utils.deepClone(this.stateFor(message));
		const number = Number(delta);
		let originalRoll;
		let adjustedRoll;

		switch (String(rollId)) {
			case LUCK_ROLL.JUMP_D6:
				originalRoll = this._finiteNumber(state.die, "jump roll");
				adjustedRoll = originalRoll + number;
				state.die = adjustedRoll;
				break;
			case LUCK_ROLL.LEAP_D6:
				originalRoll = this._finiteNumber(state.dice, "leap dice");
				adjustedRoll = originalRoll + number;
				state.dice = adjustedRoll;
				break;
			default:
				throw new Error(
					`Unknown movement Luck roll '${String(rollId)}'.`,
				);
		}

		state.updatedAt = Date.now();
		await this._updateMessageState(message, state);

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
	 * Activate the dependent held-items action on a rendered Jump card.
	 */
	static activateListeners(message, html) {
		const state = this.stateFor(message);
		if (state?.kind !== "jump") return;

		const root = this._asElement(html);
		const card = root?.matches?.(".wfrp1e-test-card")
			? root
			: root?.querySelector?.(".wfrp1e-test-card");
		const button = card?.querySelector?.(
			"[data-wfrp-held-items-roll]",
		);
		if (!(button instanceof HTMLButtonElement)) return;

		if (!this.canStartHeldItemsCheck(message, game.user)) {
			button.hidden = true;
			return;
		}

		button.hidden = false;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			button.disabled = true;
			void this._startHeldItemsCheck(message)
				.catch((error) => {
					console.error(
						"WFRP1ED | Held-items check failed.",
						error,
					);
					ui.notifications.error(
						error?.message ??
							this._localize(
								"WFRP1ED.Movement.HeldItemsError",
								"Unable to roll the held-items check.",
								"Nie udało się wykonać testu utrzymania przedmiotów.",
							),
					);
				})
				.finally(() => {
					button.disabled = false;
				});
		});
	}

	static canStartHeldItemsCheck(message, user = game.user) {
		const state = this.stateFor(message);
		if (state?.kind !== "jump" || !user) return false;
		if (this._jumpResolution(state).wounds <= 0) return false;
		if (this._jumpIsFinalizedForHeldItems(state)) return false;
		if (state.heldItemsPhase === HELD_ITEMS_PHASE.ROLLING) return false;

		const actor = this._actorForStateSync(state);
		if (!(actor instanceof foundry.documents.Actor)) return false;

		const canManage = user.isGM || actor.testUserPermission(
			user,
			CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
		);
		if (!canManage) return false;

		return user.isGM || message?.canUserModify?.(user, "update") === true;
	}

	static async _startHeldItemsCheck(message) {
		if (!this.canStartHeldItemsCheck(message, game.user)) {
			throw new Error(
				this._localize(
					"WFRP1ED.Movement.HeldItemsNotAvailable",
					"The held-items check is not available for this Jump result.",
					"Test utrzymania przedmiotów nie jest dostępny dla tego wyniku Zeskoku.",
				),
			);
		}

		const state = foundry.utils.deepClone(this.stateFor(message));
		const actor = await foundry.utils.fromUuid(state.actorUuid);
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error(
				"The Actor for this Jump result is no longer available.",
			);
		}

		state.heldItemsPhase = HELD_ITEMS_PHASE.ROLLING;
		state.updatedAt = Date.now();
		await this._updateMessageState(message, state);

		try {
			const resultMessage = await HeldItemsCheck.publish({
				actor,
				sourceMessage: message,
			});

			state.heldItemsPhase = HELD_ITEMS_PHASE.RESOLVED;
			state.heldItemsCheckMessageId = resultMessage.id;
			state.updatedAt = Date.now();
			await this._updateMessageState(message, state);
			return resultMessage;
		} catch (error) {
			state.heldItemsPhase = HELD_ITEMS_PHASE.PENDING;
			state.heldItemsCheckMessageId = null;
			state.updatedAt = Date.now();
			await this._updateMessageState(message, state);
			throw error;
		}
	}

	/**
	 * Localize movement presentation independently for each current client.
	 */
	static applyClientLocalization(message, html) {
		const state = this.stateFor(message);
		if (!state) return;

		const root = this._asElement(html);
		const card = root?.matches?.(".wfrp1e-test-card")
			? root
			: root?.querySelector?.(".wfrp1e-test-card");
		if (!card) return;

		this._patchRenderedCard(card, this._presentation(state));
	}

	static _patchRenderedCard(card, data) {
		card.classList.toggle("is-success", data.success === true);
		card.classList.toggle("is-failure", data.success !== true);

		const title = card.querySelector(".wfrp1e-test-card__header h2");
		if (title) title.textContent = data.procedureName;

		const status = card.querySelector(".wfrp1e-test-card__status");
		if (status) {
			status.textContent = data.statusLabel;
		}

		const details = card.querySelector(".wfrp1e-test-card__target");
		const summary = details?.querySelector(":scope > summary");
		if (summary) summary.title = data.detailsHint;

		const primaryLabel = card.querySelector(
			".wfrp1e-test-card__target-label",
		);
		if (primaryLabel) primaryLabel.textContent = data.primaryLabel;

		const primaryValue = card.querySelector(
			".wfrp1e-test-card__target-value",
		);
		if (primaryValue) primaryValue.textContent = String(data.primaryValue);

		const sections = [
			...card.querySelectorAll(".wfrp1e-test-card__breakdown-section"),
		];
		const calculationSection = sections[0] ?? null;
		const sectionTitle = calculationSection?.querySelector(
			".wfrp1e-test-card__section-title",
		);
		if (sectionTitle) sectionTitle.textContent = data.fullRoundLabel;

		const rows = calculationSection
			? [...calculationSection.querySelectorAll(
				".wfrp1e-test-card__breakdown-row",
			)]
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
			...card.querySelectorAll(".wfrp1e-test-card__section-subtitle"),
		];
		const localizedNotes = [data.note, data.secondaryNote].filter(Boolean);
		subtitles.forEach((element, index) => {
			element.textContent = String(localizedNotes[index] ?? "");
		});

		const metrics = [...card.querySelectorAll(".wfrp1e-test-card__metric")];
		this._patchMetric(metrics[0], data.metricLeftLabel, data.metricLeftValue);
		this._patchMetric(metrics[1], data.metricRightLabel, data.metricRightValue);

		const actionButton = card.querySelector("[data-wfrp-held-items-roll]");
		if (actionButton) actionButton.textContent = data.heldItemsActionLabel;
		const phase = card.querySelector("[data-wfrp-held-items-phase]");
		if (phase) phase.textContent = data.heldItemsPhaseLabel;
	}

	static _patchMetric(metric, labelText, valueText) {
		if (!metric) return;
		const label = metric.querySelector("span");
		const value = metric.querySelector("strong");
		if (label) label.textContent = String(labelText);
		if (value) value.textContent = String(valueText);
	}

	static _presentation(state) {
		let data;
		switch (state?.kind) {
			case "jump":
				data = this._jumpPresentation(state);
				break;
			case "leap":
				data = this._leapPresentation(state);
				break;
			default:
				throw new Error(
					`Unsupported movement state '${String(state?.kind)}'.`,
				);
		}

		return {
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
		};
	}

	static _jumpPresentation(state) {
		const { die, effectiveDie, wounds } = this._jumpResolution(state);
		const effects = Array.isArray(state.effects) ? state.effects : [];
		const phase = this._normalizedHeldItemsPhase(state);
		const showHeldItemsAction =
			wounds > 0 &&
			phase === HELD_ITEMS_PHASE.PENDING &&
			!state.heldItemsCheckMessageId;
		let heldItemsPhaseLabel = "";

		if (wounds > 0 && phase === HELD_ITEMS_PHASE.ROLLING) {
			heldItemsPhaseLabel = this._localize(
				"WFRP1ED.Movement.HeldItemsRolling",
				"Rolling held-items check…",
				"Trwa test utrzymania przedmiotów…",
			);
		} else if (wounds > 0 && this._jumpIsFinalizedForHeldItems(state)) {
			heldItemsPhaseLabel = this._localize(
				"WFRP1ED.Movement.HeldItemsResolved",
				"Held-items check resolved in a separate chat message.",
				"Test utrzymania przedmiotów rozstrzygnięto w osobnej wiadomości.",
			);
		}

		return {
			kind: "jump",
			procedureName: this._procedureName(state),
			success: wounds === 0,
			primaryLabel: this._localize(
				"WFRP1ED.Movement.Height",
				"Height",
				"Wysokość",
			),
			primaryValue: `${state.height} ${this._distanceUnit()}`,
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
			secondaryNote: "",
			showHeldItemsAction,
			heldItemsActionLabel: this._localize(
				"WFRP1ED.Movement.RollHeldItems",
				"Roll held-items check",
				"Rzuć test utrzymania przedmiotów",
			),
			heldItemsPhaseLabel,
		};
	}

	static _leapPresentation(state) {
		const {
			dice,
			distance,
			unboundedDistance,
			success,
		} = this._leapResolution(state);
		const effects = Array.isArray(state.effects) ? state.effects : [];

		return {
			kind: "leap",
			procedureName: this._procedureName(state),
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
			metricLeftValue: `${state.gap} ${this._distanceUnit()}`,
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
					value: state.movement,
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.RunUp",
						"Run-up",
						"Rozbieg",
					),
					value: state.runUp
						? this._localize("WFRP1ED.Yes", "Yes", "Tak")
						: this._localize("WFRP1ED.No", "No", "Nie"),
				},
				{
					label: this._localize(
						"WFRP1ED.Movement.Dice",
						"Dice",
						"Kości",
					),
					value: `${state.diceFormula}: ${dice}`,
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
						(state.effectBonus ? ` + ${state.effectBonus}` : "") +
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
			showHeldItemsAction: false,
			heldItemsActionLabel: "",
			heldItemsPhaseLabel: "",
		};
	}

	static _jumpResolution(state) {
		const die = this._finiteNumber(state.die, "jump roll");
		const effectBonus = this._finiteNumber(
			state.effectBonus ?? 0,
			"jump effect bonus",
		);
		const height = this._positiveNumber(state.height, "jump height");
		const effectiveDie = die + effectBonus;
		return {
			die,
			effectBonus,
			effectiveDie,
			wounds: Math.max(0, height - effectiveDie),
		};
	}

	static _leapResolution(state) {
		const movement = this._finiteNumber(state.movement, "Movement");
		const dice = this._finiteNumber(state.dice, "leap dice");
		const effectBonus = this._finiteNumber(
			state.effectBonus ?? 0,
			"leap effect bonus",
		);
		const gap = this._positiveNumber(state.gap, "leap gap");
		const unboundedDistance = 2 * movement - dice + effectBonus;
		const distance = Math.max(1, unboundedDistance);
		return {
			dice,
			unboundedDistance,
			distance,
			success: distance >= gap,
		};
	}

	static _normalizedHeldItemsPhase(state) {
		if (state?.heldItemsCheckMessageId) return HELD_ITEMS_PHASE.RESOLVED;
		return Object.values(HELD_ITEMS_PHASE).includes(state?.heldItemsPhase)
			? state.heldItemsPhase
			: HELD_ITEMS_PHASE.PENDING;
	}

	static _jumpIsFinalizedForHeldItems(state) {
		return this._normalizedHeldItemsPhase(state) !== HELD_ITEMS_PHASE.PENDING ||
			Boolean(state?.heldItemsCheckMessageId);
	}

	static _actorForStateSync(state) {
		try {
			const actor = foundry.utils.fromUuidSync(String(state?.actorUuid ?? ""));
			return actor instanceof foundry.documents.Actor ? actor : null;
		} catch (_error) {
			return null;
		}
	}

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
				label: STANDARD_TEST_PROCEDURES.jump?.label ?? "Jump",
			},
			armour: DAMAGE_MITIGATION_POLICY.IGNORE,
			toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
			criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		});
		const resolution = DamageResolver.resolve(packet);
		await DamageChat.attach(message, { packet, resolution });
	}

	static async _updateMessageState(message, state) {
		const content = await this._render(this._presentation(state));
		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${MOVEMENT_STATE_FLAG_KEY}`]: state,
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
			data,
		);
	}

	static _procedureName(state) {
		const procedure = STANDARD_TEST_PROCEDURES[
			String(state?.procedureId ?? "")
		];
		if (procedure) return standardTestProcedureName(procedure);
		return String(
			state?.procedureName ?? state?.procedureId ?? "Movement",
		);
	}

	static _dieLabel(die) {
		if (die === "d100") return game.i18n.lang === "pl" ? "K100" : "d100";
		return game.i18n.lang === "pl" ? "K6" : "d6";
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

	static _asElement(html) {
		if (html instanceof HTMLElement) return html;
		if (html?.[0] instanceof HTMLElement) return html[0];
		return null;
	}

	static _localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);
		if (localized !== key) return localized;
		return game.i18n.lang === "pl" ? polishFallback : englishFallback;
	}
}

Hooks.on("renderChatMessageHTML", (message, html) => {
	MovementStandardTest.activateListeners(message, html);
});
