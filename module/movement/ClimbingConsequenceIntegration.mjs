import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	INVENTORY_HAND,
	INVENTORY_MODE,
} from "../data-models/item/InventoryItemFields.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { MOVEMENT_RATE, MovementRates } from "./MovementRates.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { StandardTestDialog } from "../tests/StandardTestDialog.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "../tests/standard-test-procedures.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const TEST_STATE_FLAG_KEY = "testResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CLIMB_STATE_VERSION = 8;
const RISK_TEST_ID = "risk";
const MAX_ABSEIL_DISTANCE = 20;

const CLIMB_TYPE = Object.freeze({
	ORDINARY: "ordinary",
	SHEER: "sheer",
	ROPE: "rope",
	FIXED_LADDER: "fixedLadder",
	ABSEIL: "abseil",
});

const ACTION = Object.freeze({
	ROLL_ADDITIONAL_RISK: "roll-additional-risk",
	RESOLVE_FALL: "resolve-fall",
	UNDO_FALL: "undo-fall",
});

/*
 * WFRP 1e Core, printed p.75 — Climbing / Ropes and Ladders:
 * - climbing is a full-round activity;
 * - non-sheer climbing, ropes, and ladders use half normal movement;
 * - climbing always involves danger and requires a Risk Test;
 * - failed climbing Risk means the character falls;
 * - ropes/non-fixed ladders need two free hands; fixed ladders need one;
 * - abseiling uses 20 yards/metres per round and requires an additional Risk
 *   Test for every full 10 yards/metres descended.
 *
 * Fall distance is never inferred from the climbing rate or abseiling segment.
 * The scene/GM owns that fact. Accepting a failed climb therefore opens a small
 * Fall-height prompt and delegates the actual damage to the audited Fall
 * procedure. Once that continuation is accepted, its linked Risk cards become
 * read-only until the Fall is safely undone.
 */
installDialogExtension();
installMovementExtension();
installChatLifecycle();

function installDialogExtension() {
	if (StandardTestDialog.__wfrpClimbingConsequenceInstalled === true) return;
	Object.defineProperty(StandardTestDialog, "__wfrpClimbingConsequenceInstalled", {
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

		const climbType = body.querySelector('select[name="climbType"]');
		if (climbType instanceof HTMLSelectElement && !climbType.querySelector('option[value="abseil"]')) {
			const option = document.createElement("option");
			option.value = CLIMB_TYPE.ABSEIL;
			option.textContent = localize("Abseiling", "Zjazd po linie");
			climbType.append(option);
		}

		const group = this._numberGroup(
			"abseilDistance",
			localize("Abseiling distance this round", "Dystans zjazdu w tej rundzie"),
		);
		group.root.dataset.standardField = "abseilDistance";
		group.input.step = "any";
		group.input.min = "0.01";
		group.input.max = String(MAX_ABSEIL_DISTANCE);
		group.input.value = String(MAX_ABSEIL_DISTANCE);
		group.input.title = localize(
			"Core abseiling speed is 20 yards/metres per round. Enter the distance actually descended this round, up to 20.",
			"Księga Główna podaje tempo zjazdu 20 m na rundę. Wprowadź rzeczywisty dystans zjazdu w tej rundzie, maksymalnie 20 m.",
		);

		const firstD100Only = body.querySelector("[data-standard-d100-only]");
		if (firstD100Only) body.insertBefore(group.root, firstD100Only);
		else body.append(group.root);

		const testSelect = body.querySelector('select[name="testId"]');
		const entry = entries.find((candidate) => candidate.id === testSelect?.value);
		this._refreshContextFields(body, entry, actor);
		return content;
	};

	StandardTestDialog._readForm = function (actor, form, entries) {
		const id = String(form?.elements?.testId?.value ?? "").trim();
		if (id !== "climbing") {
			return originalReadForm.call(this, actor, form, entries);
		}

		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry?.procedure) {
			throw new Error(localize(
				"Select a valid WFRP 1e Climbing procedure.",
				"Wybierz prawidłową procedurę Wspinaczki WFRP 1e.",
			));
		}

		const climbType = normalizeClimbType(form?.elements?.climbType?.value);
		const options = {
			climbType,
			sheerAccessConfirmed: Boolean(form?.elements?.climbSheerAccess?.checked),
		};
		if (climbType === CLIMB_TYPE.ABSEIL) {
			const distance = this._requiredPositiveNumber(
				form?.elements?.abseilDistance,
				localize("Abseiling distance", "Dystans zjazdu"),
			);
			if (distance > MAX_ABSEIL_DISTANCE) {
				throw new Error(localize(
					`Abseiling is limited to ${MAX_ABSEIL_DISTANCE} yards per round by the Core rule.`,
					`Zgodnie z Księgą Główną zjazd po linie jest ograniczony do ${MAX_ABSEIL_DISTANCE} m na rundę.`,
				));
			}
			options.abseilDistance = distance;
		}

		return {
			confirmed: true,
			kind: "procedure",
			procedureId: "climbing",
			options,
		};
	};

	StandardTestDialog._refreshContextFields = function (body, entry, actor) {
		originalRefreshContextFields.call(this, body, entry, actor);
		const isClimbing = String(entry?.id ?? "") === "climbing";
		const climbType = body?.querySelector?.('select[name="climbType"]')?.value;

		/* The Core does not offer an optional safe-climb branch. */
		setFieldVisible(body, "climbDanger", false);
		setFieldVisible(
			body,
			"abseilDistance",
			isClimbing && climbType === CLIMB_TYPE.ABSEIL,
		);
		setFieldVisible(
			body,
			"climbSheerAccess",
			isClimbing && climbType === CLIMB_TYPE.SHEER,
		);
	};

	StandardTestDialog._activateDialog = function (dialog, actor, entries) {
		originalActivateDialog.call(this, dialog, actor, entries);
		const root = dialog?.element;
		const body = root?.querySelector?.(".standard-test-dialog-body");
		const testSelect = root?.querySelector?.('select[name="testId"]');
		const climbType = root?.querySelector?.('select[name="climbType"]');
		if (!(body instanceof HTMLElement) || !(testSelect instanceof HTMLSelectElement)) return;
		if (!(climbType instanceof HTMLSelectElement)) return;

		climbType.addEventListener("change", () => {
			const entry = entries.find((candidate) => candidate.id === testSelect.value);
			this._refreshContextFields(body, entry, actor);
		});
	};
}

function installMovementExtension() {
	if (MovementStandardTest.__wfrpClimbingConsequenceInstalled === true) return;
	Object.defineProperty(MovementStandardTest, "__wfrpClimbingConsequenceInstalled", {
		value: true,
		configurable: false,
	});

	const originalExecute = MovementStandardTest.execute;
	const originalPresentation = MovementStandardTest._presentation;

	MovementStandardTest.execute = async function (actor, procedureId, options = {}) {
		if (String(procedureId ?? "").trim() === "climbing") {
			return executeClimbing(this, actor, options);
		}
		return originalExecute.call(this, actor, procedureId, options);
	};

	MovementStandardTest._presentation = function (state) {
		if (state?.kind === "climbing") return climbingPresentation(state);
		return originalPresentation.call(this, state);
	};
}

function installChatLifecycle() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		decorateClimbingActions(message, html);
		applyClimbingRiskReadOnly(message, html);
	});

	Hooks.on("updateChatMessage", (message) => {
		if (riskTestState(message) || climbingState(message) || fallState(message)) {
			requestChatRefresh();
		}
	});

	Hooks.on("updateActor", (actor) => {
		if (!(actor instanceof foundry.documents.Actor)) return;
		if (!actorHasAcceptedClimbingFall(actor)) return;
		requestChatRefresh();
	});

	Hooks.on("preUpdateChatMessage", (message, changes) => {
		if (!climbingLocksRiskMessage(message)) return true;
		const current = riskTestState(message);
		const candidate = changedTestState(changes);
		if (!current || !candidate) return true;
		return mechanicalTestStateChanged(current, candidate) ? false : true;
	});

	/* Luck's K100 context entries exist by the time this module is loaded. Hide
	 * only clover roll-changing actions while the accepted Fall depends on them. */
	Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
		if (!Array.isArray(menuItems)) return;
		for (const entry of menuItems) {
			if (String(entry?.icon ?? "") !== "fa-solid fa-clover") continue;
			const originalVisible = entry.visible;
			entry.visible = (target) => {
				const message = messageFromContextTarget(target);
				if (climbingLocksRiskMessage(message)) return false;
				return typeof originalVisible === "function"
					? originalVisible(target)
					: originalVisible !== false;
			};
		}
	});
}

async function executeClimbing(executor, actor, options) {
	assertActor(actor);
	const movementState = MovementRates.forActor(actor);
	const climbType = normalizeClimbType(options?.climbType);
	const sheerAccessConfirmed = options?.sheerAccessConfirmed === true;

	if (climbType === CLIMB_TYPE.SHEER && !sheerAccessConfirmed) {
		throw new Error(localize(
			"A sheer surface requires suitable ropes/grapples or the Core Scale Sheer Surface ability.",
			"Stroma/pionowa powierzchnia wymaga odpowiednich lin/haków albo umiejętności wspinania się po stromych powierzchniach z Księgi Głównej.",
		));
	}

	const handValidationEnabled = WfrpRuleSettings.validatesClimbingHandAvailability();
	const requiredFreeHands = requiredClimbingFreeHands(climbType);
	const freeHands = countFreeHands(actor);
	if (
		handValidationEnabled &&
		requiredFreeHands > 0 &&
		freeHands < requiredFreeHands
	) {
		throw new Error(localize(
			`This climb requires ${requiredFreeHands} free hand(s), but only ${freeHands} are available.`,
			`Ta wspinaczka wymaga ${requiredFreeHands} wolnych rąk, a dostępnych jest tylko ${freeHands}.`,
		));
	}

	const normalDistance = movementState.rates[MOVEMENT_RATE.STANDARD].round;
	const abseilDistance = climbType === CLIMB_TYPE.ABSEIL
		? positiveNumber(options?.abseilDistance ?? MAX_ABSEIL_DISTANCE, "abseilDistance")
		: null;
	if (abseilDistance !== null && abseilDistance > MAX_ABSEIL_DISTANCE) {
		throw new Error("Abseiling distance exceeds the Core 20-per-round limit.");
	}

	const distance = climbType === CLIMB_TYPE.ABSEIL
		? abseilDistance
		: normalDistance / 2;
	const additionalRiskRequired = climbType === CLIMB_TYPE.ABSEIL
		? Math.floor(abseilDistance / 10)
		: 0;

	const state = {
		version: CLIMB_STATE_VERSION,
		kind: "climbing",
		procedureId: "climbing",
		actorUuid: actor.uuid,
		movement: movementState.movement,
		baseMovement: movementState.baseMovement,
		movementPenalty: movementState.movementPenalty,
		load: movementState.load,
		capacity: movementState.capacity,
		climbType,
		sheerAccessConfirmed,
		handValidationEnabled,
		requiredFreeHands,
		freeHands,
		normalDistance,
		distance,
		abseilDistance,
		riskRequired: true,
		riskModifier: 0,
		riskMessageId: "",
		riskMessageIds: [],
		additionalRiskRequired,
		additionalRiskRolled: 0,
		fallMessageId: "",
		fallHeight: null,
		fallAcceptedAt: null,
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
	await rollClimbingRisk(executor, actor, message, state, false);
	return message;
}

async function rollClimbingRisk(executor, actor, climbingMessage, state, additional) {
	const result = await actor.rollTest(RISK_TEST_ID, { modifier: 0 });
	const riskMessageId = String(result?.chatMessage?.id ?? "").trim();
	if (!riskMessageId) {
		throw new Error(localize(
			"The climbing Risk Test did not create a result message.",
			"Test Ryzyka Wspinaczki nie utworzył wiadomości z wynikiem.",
		));
	}

	state.riskMessageIds = [...new Set([
		...(Array.isArray(state.riskMessageIds) ? state.riskMessageIds : []),
		riskMessageId,
	])];
	if (!state.riskMessageId) state.riskMessageId = riskMessageId;
	if (additional) {
		state.additionalRiskRolled = nonNegativeInteger(state.additionalRiskRolled) + 1;
	}
	state.updatedAt = Date.now();
	await executor._updateMessageState(climbingMessage, state);
	return result;
}

function climbingPresentation(state) {
	const abseil = state.climbType === CLIMB_TYPE.ABSEIL;
	const riskIds = climbingRiskIds(state);
	const notes = [];

	if (state.climbType === CLIMB_TYPE.ROPE) {
		notes.push(localize(
			"Ropes and non-fixed ladders require two free hands and use half normal movement.",
			"Liny i drabiny niestałe wymagają dwóch wolnych rąk i używają połowy normalnego tempa ruchu.",
		));
	} else if (state.climbType === CLIMB_TYPE.FIXED_LADDER) {
		notes.push(localize(
			"Fixed ladders use the same half-normal rate and require one free hand.",
			"Drabiny stałe używają tego samego tempa równego połowie normalnego i wymagają jednej wolnej ręki.",
		));
	} else if (abseil) {
		notes.push(localize(
			`Abseiling allows up to 20 yards per round. This ${distanceText(state.distance)} descent requires ${state.additionalRiskRequired} additional Risk Test(s), one for every full 10 yards.`,
			`Zjazd po linie pozwala pokonać do 20 m na rundę. Ten zjazd na ${distanceText(state.distance)} wymaga ${state.additionalRiskRequired} dodatkowych Testów Ryzyka — po jednym za każde pełne 10 m.`,
		));
	} else {
		notes.push(localize(
			"Climbing takes the full round; the character may do nothing else during that round.",
			"Wspinaczka zajmuje całą rundę; bohater nie może w tym czasie robić niczego innego.",
		));
	}

	notes.push(localize(
		"Every climb requires a Risk Test. A failed climbing Risk means the character falls; the actual fall height comes from the scene and is never inferred by the system.",
		"Każda wspinaczka wymaga Testu Ryzyka. Nieudany Test Ryzyka oznacza upadek; rzeczywista wysokość upadku wynika z sytuacji i system nigdy jej nie zgaduje.",
	));

	if (state.handValidationEnabled && state.requiredFreeHands > 0) {
		notes.push(localize(
			`Optional hand validation: ${state.freeHands} free of ${state.requiredFreeHands} required.`,
			`Opcjonalna kontrola rąk: ${state.freeHands} wolnych, wymagane ${state.requiredFreeHands}.`,
		));
	}

	return {
		kind: "climbing",
		neutral: true,
		success: true,
		procedureName: standardTestProcedureName(STANDARD_TEST_PROCEDURES.climbing),
		statusLabel: climbTypeLabel(state.climbType),
		fullRoundLabel: localize("Climbing", "Wspinaczka"),
		detailsHint: localize(
			"Click to show the climbing calculation",
			"Kliknij, aby pokazać obliczenie wspinaczki",
		),
		primaryLabel: abseil
			? localize("Distance descended this round", "Dystans zjazdu w tej rundzie")
			: localize("Climbing distance this round", "Dystans wspinaczki w tej rundzie"),
		primaryValue: distanceText(state.distance),
		metricLeftLabel: localize("Effective M", "Efektywna Sz"),
		metricLeftValue: state.movement,
		metricRightLabel: abseil
			? localize("Abseiling rate", "Tempo zjazdu")
			: localize("Climbing rate", "Tempo wspinaczki"),
		metricRightValue: abseil
			? localize("20 / round", "20 / rundę")
			: localize("½ normal", "½ normalnego"),
		rows: [
			row(localize("Climbing type", "Rodzaj wspinaczki"), climbTypeLabel(state.climbType)),
			...(abseil ? [] : [
				row(localize("Normal movement", "Normalny ruch"), distanceText(state.normalDistance)),
			]),
			row(
				abseil ? localize("Abseiling movement", "Ruch zjazdu") : localize("Climbing movement", "Ruch wspinaczkowy"),
				distanceText(state.distance),
			),
			row(localize("Base climbing Risk", "Podstawowy Test Ryzyka wspinaczki"), riskIds.length > 0 ? localize("rolled", "wykonany") : localize("pending", "oczekuje")),
			...(abseil ? [
				row(localize("Additional Risk Tests required", "Wymagane dodatkowe Testy Ryzyka"), state.additionalRiskRequired),
				row(localize("Additional Risk Tests rolled", "Wykonane dodatkowe Testy Ryzyka"), state.additionalRiskRolled),
			] : []),
		],
		note: notes.join(" "),
		secondaryNote: Number(state.movementPenalty ?? 0) > 0
			? localize(
				`Encumbrance reduced Movement from ${state.baseMovement} to ${state.movement}.`,
				`Obciążenie zmniejszyło Szybkość z ${state.baseMovement} do ${state.movement}.`,
			)
			: "",
		showHeldItemsAction: false,
		heldItemsActionLabel: "",
		heldItemsPhaseLabel: "",
	};
}

function decorateClimbingActions(message, html) {
	const state = climbingState(message);
	if (!state) return;
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-climbing-lifecycle]")?.remove();
	const actor = actorFromUuidSync(state.actorUuid);
	const canManage = canManageClimbing(message, actor);
	const summary = climbingRiskSummary(state);
	const activeFall = activeFallMessage(state);

	const block = document.createElement("section");
	block.className = "wfrp1e-climbing-lifecycle";
	block.dataset.wfrpClimbingLifecycle = "";

	const text = document.createElement("span");
	text.className = "wfrp1e-climbing-lifecycle__text";

	let action = null;
	let label = "";
	let icon = "";

	if (activeFall) {
		block.classList.add("is-fall-resolved");
		text.textContent = localize(
			`Fall accepted and resolved at ${state.fallHeight} ${distanceUnit()}. Linked climbing Risk result(s) are read-only until this Fall is undone.`,
			`Upadek zaakceptowano i rozstrzygnięto z wysokości ${state.fallHeight} ${distanceUnit()}. Powiązane Testy Ryzyka wspinaczki są tylko do odczytu, dopóki Upadek nie zostanie cofnięty.`,
		);
		action = ACTION.UNDO_FALL;
		label = localize("Undo Fall resolution", "Cofnij rozstrzygnięcie Upadku");
		icon = "fa-solid fa-rotate-left";
	} else if (summary.failed.length > 0) {
		block.classList.add("is-fall-pending");
		text.textContent = localize(
			"A required climbing Risk Test failed. The Core says the character falls. Enter the actual scene height to resolve that Fall.",
			"Wymagany Test Ryzyka wspinaczki nie udał się. Księga Główna mówi, że bohater spada. Podaj rzeczywistą wysokość wynikającą ze sceny, aby rozstrzygnąć Upadek.",
		);
		action = ACTION.RESOLVE_FALL;
		label = localize("Resolve Fall", "Rozstrzygnij Upadek");
		icon = "fa-solid fa-person-falling";
	} else if (
		state.climbType === CLIMB_TYPE.ABSEIL &&
		nonNegativeInteger(state.additionalRiskRolled) < nonNegativeInteger(state.additionalRiskRequired)
	) {
		const next = nonNegativeInteger(state.additionalRiskRolled) + 1;
		const total = nonNegativeInteger(state.additionalRiskRequired);
		text.textContent = localize(
			`Base climbing Risk succeeded. Roll additional abseiling Risk Test ${next} of ${total} before continuing the descent.`,
			`Podstawowy Test Ryzyka wspinaczki jest udany. Wykonaj dodatkowy Test Ryzyka zjazdu ${next} z ${total}, zanim będziesz kontynuować zjazd.`,
		);
		action = ACTION.ROLL_ADDITIONAL_RISK;
		label = localize(
			`Roll additional Risk ${next}/${total}`,
			`Rzuć dodatkowy Test Ryzyka ${next}/${total}`,
		);
		icon = "fa-solid fa-dice-d100";
	} else {
		block.classList.add("is-complete");
		text.textContent = localize(
			"All required climbing Risk Tests currently succeed.",
			"Wszystkie wymagane Testy Ryzyka wspinaczki są obecnie udane.",
		);
	}

	block.append(text);
	if (action && canManage) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.wfrpClimbingAction = action;
		const iconElement = document.createElement("i");
		iconElement.className = icon;
		button.append(iconElement, document.createTextNode(` ${label}`));
		button.addEventListener("click", (event) => {
			event.preventDefault();
			button.disabled = true;
			void handleClimbingAction(message, action)
				.catch((error) => {
					console.error("WFRP1ED | Climbing lifecycle action failed.", error);
					ui.notifications.error(error?.message ?? localize(
						"Unable to update the climbing lifecycle.",
						"Nie udało się zaktualizować sekwencji wspinaczki.",
					));
				})
				.finally(() => { button.disabled = false; });
		});
		block.append(button);
	}

	const metrics = card.querySelector(".wfrp1e-test-card__metrics");
	if (metrics) metrics.before(block);
	else card.append(block);
}

async function handleClimbingAction(message, action) {
	const state = climbingState(message);
	if (!state) throw new Error("Climbing state is unavailable.");
	const actor = await actorForState(state);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(localize("Climbing Actor is unavailable.", "Aktor Wspinaczki jest niedostępny."));
	}
	if (!canManageClimbing(message, actor)) {
		throw new Error(localize("You cannot manage this climbing result.", "Nie możesz zarządzać tym wynikiem Wspinaczki."));
	}

	switch (action) {
		case ACTION.ROLL_ADDITIONAL_RISK:
			return rollNextAdditionalRisk(message, state, actor);
		case ACTION.RESOLVE_FALL:
			return resolveClimbingFall(message, state, actor);
		case ACTION.UNDO_FALL:
			return undoClimbingFall(message, state, actor);
		default:
			throw new Error(`Unsupported climbing action '${String(action)}'.`);
	}
}

async function rollNextAdditionalRisk(message, state, actor) {
	if (state.climbType !== CLIMB_TYPE.ABSEIL) return message;
	if (climbingRiskSummary(state).failed.length > 0) {
		throw new Error(localize(
			"A previous climbing Risk Test is failed; resolve or adjudicate that fall before rolling another abseiling segment.",
			"Poprzedni Test Ryzyka wspinaczki jest nieudany; rozstrzygnij lub zmień ten upadek przed kolejnym odcinkiem zjazdu.",
		));
	}
	if (activeFallMessage(state)) {
		throw new Error(localize("The Fall is already resolved.", "Upadek jest już rozstrzygnięty."));
	}
	if (state.additionalRiskRolled >= state.additionalRiskRequired) return message;

	const updated = foundry.utils.deepClone(state);
	await rollClimbingRisk(MovementStandardTest, actor, message, updated, true);
	return message;
}

async function resolveClimbingFall(message, state, actor) {
	if (activeFallMessage(state)) return message;
	if (climbingRiskSummary(state).failed.length === 0) {
		throw new Error(localize(
			"A Fall continuation is available only while a linked climbing Risk Test is failed.",
			"Rozstrzygnięcie Upadku jest dostępne tylko wtedy, gdy powiązany Test Ryzyka wspinaczki jest nieudany.",
		));
	}

	const height = await promptFallHeight();
	if (height === null) return message;
	const fallMessage = await MovementStandardTest.execute(actor, "fall", {
		fallHeight: height,
		sourceClimbingMessageId: message.id,
	});
	if (!(fallMessage instanceof foundry.documents.ChatMessage)) {
		throw new Error("Fall procedure did not create a ChatMessage.");
	}

	const updated = foundry.utils.deepClone(state);
	updated.fallMessageId = String(fallMessage.id ?? "");
	updated.fallHeight = height;
	updated.fallAcceptedAt = Date.now();
	updated.updatedAt = Date.now();
	await MovementStandardTest._updateMessageState(message, updated);
	requestChatRefresh();
	return fallMessage;
}

async function undoClimbingFall(message, state, actor) {
	const fallMessage = activeFallMessage(state);
	if (!fallMessage) {
		const updated = foundry.utils.deepClone(state);
		updated.fallMessageId = "";
		updated.fallHeight = null;
		updated.fallAcceptedAt = null;
		updated.updatedAt = Date.now();
		await MovementStandardTest._updateMessageState(message, updated);
		requestChatRefresh();
		return message;
	}

	const damageState = fallMessage.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const packetId = String(damageState?.packet?.id ?? "").trim();
	if (packetId) {
		const transaction = DamageApplication.transactionFor(actor, packetId);
		if (transaction?.state === "applied") {
			throw new Error(localize(
				"Fall damage is already applied. First use “Invalidate Damage” on the Fall message, then undo the Fall resolution.",
				"Obrażenia od Upadku są już zastosowane. Najpierw użyj „Unieważnij obrażenia” na wiadomości Upadku, a następnie cofnij rozstrzygnięcie Upadku.",
			));
		}
		await fallMessage.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	}

	const fall = foundry.utils.deepClone(fallState(fallMessage));
	if (fall) {
		fall.cancelled = true;
		fall.cancelledAt = Date.now();
		fall.updatedAt = Date.now();
		await MovementStandardTest._updateMessageState(fallMessage, fall);
	}

	const updated = foundry.utils.deepClone(state);
	updated.fallMessageId = "";
	updated.fallHeight = null;
	updated.fallAcceptedAt = null;
	updated.updatedAt = Date.now();
	await MovementStandardTest._updateMessageState(message, updated);
	requestChatRefresh();
	return message;
}

async function promptFallHeight() {
	const content = document.createElement("div");
	content.className = "wfrp1ed-climbing-fall-dialog";
	const group = document.createElement("div");
	group.className = "form-group";
	const label = document.createElement("label");
	label.textContent = localize("Actual fall height", "Rzeczywista wysokość upadku");
	const fields = document.createElement("div");
	fields.className = "form-fields";
	const input = document.createElement("input");
	input.type = "number";
	input.name = "fallHeight";
	input.min = "0.01";
	input.step = "any";
	input.autocomplete = "off";
	input.placeholder = "—";
	input.autofocus = true;
	fields.append(input);
	group.append(label, fields);
	const note = document.createElement("p");
	note.textContent = localize(
		"Enter the real distance from the character's current position to the landing point. The system will apply the Core x2 Fall rule itself.",
		"Podaj rzeczywistą odległość od aktualnej pozycji bohatera do miejsca lądowania. System sam zastosuje zasadę ×2 dla Upadku z Księgi Głównej.",
	);
	content.append(group, note);

	const response = await foundry.applications.api.DialogV2.wait({
		classes: ["wfrp1ed", "wfrp1ed-parchment-window"],
		window: { title: localize("Resolve Fall", "Rozstrzygnij Upadek") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [
			{
				action: "resolve",
				label: localize("Resolve", "Rozstrzygnij"),
				icon: "fa-solid fa-person-falling",
				default: true,
				callback: (_event, button) => {
					const raw = String(button.form?.elements?.fallHeight?.value ?? "").trim();
					const value = Number(raw);
					if (!raw || !Number.isFinite(value) || value <= 0) {
						throw new Error(localize(
							"Enter a fall height greater than zero.",
							"Wprowadź wysokość upadku większą od zera.",
						));
					}
					return value;
				},
			},
			{
				action: "cancel",
				label: localize("Cancel", "Anuluj"),
				icon: "fa-solid fa-xmark",
				callback: () => null,
			},
		],
	});
	return Number.isFinite(Number(response)) ? Number(response) : null;
}

function applyClimbingRiskReadOnly(message, html) {
	if (!climbingLocksRiskMessage(message)) return;
	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	if (!(card instanceof HTMLElement)) return;

	card.querySelector?.("[data-wfrp-climbing-risk-lock]")?.remove();
	card.classList.add("is-climbing-result-locked");
	const title = localize(
		"This climbing Risk result is read-only because its failed outcome has an accepted Fall continuation. Undo/invalidate the Fall first to edit the Risk result again.",
		"Ten wynik Testu Ryzyka wspinaczki jest tylko do odczytu, ponieważ jego porażka ma zaakceptowane rozstrzygnięcie Upadku. Najpierw cofnij/unieważnij Upadek, aby ponownie edytować wynik Ryzyka.",
	);

	for (const selector of ["[data-wfrp-test-roll-value]", "[data-wfrp-test-general-modifier]"]) {
		const input = card.querySelector(selector);
		if (!(input instanceof HTMLInputElement)) continue;
		input.readOnly = true;
		input.tabIndex = -1;
		input.classList.remove("is-editable");
		input.classList.add("is-readonly");
		input.title = title;
	}
	for (const toggle of card.querySelectorAll("[data-wfrp-test-modifier-toggle]")) {
		if (!(toggle instanceof HTMLInputElement)) continue;
		toggle.disabled = true;
		toggle.title = title;
	}

	const note = document.createElement("section");
	note.className = "wfrp1e-climbing-risk-lock";
	note.dataset.wfrpClimbingRiskLock = "";
	const icon = document.createElement("i");
	icon.className = "fa-solid fa-lock";
	const text = document.createElement("span");
	text.textContent = localize(
		"Result locked by accepted Fall",
		"Wynik zablokowany przez zaakceptowany Upadek",
	);
	note.append(icon, text);
	const metrics = card.querySelector(".wfrp1e-test-card__metrics");
	if (metrics) metrics.before(note);
	else card.append(note);
}

function climbingLocksRiskMessage(riskMessage) {
	if (!riskTestState(riskMessage) || !riskMessage?.id) return false;
	const id = String(riskMessage.id);
	return climbingMessagesLinkedToRisk(id).some((message) =>
		Boolean(activeFallMessage(climbingState(message))),
	);
}

function activeFallMessage(state) {
	const id = String(state?.fallMessageId ?? "").trim();
	if (!id) return null;
	const message = game.messages?.get?.(id);
	const stateForFall = fallState(message);
	return stateForFall && stateForFall.cancelled !== true ? message : null;
}

function climbingRiskSummary(state) {
	const succeeded = [];
	const failed = [];
	const missing = [];
	for (const id of climbingRiskIds(state)) {
		const message = game.messages?.get?.(id);
		const test = riskTestState(message);
		if (!test) {
			missing.push(id);
			continue;
		}
		(testSucceeded(test) ? succeeded : failed).push(message);
	}
	return { succeeded, failed, missing };
}

function climbingRiskIds(state) {
	const ids = Array.isArray(state?.riskMessageIds)
		? state.riskMessageIds.map((id) => String(id ?? "").trim()).filter(Boolean)
		: [];
	const legacy = String(state?.riskMessageId ?? "").trim();
	if (legacy && !ids.includes(legacy)) ids.unshift(legacy);
	return [...new Set(ids)];
}

function climbingMessagesLinkedToRisk(riskMessageId) {
	const id = String(riskMessageId ?? "").trim();
	if (!id) return [];
	return [...(game.messages ?? [])].filter((message) =>
		climbingRiskIds(climbingState(message)).includes(id),
	);
}

function climbingState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state) &&
		String(state.kind ?? "") === "climbing"
		? state
		: null;
}

function fallState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state) &&
		String(state.kind ?? "") === "fall"
		? state
		: null;
}

function riskTestState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state) &&
		String(state.testId ?? "") === RISK_TEST_ID
		? state
		: null;
}

function testSucceeded(state) {
	return TestResultChat._templateContext(state)?.result?.success === true;
}

function changedTestState(changes) {
	const direct = changes?.flags?.[FLAG_SCOPE]?.[TEST_STATE_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
	const flat = changes?.[`flags.${FLAG_SCOPE}.${TEST_STATE_FLAG_KEY}`];
	return flat && typeof flat === "object" && !Array.isArray(flat) ? flat : null;
}

function mechanicalTestStateChanged(current, candidate) {
	return Number(current?.roll) !== Number(candidate?.roll) ||
		Number(current?.generalModifier?.value ?? 0) !== Number(candidate?.generalModifier?.value ?? 0) ||
		JSON.stringify(current?.otherModifiers ?? []) !== JSON.stringify(candidate?.otherModifiers ?? []);
}

function actorHasAcceptedClimbingFall(actor) {
	const uuid = String(actor?.uuid ?? "");
	return Boolean(uuid && [...(game.messages ?? [])].some((message) => {
		const state = climbingState(message);
		return String(state?.actorUuid ?? "") === uuid && Boolean(activeFallMessage(state));
	}));
}

function canManageClimbing(message, actor) {
	if (!game.user || !(actor instanceof foundry.documents.Actor)) return false;
	const owns = game.user.isGM || actor.testUserPermission?.(
		game.user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
	if (!owns) return false;
	return game.user.isGM || message?.canUserModify?.(game.user, "update") === true;
}

async function actorForState(state) {
	try {
		const document = await foundry.utils.fromUuid(String(state?.actorUuid ?? ""));
		return document instanceof foundry.documents.Actor ? document : null;
	} catch (_error) {
		return null;
	}
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return document instanceof foundry.documents.Actor ? document : null;
	} catch (_error) {
		return null;
	}
}

function requiredClimbingFreeHands(type) {
	if (type === CLIMB_TYPE.ROPE || type === CLIMB_TYPE.ABSEIL) return 2;
	if (type === CLIMB_TYPE.FIXED_LADDER) return 1;
	return 0;
}

function countFreeHands(actor) {
	const occupied = new Set();
	for (const item of actor?.items ?? []) {
		if (!["weapon", "armour", "equipment"].includes(item?.type)) continue;
		if (String(item.system?.state?.mode ?? "") !== INVENTORY_MODE.HELD) continue;
		switch (String(item.system?.state?.hand ?? "")) {
			case INVENTORY_HAND.MAIN:
				occupied.add(INVENTORY_HAND.MAIN);
				break;
			case INVENTORY_HAND.OFF:
				occupied.add(INVENTORY_HAND.OFF);
				break;
			case INVENTORY_HAND.BOTH:
				occupied.add(INVENTORY_HAND.MAIN);
				occupied.add(INVENTORY_HAND.OFF);
				break;
			default:
				break;
		}
	}
	return Math.max(0, 2 - occupied.size);
}

function climbTypeLabel(type) {
	switch (type) {
		case CLIMB_TYPE.ORDINARY: return localize("Non-sheer surface", "Powierzchnia niezbyt stroma");
		case CLIMB_TYPE.SHEER: return localize("Sheer surface", "Powierzchnia stroma / pionowa");
		case CLIMB_TYPE.ROPE: return localize("Rope / non-fixed ladder", "Lina / drabina niestała");
		case CLIMB_TYPE.FIXED_LADDER: return localize("Fixed ladder", "Drabina stała");
		case CLIMB_TYPE.ABSEIL: return localize("Abseiling", "Zjazd po linie");
		default: return String(type ?? "");
	}
}

function normalizeClimbType(value) {
	const normalized = String(value ?? "").trim();
	return Object.values(CLIMB_TYPE).includes(normalized)
		? normalized
		: CLIMB_TYPE.ORDINARY;
}

function assertActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Climbing requires an Actor.");
	}
}

function setFieldVisible(body, field, visible) {
	const element = body?.querySelector?.(`[data-standard-field="${field}"]`);
	if (element) element.hidden = !visible;
}

function distanceText(value) {
	const number = Number(value);
	const formatted = Number.isInteger(number)
		? String(number)
		: number.toLocaleString(game.i18n.lang, { maximumFractionDigits: 2 });
	return `${formatted} ${distanceUnit()}`;
}

function distanceUnit() {
	return game.i18n.lang === "pl" ? "m" : "yd";
}

function row(label, value) {
	return { label, value: String(value) };
}

function positiveNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) {
		throw new Error(`${label} must be a finite number greater than zero.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function requestChatRefresh() {
	setTimeout(() => { void ui.chat?.render?.({ force: true }); }, 0);
}

function messageFromContextTarget(target) {
	const element = target instanceof HTMLElement
		? target
		: target?.[0] instanceof HTMLElement
			? target[0]
			: null;
	const entry = element?.closest?.("[data-message-id]") ?? element;
	const messageId = String(
		entry?.dataset?.messageId ??
		target?.attr?.("data-message-id") ??
		target?.data?.("message-id") ??
		"",
	).trim();
	return messageId ? game.messages?.get(messageId) ?? null : null;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
