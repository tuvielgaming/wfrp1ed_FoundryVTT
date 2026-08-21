import { RuleEffectRollSelection } from "../effects/RuleEffectRollSelection.mjs";
import { MOVEMENT_RATE, MovementRates } from "./MovementRates.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { StandardTestDialog } from "../tests/StandardTestDialog.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "../tests/standard-test-procedures.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const MOVEMENT_STATE_VERSION = 4;
const LEAP_EFFECT_TARGET = "procedure.movement.leap.distance";

/*
 * Complete the audited movement-procedure contract without duplicating the
 * existing Jump/Fall implementation.
 *
 * This integration deliberately extends the existing StandardTestDialog and
 * MovementStandardTest public/protected contracts. Jumping continues through
 * the verified executor unchanged. Leaping is corrected to use effective
 * Movement after Encumbrance and the Core no-run-up formula. Running becomes a
 * third non-d100 movement procedure with its own round/underground context.
 */
installStandardTestDialogExtension();
installMovementExecutorExtension();

function installStandardTestDialogExtension() {
	if (StandardTestDialog.__wfrpRunningProcedureInstalled === true) return;
	Object.defineProperty(StandardTestDialog, "__wfrpRunningProcedureInstalled", {
		value: true,
		configurable: false,
	});

	const originalBuildContent = StandardTestDialog._buildContent;
	const originalReadForm = StandardTestDialog._readForm;
	const originalRefreshContextFields = StandardTestDialog._refreshContextFields;

	StandardTestDialog._buildContent = function (actor, entries) {
		const content = originalBuildContent.call(this, actor, entries);
		const body = content?.querySelector?.(".standard-test-dialog-body");
		if (!(body instanceof HTMLElement)) return content;

		const roundGroup = this._numberGroup(
			"runningRound",
			localize("Consecutive running round", "Kolejna runda biegu"),
		);
		roundGroup.root.dataset.standardField = "runningRound";
		roundGroup.input.min = "1";
		roundGroup.input.step = "1";
		roundGroup.input.value = "1";

		const undergroundGroup = this._formGroup(
			localize("Underground / confined running", "Bieg pod ziemią / w zamknięciu"),
		);
		undergroundGroup.root.dataset.standardField = "underground";
		const undergroundInput = document.createElement("input");
		undergroundInput.type = "checkbox";
		undergroundInput.name = "underground";
		undergroundInput.checked = false;
		undergroundInput.title = localize(
			"Underground Running requires a Risk Test with a -10 modifier each round.",
			"Bieg pod ziemią wymaga w każdej rundzie Testu Ryzyka z modyfikatorem -10.",
		);
		undergroundGroup.control.append(undergroundInput);

		const firstD100Only = body.querySelector("[data-standard-d100-only]");
		if (firstD100Only) {
			body.insertBefore(roundGroup.root, firstD100Only);
			body.insertBefore(undergroundGroup.root, firstD100Only);
		} else {
			body.append(roundGroup.root, undergroundGroup.root);
		}

		const select = body.querySelector('select[name="testId"]');
		const entry = entries.find((candidate) => candidate.id === select?.value);
		this._refreshContextFields(body, entry, actor);
		return content;
	};

	StandardTestDialog._readForm = function (actor, form, entries) {
		const id = String(form?.elements?.testId?.value ?? "").trim();
		if (id !== "running") {
			return originalReadForm.call(this, actor, form, entries);
		}

		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry?.procedure) {
			throw new Error("Select a valid WFRP 1e Running procedure.");
		}

		const runningRound = positiveInteger(
			form?.elements?.runningRound?.value,
			localize("Consecutive running round", "Kolejna runda biegu"),
		);

		return {
			confirmed: true,
			kind: "procedure",
			procedureId: id,
			options: {
				runningRound,
				underground: Boolean(form?.elements?.underground?.checked),
			},
		};
	};

	StandardTestDialog._refreshContextFields = function (body, entry, actor) {
		originalRefreshContextFields.call(this, body, entry, actor);
		const tags = new Set(entry?.tags ?? []);
		setFieldVisible(body, "runningRound", tags.has("requires-running-round"));
		setFieldVisible(body, "underground", tags.has("requires-underground"));
	};
}

function installMovementExecutorExtension() {
	if (MovementStandardTest.__wfrpMovementProcedureIntegration === true) return;
	Object.defineProperty(MovementStandardTest, "__wfrpMovementProcedureIntegration", {
		value: true,
		configurable: false,
	});

	const originalExecute = MovementStandardTest.execute;
	const originalPresentation = MovementStandardTest._presentation;
	const originalLeapPresentation = MovementStandardTest._leapPresentation;
	const originalPatchRenderedCard = MovementStandardTest._patchRenderedCard;

	MovementStandardTest.execute = async function (actor, procedureId, options = {}) {
		const id = String(procedureId ?? "").trim();
		if (id === "leap") {
			return executeLeap(this, actor, options);
		}
		if (id === "running") {
			return executeRunning(this, actor, options);
		}
		return originalExecute.call(this, actor, procedureId, options);
	};

	MovementStandardTest._leapResolution = function (state) {
		const movement = finiteNumber(state?.movement, "Movement");
		const dice = finiteNumber(state?.dice, "leap dice");
		const effectBonus = finiteNumber(state?.effectBonus ?? 0, "leap effect bonus");
		const gap = positiveNumber(state?.gap, "leap gap");
		const movementMultiplier = state?.runUp === true ? 2 : 1;
		const baseDistance = movementMultiplier * movement;
		const unboundedDistance = baseDistance - dice + effectBonus;
		const distance = Math.max(1, unboundedDistance);

		return {
			dice,
			baseDistance,
			unboundedDistance,
			distance,
			success: distance >= gap,
		};
	};

	MovementStandardTest._leapPresentation = function (state) {
		const data = originalLeapPresentation.call(this, state);
		const resolution = this._leapResolution(state);
		const calculationRow = data.rows?.[data.rows.length - 2];
		if (calculationRow) {
			calculationRow.value =
				`${resolution.baseDistance} - ${resolution.dice}` +
				(state.effectBonus ? ` + ${state.effectBonus}` : "") +
				` = ${resolution.unboundedDistance}`;
		}

		if (Number(state?.movementPenalty ?? 0) > 0) {
			data.secondaryNote = localize(
				`Encumbrance reduced Movement from ${state.baseMovement} to ${state.movement}.`,
				`Obciążenie zmniejszyło Szybkość z ${state.baseMovement} do ${state.movement}.`,
			);
		}
		return data;
	};

	MovementStandardTest._presentation = function (state) {
		if (state?.kind === "running") return runningPresentation(state);
		return originalPresentation.call(this, state);
	};

	MovementStandardTest._patchRenderedCard = function (card, data) {
		originalPatchRenderedCard.call(this, card, data);
		if (data?.neutral === true) {
			card?.classList?.remove("is-success", "is-failure");
		}
	};
}

async function executeLeap(executor, actor, options) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Leap requires an Actor.");
	}

	const procedure = STANDARD_TEST_PROCEDURES.leap;
	const gap = positiveNumber(options?.leapGap, "leapGap");
	const runUp = options?.runUp === true;
	const movementState = MovementRates.forActor(actor);
	const movement = movementState.movement;
	const effects = RuleEffectRollSelection.resolveNumeric(
		actor,
		LEAP_EFFECT_TARGET,
		options?.ruleEffects,
	);
	const effectBonus = effects.total;
	const diceFormula = runUp ? "1d6" : "2d6";
	const roll = await new Roll(diceFormula).evaluate({ allowInteractive: false });
	const dice = finiteNumber(roll.total, "leap roll");

	const state = {
		version: MOVEMENT_STATE_VERSION,
		kind: "leap",
		actorUuid: actor.uuid,
		procedureId: procedure.id,
		gap,
		runUp,
		movement,
		baseMovement: movementState.baseMovement,
		movementPenalty: movementState.movementPenalty,
		effectBonus,
		effects: effects.entries.map((effect) => ({
			source: String(effect.source ?? ""),
			value: finiteNumber(effect.value, "leap effect"),
		})),
		diceFormula,
		dice,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	return executor._publish(
		actor,
		executor._presentation(state),
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

async function executeRunning(executor, actor, options) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Running requires an Actor.");
	}

	const procedure = STANDARD_TEST_PROCEDURES.running;
	const runningRound = positiveInteger(
		options?.runningRound ?? 1,
		"runningRound",
	);
	const underground = options?.underground === true;
	const movementState = MovementRates.forActor(actor);
	const baseRunningDistance = movementState.rates[MOVEMENT_RATE.RUNNING].round;
	const standardDistance = movementState.rates[MOVEMENT_RATE.STANDARD].round;
	const fatigueLoss = Math.max(0, runningRound - 1);
	const distance = Math.max(
		standardDistance,
		baseRunningDistance - fatigueLoss,
	);

	const state = {
		version: MOVEMENT_STATE_VERSION,
		kind: "running",
		actorUuid: actor.uuid,
		procedureId: procedure.id,
		runningRound,
		underground,
		movement: movementState.movement,
		baseMovement: movementState.baseMovement,
		movementPenalty: movementState.movementPenalty,
		baseRunningDistance,
		standardDistance,
		fatigueLoss,
		distance,
		reducedToStandard: distance <= standardDistance,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const message = await executor._publish(
		actor,
		executor._presentation(state),
		{
			flags: {
				[FLAG_SCOPE]: {
					[MOVEMENT_STATE_FLAG_KEY]: state,
				},
			},
		},
	);

	if (underground) {
		await actor.rollTest("risk", { modifier: -10 });
	}

	return message;
}

function runningPresentation(state) {
	const unit = game.i18n.lang === "pl" ? "m" : "yd";
	const fatigueValue = state.fatigueLoss > 0
		? `-${state.fatigueLoss} ${unit}`
		: `0 ${unit}`;
	const secondaryNotes = [];

	if (state.reducedToStandard) {
		secondaryNotes.push(localize(
			"Running speed has fallen to the Standard rate.",
			"Tempo biegu spadło do tempa Normalnego.",
		));
	}
	if (Number(state.movementPenalty ?? 0) > 0) {
		secondaryNotes.push(localize(
			`Encumbrance reduced Movement from ${state.baseMovement} to ${state.movement}.`,
			`Obciążenie zmniejszyło Szybkość z ${state.baseMovement} do ${state.movement}.`,
		));
	}

	return {
		kind: "running",
		neutral: true,
		success: true,
		procedureName: standardTestProcedureName(STANDARD_TEST_PROCEDURES.running),
		statusLabel: localize(
			`Round ${state.runningRound}`,
			`Runda ${state.runningRound}`,
		),
		fullRoundLabel: localize("Continued running", "Bieg ciągły"),
		detailsHint: localize(
			"Click to show the Running calculation",
			"Kliknij, aby pokazać obliczenie Biegu",
		),
		primaryLabel: localize("Distance this round", "Dystans w tej rundzie"),
		primaryValue: `${state.distance} ${unit}`,
		metricLeftLabel: localize("Effective M", "Efektywna Sz"),
		metricLeftValue: state.movement,
		metricRightLabel: localize("Running", "Bieg"),
		metricRightValue: `${state.distance} ${unit}/10s`,
		rows: [
			{
				label: localize("Base Running rate", "Bazowe tempo Biegu"),
				value: `${state.baseRunningDistance} ${unit}`,
			},
			{
				label: localize("Breathlessness loss", "Utrata tempa przez zmęczenie"),
				value: fatigueValue,
			},
			{
				label: localize("Standard-rate floor", "Dolna granica: Normalnie"),
				value: `${state.standardDistance} ${unit}`,
			},
			{
				label: localize("Underground", "Pod ziemią"),
				value: state.underground
					? localize("Yes", "Tak")
					: localize("No", "Nie"),
			},
		],
		note: state.underground
			? localize(
				"A separate Risk Test at -10 is rolled for this round. On failure the Core rule inflicts D3 Wounds.",
				"Dla tej rundy wykonywany jest osobny Test Ryzyka z modyfikatorem -10. Porażka zgodnie z Księgą Główną powoduje K3 obrażeń.",
			)
			: localize(
				"No Risk Test is required for ordinary open-ground Running.",
				"Przy zwykłym Biegu w otwartym terenie Test Ryzyka nie jest wymagany.",
			),
		secondaryNote: secondaryNotes.join(" "),
		showHeldItemsAction: false,
		heldItemsActionLabel: "",
		heldItemsPhaseLabel: "",
	};
}

function setFieldVisible(body, field, visible) {
	const element = body?.querySelector?.(`[data-standard-field="${field}"]`);
	if (element) element.hidden = !visible;
}

function positiveInteger(value, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) {
		throw new Error(`${label}: value must be a positive integer.`);
	}
	return number;
}

function positiveNumber(value, label) {
	const number = finiteNumber(value, label);
	if (number <= 0) throw new Error(`${label} must be greater than zero.`);
	return number;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be a finite number: ${String(value)}.`);
	}
	return number;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
