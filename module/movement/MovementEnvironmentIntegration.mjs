import { INVENTORY_MODE } from "../data-models/item/InventoryItemFields.mjs";
import { WfrpCheckbox } from "../ui/WfrpCheckbox.mjs";
import { MOVEMENT_RATE, MovementRates } from "./MovementRates.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { StandardTestDialog } from "../tests/StandardTestDialog.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "../tests/standard-test-procedures.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const MOVEMENT_STATE_VERSION = 5;

const PACE = Object.freeze({
	CAUTIOUS: "cautious",
	STANDARD: "standard",
	RUNNING: "running",
});

const CLIMB_TYPE = Object.freeze({
	ORDINARY: "ordinary",
	SHEER: "sheer",
	ROPE: "rope",
	FIXED_LADDER: "fixedLadder",
});

/*
 * WFRP 1e Core movement-environment procedures.
 *
 * Mechanics authority:
 * - English Core Rulebook, Time and Motion, printed p.74:
 *   Obstacles, Difficult Ground, Swimming.
 * - English Core Rulebook, printed p.75:
 *   Climbing and Ropes and Ladders.
 * - Polish Core Rulebook, printed pp.74-75:
 *   Przeszkody, Trudny teren, Pływanie, Wspinaczka, Sznury i drabiny.
 *
 * This integration extends the existing movement procedure launcher rather than
 * creating a parallel test system. Any required Risk Test therefore continues
 * through Actor.rollTest("risk") and inherits the verified Risk/K3 lifecycle.
 */
installDialogExtension();
installExecutorExtension();

function installDialogExtension() {
	if (StandardTestDialog.__wfrpEnvironmentMovementInstalled === true) return;
	Object.defineProperty(StandardTestDialog, "__wfrpEnvironmentMovementInstalled", {
		value: true,
		configurable: false,
	});

	const originalBuildContent = StandardTestDialog._buildContent;
	const originalReadForm = StandardTestDialog._readForm;
	const originalRefreshContextFields = StandardTestDialog._refreshContextFields;
	const originalActivateDialog = StandardTestDialog._activateDialog;

	StandardTestDialog._buildContent = function (actor, entries) {
		const content = originalBuildContent.call(this, actor, entries);
		const body = content?.querySelector?.(".standard-test-dialog-body");
		if (!(body instanceof HTMLElement)) return content;

		const paceGroup = this._formGroup(
			localize("Movement pace", "Tempo ruchu"),
		);
		paceGroup.root.dataset.standardField = "movementPace";
		const paceSelect = document.createElement("select");
		paceSelect.name = "movementPace";
		appendOptions(paceSelect, [
			[PACE.CAUTIOUS, localize("Cautious", "Ostrożnie")],
			[PACE.STANDARD, localize("Standard", "Normalnie")],
			[PACE.RUNNING, localize("Running", "Biegiem")],
		]);
		paceGroup.control.append(paceSelect);

		const swimHazardGroup = this._formGroup(
			localize("Hazardous swimming conditions", "Niebezpieczne warunki pływania"),
		);
		swimHazardGroup.root.dataset.standardField = "swimmingHazard";
		const swimHazard = WfrpCheckbox.create({
			name: "swimmingHazard",
			checked: false,
			title: localize(
				"Rough water, tied hands, or a comparable hazard requires a Risk Test.",
				"Wzburzona woda, związane ręce lub podobne zagrożenie wymagają Testu Ryzyka.",
			),
			ariaLabel: localize(
				"Hazardous swimming conditions",
				"Niebezpieczne warunki pływania",
			),
		});
		swimHazardGroup.control.append(swimHazard.root);

		const swimModifierGroup = this._numberGroup(
			"swimmingOtherModifier",
			localize(
				"Other encumbrance modifier (GM)",
				"Inny modyfikator obciążenia (MG)",
			),
		);
		swimModifierGroup.root.dataset.standardField = "swimmingOtherModifier";
		swimModifierGroup.input.value = "0";
		swimModifierGroup.input.step = "1";
		swimModifierGroup.input.title = localize(
			"The Core leaves other encumbering items to GM judgement. Enter any additional modifier here.",
			"Księga Główna pozostawia wpływ innych obciążających przedmiotów decyzji MG. Wprowadź tu dodatkowy modyfikator.",
		);

		const climbTypeGroup = this._formGroup(
			localize("Climbing type", "Rodzaj wspinaczki"),
		);
		climbTypeGroup.root.dataset.standardField = "climbType";
		const climbTypeSelect = document.createElement("select");
		climbTypeSelect.name = "climbType";
		appendOptions(climbTypeSelect, [
			[CLIMB_TYPE.ORDINARY, localize("Non-sheer surface", "Powierzchnia niezbyt stroma")],
			[CLIMB_TYPE.SHEER, localize("Sheer surface", "Powierzchnia stroma / pionowa")],
			[CLIMB_TYPE.ROPE, localize("Rope / non-fixed ladder", "Lina / drabina niestała")],
			[CLIMB_TYPE.FIXED_LADDER, localize("Fixed ladder", "Drabina stała")],
		]);
		climbTypeGroup.control.append(climbTypeSelect);

		const climbDangerGroup = this._formGroup(
			localize("Dangerous climb", "Niebezpieczna wspinaczka"),
		);
		climbDangerGroup.root.dataset.standardField = "climbDanger";
		const climbDanger = WfrpCheckbox.create({
			name: "climbDanger",
			checked: false,
			title: localize(
				"A dangerous climb requires a Risk Test; failure means a fall.",
				"Niebezpieczna wspinaczka wymaga Testu Ryzyka; porażka oznacza upadek.",
			),
			ariaLabel: localize("Dangerous climb", "Niebezpieczna wspinaczka"),
		});
		climbDangerGroup.control.append(climbDanger.root);

		const sheerAccessGroup = this._formGroup(
			localize(
				"Suitable equipment / ability confirmed",
				"Potwierdzono odpowiedni sprzęt / umiejętność",
			),
		);
		sheerAccessGroup.root.dataset.standardField = "climbSheerAccess";
		const sheerAccess = WfrpCheckbox.create({
			name: "climbSheerAccess",
			checked: false,
			title: localize(
				"Sheer surfaces require suitable ropes/grapples or the Core ability that permits sheer climbing.",
				"Strome/pionowe powierzchnie wymagają odpowiedniej liny/haków albo zdolności z Księgi Głównej pozwalającej na taką wspinaczkę.",
			),
			ariaLabel: localize(
				"Suitable sheer-climbing equipment or ability confirmed",
				"Potwierdzono odpowiedni sprzęt lub umiejętność do wspinaczki po stromej powierzchni",
			),
		});
		sheerAccessGroup.control.append(sheerAccess.root);

		const firstD100Only = body.querySelector("[data-standard-d100-only]");
		const fields = [
			paceGroup.root,
			swimHazardGroup.root,
			swimModifierGroup.root,
			climbTypeGroup.root,
			climbDangerGroup.root,
			sheerAccessGroup.root,
		];
		for (const field of fields) {
			if (firstD100Only) body.insertBefore(field, firstD100Only);
			else body.append(field);
		}

		const select = body.querySelector('select[name="testId"]');
		const entry = entries.find((candidate) => candidate.id === select?.value);
		this._refreshContextFields(body, entry, actor);
		return content;
	};

	StandardTestDialog._readForm = function (actor, form, entries) {
		const id = String(form?.elements?.testId?.value ?? "").trim();
		if (!ENVIRONMENT_PROCEDURES.has(id)) {
			return originalReadForm.call(this, actor, form, entries);
		}

		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry?.procedure) {
			throw new Error(localize(
				"Select a valid WFRP 1e movement procedure.",
				"Wybierz prawidłową procedurę ruchu WFRP 1e.",
			));
		}

		const options = {};
		if (id === "obstacle" || id === "difficultGround") {
			options.movementPace = normalizePace(form?.elements?.movementPace?.value);
		}
		if (id === "swimming") {
			options.hazardous = Boolean(form?.elements?.swimmingHazard?.checked);
			options.otherEncumbranceModifier = finiteNumber(
				form?.elements?.swimmingOtherModifier?.value ?? 0,
				"swimmingOtherModifier",
			);
		}
		if (id === "climbing") {
			options.climbType = normalizeClimbType(form?.elements?.climbType?.value);
			options.dangerous = Boolean(form?.elements?.climbDanger?.checked);
			options.sheerAccessConfirmed = Boolean(
				form?.elements?.climbSheerAccess?.checked,
			);
		}

		return {
			confirmed: true,
			kind: "procedure",
			procedureId: id,
			options,
		};
	};

	StandardTestDialog._refreshContextFields = function (body, entry, actor) {
		originalRefreshContextFields.call(this, body, entry, actor);
		const tags = new Set(entry?.tags ?? []);
		setFieldVisible(body, "movementPace", tags.has("requires-movement-pace"));
		setFieldVisible(body, "swimmingHazard", tags.has("requires-swimming-hazard"));
		setFieldVisible(
			body,
			"swimmingOtherModifier",
			tags.has("requires-swimming-encumbrance-modifier"),
		);
		setFieldVisible(body, "climbType", tags.has("requires-climb-type"));
		setFieldVisible(body, "climbDanger", tags.has("requires-climb-danger"));

		const climbType = body?.querySelector?.('select[name="climbType"]')?.value;
		setFieldVisible(
			body,
			"climbSheerAccess",
			tags.has("requires-climb-sheer-access") && climbType === CLIMB_TYPE.SHEER,
		);
	};

	StandardTestDialog._activateDialog = function (dialog, actor, entries) {
		originalActivateDialog.call(this, dialog, actor, entries);
		const root = dialog?.element;
		const body = root?.querySelector?.(".standard-test-dialog-body");
		const testSelect = root?.querySelector?.('select[name="testId"]');
		const climbTypeSelect = root?.querySelector?.('select[name="climbType"]');
		if (!(body instanceof HTMLElement) || !(testSelect instanceof HTMLSelectElement)) {
			return;
		}

		if (climbTypeSelect instanceof HTMLSelectElement) {
			climbTypeSelect.addEventListener("change", () => {
				const entry = entries.find((candidate) => candidate.id === testSelect.value);
				this._refreshContextFields(body, entry, actor);
			});
		}
	};
}

function installExecutorExtension() {
	if (MovementStandardTest.__wfrpEnvironmentMovementInstalled === true) return;
	Object.defineProperty(MovementStandardTest, "__wfrpEnvironmentMovementInstalled", {
		value: true,
		configurable: false,
	});

	const originalExecute = MovementStandardTest.execute;
	const originalPresentation = MovementStandardTest._presentation;

	MovementStandardTest.execute = async function (actor, procedureId, options = {}) {
		const id = String(procedureId ?? "").trim();
		switch (id) {
			case "obstacle":
				return executeObstacle(this, actor, options);
			case "difficultGround":
				return executeDifficultGround(this, actor, options);
			case "swimming":
				return executeSwimming(this, actor, options);
			case "climbing":
				return executeClimbing(this, actor, options);
			default:
				return originalExecute.call(this, actor, procedureId, options);
		}
	};

	MovementStandardTest._presentation = function (state) {
		if (ENVIRONMENT_PROCEDURES.has(String(state?.kind ?? ""))) {
			return environmentPresentation(state);
		}
		return originalPresentation.call(this, state);
	};
}

async function executeObstacle(executor, actor, options) {
	assertActor(actor, "Obstacle");
	const movementState = MovementRates.forActor(actor);
	const pace = normalizePace(options?.movementPace);
	const fullAllowance = paceDistance(movementState, pace);
	const obstacleCost = fullAllowance / 2;
	const remainingDistance = fullAllowance - obstacleCost;
	const riskModifier = paceRiskModifier(pace);

	const state = baseMovementState(actor, movementState, "obstacle", {
		pace,
		fullAllowance,
		obstacleCost,
		remainingDistance,
		riskRequired: riskModifier !== null,
		riskModifier,
	});

	const message = await publishState(executor, actor, state);
	await rollLinkedRisk(executor, actor, message, state);
	return message;
}

async function executeDifficultGround(executor, actor, options) {
	assertActor(actor, "Difficult Ground");
	const movementState = MovementRates.forActor(actor);
	const pace = normalizePace(options?.movementPace);
	const normalAllowance = paceDistance(movementState, pace);
	const distance = normalAllowance / 2;
	const riskModifier = paceRiskModifier(pace);

	const state = baseMovementState(actor, movementState, "difficultGround", {
		pace,
		normalAllowance,
		distance,
		riskRequired: riskModifier !== null,
		riskModifier,
	});

	const message = await publishState(executor, actor, state);
	await rollLinkedRisk(executor, actor, message, state);
	return message;
}

async function executeSwimming(executor, actor, options) {
	assertActor(actor, "Swimming");
	if (!hasOwnedSkill(actor, "swim")) {
		throw new Error(localize(
			"Only characters with the Swim skill can swim under the Core rules.",
			"Zgodnie z Księgą Główną pływać mogą tylko bohaterowie posiadający umiejętność Pływanie.",
		));
	}

	const movementState = MovementRates.forActor(actor);
	const cautiousDistance = movementState.rates[MOVEMENT_RATE.CAUTIOUS].round;
	const distance = cautiousDistance * (2 / 3);
	const hazardous = options?.hazardous === true;
	const armourPoints = wornArmourPoints(actor);
	const otherModifier = finiteNumber(
		options?.otherEncumbranceModifier ?? 0,
		"otherEncumbranceModifier",
	);
	const riskModifier = hazardous
		? 20 - (armourPoints * 10) + otherModifier
		: null;
	const toughness = nonNegativeInteger(
		actor.getCharacteristicValue?.("t") ??
			actor.system?.characteristics?.t?.current ?? 0,
	);

	const state = baseMovementState(actor, movementState, "swimming", {
		cautiousDistance,
		distance,
		hazardous,
		armourPoints,
		otherModifier,
		riskRequired: hazardous,
		riskModifier,
		toughness,
	});

	const message = await publishState(executor, actor, state);
	await rollLinkedRisk(executor, actor, message, state);
	return message;
}

async function executeClimbing(executor, actor, options) {
	assertActor(actor, "Climbing");
	const movementState = MovementRates.forActor(actor);
	const climbType = normalizeClimbType(options?.climbType);
	const dangerous = options?.dangerous === true;
	const sheerAccessConfirmed = options?.sheerAccessConfirmed === true;

	if (climbType === CLIMB_TYPE.SHEER && !sheerAccessConfirmed) {
		throw new Error(localize(
			"A sheer surface requires suitable ropes/grapples or the Core ability that permits sheer climbing.",
			"Stroma/pionowa powierzchnia wymaga odpowiednich lin/haków albo zdolności z Księgi Głównej pozwalającej na taką wspinaczkę.",
		));
	}

	/*
	 * The Core describes non-sheer climbing and ropes/non-fixed ladders as half
	 * move / half normal movement rate. The Standard rate is the system's normal
	 * open-ground movement rate, so this procedure derives one half of it.
	 */
	const normalDistance = movementState.rates[MOVEMENT_RATE.STANDARD].round;
	const distance = normalDistance / 2;

	const state = baseMovementState(actor, movementState, "climbing", {
		climbType,
		dangerous,
		sheerAccessConfirmed,
		normalDistance,
		distance,
		riskRequired: dangerous,
		riskModifier: dangerous ? 0 : null,
	});

	const message = await publishState(executor, actor, state);
	await rollLinkedRisk(executor, actor, message, state);
	return message;
}

async function publishState(executor, actor, state) {
	return executor._publish(
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
}

async function rollLinkedRisk(executor, actor, message, state) {
	if (state.riskRequired !== true) return null;

	const result = await actor.rollTest("risk", {
		modifier: finiteNumber(state.riskModifier ?? 0, "riskModifier"),
	});
	state.riskMessageId = String(result?.chatMessage?.id ?? "");
	state.updatedAt = Date.now();
	await executor._updateMessageState(message, state);
	return result;
}

function baseMovementState(actor, movementState, kind, values) {
	return {
		version: MOVEMENT_STATE_VERSION,
		kind,
		actorUuid: actor.uuid,
		procedureId: kind,
		movement: movementState.movement,
		baseMovement: movementState.baseMovement,
		movementPenalty: movementState.movementPenalty,
		load: movementState.load,
		capacity: movementState.capacity,
		riskMessageId: "",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...values,
	};
}

function environmentPresentation(state) {
	switch (state.kind) {
		case "obstacle": return obstaclePresentation(state);
		case "difficultGround": return difficultGroundPresentation(state);
		case "swimming": return swimmingPresentation(state);
		case "climbing": return climbingPresentation(state);
		default:
			throw new Error(`Unsupported environment movement state '${String(state.kind)}'.`);
	}
}

function obstaclePresentation(state) {
	return commonPresentation(state, {
		procedure: STANDARD_TEST_PROCEDURES.obstacle,
		status: paceLabel(state.pace),
		fullRound: localize("Crossing an obstacle", "Pokonywanie przeszkody"),
		primaryLabel: localize("Movement remaining this round", "Pozostały ruch w tej rundzie"),
		primaryValue: distanceText(state.remainingDistance),
		rightLabel: localize("Obstacle cost", "Koszt przeszkody"),
		rightValue: distanceText(state.obstacleCost),
		rows: [
			row(localize("Selected pace", "Wybrane tempo"), paceLabel(state.pace)),
			row(localize("Full allowance", "Pełny dystans"), distanceText(state.fullAllowance)),
			row(localize("Obstacle cost", "Koszt przeszkody"), distanceText(state.obstacleCost)),
			riskRow(state),
		],
		note: state.riskRequired
			? localize(
				"A separate Risk Test is rolled for this obstacle. Running applies -10. A failed Risk Test uses the normal Core Risk consequence.",
				"Dla tej przeszkody wykonywany jest osobny Test Ryzyka. Bieg daje modyfikator -10. Porażka korzysta ze zwykłej konsekwencji Testu Ryzyka z Księgi Głównej.",
			)
			: localize(
				"Crossing at Cautious pace needs no Risk Test.",
				"Pokonywanie przeszkody Ostrożnie nie wymaga Testu Ryzyka.",
			),
	});
}

function difficultGroundPresentation(state) {
	return commonPresentation(state, {
		procedure: STANDARD_TEST_PROCEDURES.difficultGround,
		status: paceLabel(state.pace),
		fullRound: localize("Moving through difficult ground", "Ruch w trudnym terenie"),
		primaryLabel: localize("Maximum distance this round", "Maksymalny dystans w tej rundzie"),
		primaryValue: distanceText(state.distance),
		rightLabel: localize("Half pace", "Połowa tempa"),
		rightValue: distanceText(state.distance),
		rows: [
			row(localize("Selected pace", "Wybrane tempo"), paceLabel(state.pace)),
			row(localize("Normal allowance", "Normalny dystans"), distanceText(state.normalAllowance)),
			row(localize("Difficult-ground rate", "Tempo w trudnym terenie"), distanceText(state.distance)),
			riskRow(state),
		],
		note: state.riskRequired
			? localize(
				"Moving faster than Cautious requires a Risk Test each round. The Core says this is handled in the same way as obstacles; Running therefore applies -10.",
				"Ruch szybszy niż Ostrożny wymaga Testu Ryzyka w każdej rundzie. Księga Główna każe rozstrzygać go tak samo jak przeszkody, dlatego Bieg otrzymuje -10.",
			)
			: localize(
				"Difficult ground is crossed at half pace; Cautious movement needs no Risk Test.",
				"Trudny teren pokonuje się z połową tempa; ruch Ostrożny nie wymaga Testu Ryzyka.",
			),
	});
}

function swimmingPresentation(state) {
	const riskDescription = state.hazardous
		? signed(state.riskModifier)
		: localize("not required", "niewymagany");
	return commonPresentation(state, {
		procedure: STANDARD_TEST_PROCEDURES.swimming,
		status: state.hazardous
			? localize("Hazardous", "Niebezpieczne")
			: localize("Normal", "Zwykłe"),
		fullRound: localize("Swimming", "Pływanie"),
		primaryLabel: localize("Swimming distance this round", "Dystans pływania w tej rundzie"),
		primaryValue: distanceText(state.distance),
		rightLabel: localize("Swimming rate", "Tempo pływania"),
		rightValue: "⅔ " + localize("Cautious", "Ostrożnego"),
		rows: [
			row(localize("Cautious rate", "Tempo Ostrożne"), distanceText(state.cautiousDistance)),
			row(localize("Swimming rate", "Tempo pływania"), distanceText(state.distance)),
			row(localize("Worn Armour Points", "Noszone Punkty Zbroi"), String(state.armourPoints)),
			row(localize("Hazard Risk modifier", "Modyfikator Ryzyka"), riskDescription),
		],
		note: state.hazardous
			? localize(
				`Hazardous Swimming rolls Risk at +20, -10 per worn Armour Point, plus the GM modifier. If it fails, after ${state.toughness} round(s) (Toughness) the character begins drowning and then loses 1 Wound per round.`,
				`Niebezpieczne Pływanie wykonuje Test Ryzyka z +20, -10 za każdy noszony Punkt Zbroi oraz modyfikatorem MG. Po porażce, po ${state.toughness} rundach (Wytrzymałość), bohater zaczyna tonąć i następnie traci 1 Punkt Żywotności na rundę.`,
			)
			: localize(
				"Normal Swimming requires no test under the Core rules.",
				"Zwykłe Pływanie nie wymaga testu zgodnie z Księgą Główną.",
			),
		secondaryNote: state.hazardous && state.otherModifier !== 0
			? localize(
				`GM other-encumbrance modifier: ${signed(state.otherModifier)}.`,
				`Modyfikator MG za inne obciążenie: ${signed(state.otherModifier)}.`,
			)
			: "",
	});
}

function climbingPresentation(state) {
	const notes = [climbHandsNote(state.climbType)];
	if (state.climbType === CLIMB_TYPE.SHEER) {
		notes.push(localize(
			"Suitable equipment / ability was confirmed for this sheer surface.",
			"Potwierdzono odpowiedni sprzęt / umiejętność dla tej stromej powierzchni.",
		));
	}
	if (state.dangerous) {
		notes.push(localize(
			"A separate Risk Test is rolled. Failure means the character falls; resolve the actual fall height separately.",
			"Wykonywany jest osobny Test Ryzyka. Porażka oznacza upadek; rzeczywistą wysokość upadku należy rozstrzygnąć osobno.",
		));
	}

	return commonPresentation(state, {
		procedure: STANDARD_TEST_PROCEDURES.climbing,
		status: climbTypeLabel(state.climbType),
		fullRound: localize("Climbing", "Wspinaczka"),
		primaryLabel: localize("Climbing distance this round", "Dystans wspinaczki w tej rundzie"),
		primaryValue: distanceText(state.distance),
		rightLabel: localize("Climbing rate", "Tempo wspinaczki"),
		rightValue: localize("½ normal", "½ normalnego"),
		rows: [
			row(localize("Climbing type", "Rodzaj wspinaczki"), climbTypeLabel(state.climbType)),
			row(localize("Normal movement", "Normalny ruch"), distanceText(state.normalDistance)),
			row(localize("Climbing movement", "Ruch wspinaczkowy"), distanceText(state.distance)),
			riskRow(state),
		],
		note: notes.filter(Boolean).join(" "),
		secondaryNote: Number(state.movementPenalty ?? 0) > 0
			? localize(
				`Encumbrance reduced Movement from ${state.baseMovement} to ${state.movement}.`,
				`Obciążenie zmniejszyło Szybkość z ${state.baseMovement} do ${state.movement}.`,
			)
			: "",
	});
}

function commonPresentation(state, data) {
	return {
		kind: state.kind,
		neutral: true,
		success: true,
		procedureName: standardTestProcedureName(data.procedure),
		statusLabel: data.status,
		fullRoundLabel: data.fullRound,
		detailsHint: localize(
			"Click to show the movement calculation",
			"Kliknij, aby pokazać obliczenie ruchu",
		),
		primaryLabel: data.primaryLabel,
		primaryValue: data.primaryValue,
		metricLeftLabel: localize("Effective M", "Efektywna Sz"),
		metricLeftValue: state.movement,
		metricRightLabel: data.rightLabel,
		metricRightValue: data.rightValue,
		rows: data.rows,
		note: data.note,
		secondaryNote: data.secondaryNote ?? encumbranceNote(state),
		showHeldItemsAction: false,
		heldItemsActionLabel: "",
		heldItemsPhaseLabel: "",
	};
}

function riskRow(state) {
	return row(
		localize("Risk Test", "Test Ryzyka"),
		state.riskRequired
			? signed(state.riskModifier ?? 0)
			: localize("not required", "niewymagany"),
	);
}

function encumbranceNote(state) {
	return Number(state.movementPenalty ?? 0) > 0
		? localize(
			`Encumbrance reduced Movement from ${state.baseMovement} to ${state.movement}.`,
			`Obciążenie zmniejszyło Szybkość z ${state.baseMovement} do ${state.movement}.`,
		)
		: "";
}

function climbHandsNote(type) {
	switch (type) {
		case CLIMB_TYPE.ROPE:
			return localize(
				"Ropes and non-fixed ladders require two free hands and are climbed/descended at half normal movement rate.",
				"Liny i drabiny niestałe wymagają dwóch wolnych rąk i pokonuje się je z połową normalnego tempa ruchu.",
			);
		case CLIMB_TYPE.FIXED_LADDER:
			return localize(
				"Fixed ladders use the same half-normal rate but require only one free hand.",
				"Drabiny stałe pokonuje się z tym samym tempem równym połowie normalnego, ale wymagają tylko jednej wolnej ręki.",
			);
		default:
			return localize(
				"Climbing takes the full round; the character may do nothing else during that round.",
				"Wspinaczka zajmuje całą rundę; bohater nie może w tym czasie robić niczego innego.",
			);
	}
}

function paceDistance(movementState, pace) {
	switch (pace) {
		case PACE.CAUTIOUS:
			return movementState.rates[MOVEMENT_RATE.CAUTIOUS].round;
		case PACE.STANDARD:
			return movementState.rates[MOVEMENT_RATE.STANDARD].round;
		case PACE.RUNNING:
			return movementState.rates[MOVEMENT_RATE.RUNNING].round;
		default:
			throw new Error(`Unsupported movement pace '${String(pace)}'.`);
	}
}

function paceRiskModifier(pace) {
	if (pace === PACE.CAUTIOUS) return null;
	if (pace === PACE.STANDARD) return 0;
	if (pace === PACE.RUNNING) return -10;
	throw new Error(`Unsupported movement pace '${String(pace)}'.`);
}

function paceLabel(pace) {
	switch (pace) {
		case PACE.CAUTIOUS: return localize("Cautious", "Ostrożnie");
		case PACE.STANDARD: return localize("Standard", "Normalnie");
		case PACE.RUNNING: return localize("Running", "Biegiem");
		default: return String(pace ?? "");
	}
}

function climbTypeLabel(type) {
	switch (type) {
		case CLIMB_TYPE.ORDINARY:
			return localize("Non-sheer surface", "Powierzchnia niezbyt stroma");
		case CLIMB_TYPE.SHEER:
			return localize("Sheer surface", "Powierzchnia stroma / pionowa");
		case CLIMB_TYPE.ROPE:
			return localize("Rope / non-fixed ladder", "Lina / drabina niestała");
		case CLIMB_TYPE.FIXED_LADDER:
			return localize("Fixed ladder", "Drabina stała");
		default:
			return String(type ?? "");
	}
}

function normalizePace(value) {
	const normalized = String(value ?? "").trim();
	if (Object.values(PACE).includes(normalized)) return normalized;
	return PACE.CAUTIOUS;
}

function normalizeClimbType(value) {
	const normalized = String(value ?? "").trim();
	if (Object.values(CLIMB_TYPE).includes(normalized)) return normalized;
	return CLIMB_TYPE.ORDINARY;
}

function hasOwnedSkill(actor, rulesId) {
	return [...(actor?.items ?? [])].some((item) =>
		item?.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === rulesId,
	);
}

function wornArmourPoints(actor) {
	return [...(actor?.items ?? [])]
		.filter((item) =>
			item?.type === "armour" &&
			String(item.system?.state?.mode ?? "") === INVENTORY_MODE.WORN,
		)
		.reduce(
			(total, item) => total + nonNegativeInteger(item.system?.armourPoints ?? 0),
			0,
		);
}

function appendOptions(select, entries) {
	for (const [value, label] of entries) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		select.append(option);
	}
}

function setFieldVisible(body, field, visible) {
	const element = body?.querySelector?.(`[data-standard-field="${field}"]`);
	if (element) element.hidden = !visible;
}

function row(label, value) {
	return { label, value };
}

function distanceText(value) {
	const unit = game.i18n.lang === "pl" ? "m" : "yd";
	return `${formatNumber(value)} ${unit}`;
}

function formatNumber(value) {
	const number = finiteNumber(value, "display value");
	return new Intl.NumberFormat(game.i18n.lang, {
		maximumFractionDigits: 2,
	}).format(number);
}

function signed(value) {
	const number = finiteNumber(value, "signed value");
	return number > 0 ? `+${number}` : String(number);
}

function assertActor(actor, label) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(`${label} requires an Actor.`);
	}
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be a finite number: ${String(value)}.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

const ENVIRONMENT_PROCEDURES = new Set([
	"obstacle",
	"difficultGround",
	"swimming",
	"climbing",
]);
