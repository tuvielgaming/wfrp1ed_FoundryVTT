import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { HeldItemsCheck } from "./HeldItemsCheck.mjs";
import { MovementStandardTest } from "../tests/MovementStandardTest.mjs";
import { StandardTestDialog } from "../tests/StandardTestDialog.mjs";
import {
	STANDARD_TEST_PROCEDURES,
	standardTestProcedureName,
} from "../tests/standard-test-procedures.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const FALL_STATE_VERSION = 1;
const FALL_LUCK_ROLL_ID = "movement.fall.reduction";

const HELD_ITEMS_PHASE = Object.freeze({
	PENDING: "pending",
	ROLLING: "rolling",
	RESOLVED: "resolved",
});

/*
 * WFRP 1e Core, printed p.75 — Falling / Upadek:
 * - resolve damage exactly as for Jumping/Zeskok;
 * - the distance involved is treated as double;
 * - Acrobatics adds +2 to the reduction d6;
 * - if Wounds are suffered, held items are dropped 50% of the time.
 *
 * This module extends the already-verified movement result/damage contracts. It
 * deliberately keeps Fall as a distinct state so the actual scene distance and
 * Core x2 rule remain visible on the chat card rather than masquerading as a
 * larger Jump height.
 */
installDialogExtension();
installMovementExtension();

function installDialogExtension() {
	if (StandardTestDialog.__wfrpFallMovementInstalled === true) return;
	Object.defineProperty(StandardTestDialog, "__wfrpFallMovementInstalled", {
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

		const group = this._numberGroup(
			"fallHeight",
			localize("Fall height", "Wysokość upadku"),
		);
		group.root.dataset.standardField = "fallHeight";
		group.input.step = "any";
		group.input.min = "0.01";

		const firstD100Only = body.querySelector("[data-standard-d100-only]");
		if (firstD100Only) body.insertBefore(group.root, firstD100Only);
		else body.append(group.root);

		const select = body.querySelector('select[name="testId"]');
		const entry = entries.find((candidate) => candidate.id === select?.value);
		this._refreshContextFields(body, entry, actor);
		return content;
	};

	StandardTestDialog._readForm = function (actor, form, entries) {
		const id = String(form?.elements?.testId?.value ?? "").trim();
		if (id !== "fall") {
			return originalReadForm.call(this, actor, form, entries);
		}

		const entry = entries.find((candidate) => candidate.id === id);
		if (!entry?.procedure) {
			throw new Error(localize(
				"Select a valid WFRP 1e Fall procedure.",
				"Wybierz prawidłową procedurę Upadku WFRP 1e.",
			));
		}

		return {
			confirmed: true,
			kind: "procedure",
			procedureId: "fall",
			options: {
				fallHeight: this._requiredPositiveNumber(
					form?.elements?.fallHeight,
					localize("Fall height", "Wysokość upadku"),
				),
			},
		};
	};

	StandardTestDialog._refreshContextFields = function (body, entry, actor) {
		originalRefreshContextFields.call(this, body, entry, actor);
		setFieldVisible(
			body,
			"fallHeight",
			String(entry?.id ?? "") === "fall",
		);
	};
}

function installMovementExtension() {
	if (MovementStandardTest.__wfrpFallMovementInstalled === true) return;
	Object.defineProperty(MovementStandardTest, "__wfrpFallMovementInstalled", {
		value: true,
		configurable: false,
	});

	const originalExecute = MovementStandardTest.execute;
	const originalPresentation = MovementStandardTest._presentation;
	const originalLuckOptions = MovementStandardTest.luckOptions;
	const originalApplyLuck = MovementStandardTest.applyLuck;
	const originalActivateListeners = MovementStandardTest.activateListeners;

	MovementStandardTest.execute = async function (actor, procedureId, options = {}) {
		if (String(procedureId ?? "").trim() === "fall") {
			return executeFall(this, actor, options);
		}
		return originalExecute.call(this, actor, procedureId, options);
	};

	MovementStandardTest._presentation = function (state) {
		if (state?.kind === "fall") return fallPresentation(this, state);
		return originalPresentation.call(this, state);
	};

	MovementStandardTest.luckOptions = function (message) {
		const state = this.stateFor(message);
		if (state?.kind !== "fall") {
			return originalLuckOptions.call(this, message);
		}
		if (state.cancelled === true) return [];

		const resolution = fallResolution(this, state);
		if (resolution.wounds <= 0 || fallIsFinalizedForHeldItems(state)) {
			return [];
		}

		return [Object.freeze({
			id: FALL_LUCK_ROLL_ID,
			die: "d6",
			delta: 1,
			value: resolution.die,
			label: localize("Fall d6", "K6 Upadku"),
			blocksAfterDamage: true,
		})];
	};

	MovementStandardTest.applyLuck = async function (message, rollId, delta) {
		if (String(rollId ?? "") !== FALL_LUCK_ROLL_ID) {
			return originalApplyLuck.call(this, message, rollId, delta);
		}

		const option = this.luckOptions(message).find(
			(entry) =>
				entry.id === FALL_LUCK_ROLL_ID &&
				entry.delta === Number(delta),
		);
		if (!option) {
			throw new Error(localize(
				"This Fall roll cannot be adjusted by Luck.",
				"Tego rzutu Upadku nie można zmienić Szczęściem.",
			));
		}

		const state = foundry.utils.deepClone(this.stateFor(message));
		const originalRoll = finiteNumber(state.die, "fall roll");
		const adjustedRoll = originalRoll + Number(delta);
		state.die = adjustedRoll;
		state.updatedAt = Date.now();
		await this._updateMessageState(message, state);
		await synchronizeFallDamage(this, message, state);

		return Object.freeze({
			rollId: FALL_LUCK_ROLL_ID,
			originalRoll,
			adjustedRoll,
			delta: Number(delta),
		});
	};

	MovementStandardTest.activateListeners = function (message, html) {
		originalActivateListeners.call(this, message, html);
		const state = this.stateFor(message);
		if (state?.kind !== "fall" || state.cancelled === true) return;

		const root = asElement(html);
		const card = root?.matches?.(".wfrp1e-test-card")
			? root
			: root?.querySelector?.(".wfrp1e-test-card");
		const button = card?.querySelector?.("[data-wfrp-held-items-roll]");
		if (!(button instanceof HTMLButtonElement)) return;

		if (!canStartHeldItemsCheck(this, message, game.user)) {
			button.hidden = true;
			return;
		}

		button.hidden = false;
		button.addEventListener("click", (event) => {
			event.preventDefault();
			button.disabled = true;
			void startHeldItemsCheck(this, message)
				.catch((error) => {
					console.error("WFRP1ED | Fall held-items check failed.", error);
					ui.notifications.error(
						error?.message ?? localize(
							"Unable to roll the held-items check.",
							"Nie udało się wykonać testu utrzymania przedmiotów.",
						),
					);
				})
				.finally(() => { button.disabled = false; });
		});
	};
}

async function executeFall(executor, actor, options) {
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("Fall requires an Actor.");
	}

	const enteredHeight = positiveNumber(options?.fallHeight, "fallHeight");
	const height = Math.ceil(enteredHeight);
	const doubledHeight = height * 2;
	const acrobaticsBonus = hasOwnedSkill(actor, "acrobatics") ? 2 : 0;
	const roll = await new Roll("1d6").evaluate({ allowInteractive: false });
	const die = finiteNumber(roll.total, "fall d6");

	const state = {
		version: FALL_STATE_VERSION,
		kind: "fall",
		actorUuid: actor.uuid,
		procedureId: "fall",
		enteredHeight,
		height,
		doubledHeight,
		acrobaticsBonus,
		die,
		heldItemsPhase: HELD_ITEMS_PHASE.PENDING,
		heldItemsCheckMessageId: null,
		sourceClimbingMessageId: String(options?.sourceClimbingMessageId ?? ""),
		cancelled: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};

	const message = await executor._publish(
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
	await synchronizeFallDamage(executor, message, state);
	return message;
}

function fallResolution(executor, state) {
	const die = finiteNumber(state?.die, "fall d6");
	const acrobaticsBonus = finiteNumber(
		state?.acrobaticsBonus ?? 0,
		"fall Acrobatics bonus",
	);
	const doubledHeight = positiveNumber(
		state?.doubledHeight,
		"fall doubled height",
	);
	const effectiveDie = die + acrobaticsBonus;
	return {
		die,
		acrobaticsBonus,
		effectiveDie,
		wounds: Math.max(0, doubledHeight - effectiveDie),
	};
}

function fallPresentation(executor, state) {
	const resolution = fallResolution(executor, state);
	const phase = normalizedHeldItemsPhase(state);
	const cancelled = state.cancelled === true;
	const showHeldItemsAction =
		!cancelled &&
		resolution.wounds > 0 &&
		phase === HELD_ITEMS_PHASE.PENDING &&
		!state.heldItemsCheckMessageId;

	let heldItemsPhaseLabel = "";
	if (!cancelled && resolution.wounds > 0 && phase === HELD_ITEMS_PHASE.ROLLING) {
		heldItemsPhaseLabel = localize(
			"Rolling held-items check…",
			"Trwa test utrzymania przedmiotów…",
		);
	} else if (!cancelled && resolution.wounds > 0 && fallIsFinalizedForHeldItems(state)) {
		heldItemsPhaseLabel = localize(
			"Held-items check resolved in a separate chat message.",
			"Test utrzymania przedmiotów rozstrzygnięto w osobnej wiadomości.",
		);
	}

	return {
		kind: "fall",
		neutral: cancelled,
		success: cancelled ? true : resolution.wounds === 0,
		procedureName: standardTestProcedureName(STANDARD_TEST_PROCEDURES.fall),
		statusLabel: cancelled
			? localize("Cancelled", "Anulowano")
			: resolution.wounds === 0
				? localize("No Wounds", "Bez obrażeń")
				: localize("Wounds", "Obrażenia"),
		fullRoundLabel: localize("Fall damage", "Obrażenia od upadku"),
		detailsHint: localize(
			"Click to show the Fall calculation",
			"Kliknij, aby pokazać obliczenie Upadku",
		),
		primaryLabel: localize("Actual fall height", "Rzeczywista wysokość upadku"),
		primaryValue: `${state.enteredHeight} ${distanceUnit()}`,
		metricLeftLabel: localize("Effective fall height", "Efektywna wysokość upadku"),
		metricLeftValue: `${state.doubledHeight} ${distanceUnit()}`,
		metricRightLabel: localize("Wounds", "Obrażenia"),
		metricRightValue: cancelled ? "—" : resolution.wounds,
		rows: [
			row(localize("Entered height", "Podana wysokość"), `${state.enteredHeight} ${distanceUnit()}`),
			row(localize("Rounded height", "Wysokość po zaokrągleniu"), `${state.height} ${distanceUnit()}`),
			row(localize("Fall rule", "Zasada Upadku"), `${state.height} × 2 = ${state.doubledHeight} ${distanceUnit()}`),
			row(localize("d6 roll", "Rzut K6"), resolution.die),
			row(localize("Acrobatics", "Akrobatyka"), signed(resolution.acrobaticsBonus)),
			row(localize("Effective d6", "Efektywny wynik K6"), resolution.effectiveDie),
			row(
				localize("Damage calculation", "Obliczenie obrażeń"),
				cancelled
					? "—"
					: `${state.doubledHeight} - ${resolution.effectiveDie} = ${resolution.wounds}`,
			),
		],
		note: cancelled
			? localize(
				"This Fall result was cancelled by its source climbing lifecycle.",
				"Ten wynik Upadku został anulowany przez powiązaną sekwencję wspinaczki.",
			)
			: resolution.wounds > 0
				? localize(
					"Fall Wounds ignore Armour and Toughness. If Wounds are suffered, resolve the normal 50% held-items check.",
					"Obrażenia od Upadku ignorują Pancerz i Wytrzymałość. Jeśli bohater odnosi obrażenia, rozstrzygnij zwykły 50% test utrzymania przedmiotów.",
				)
				: localize("No Wounds are suffered.", "Bohater nie odnosi obrażeń."),
		secondaryNote: state.acrobaticsBonus > 0
			? localize(
				"Acrobatics adds +2 to the reduction d6.",
				"Akrobatyka dodaje +2 do rzutu K6 redukującego obrażenia.",
			)
			: "",
		showHeldItemsAction,
		heldItemsActionLabel: localize(
			"Roll held-items check",
			"Rzuć test utrzymania przedmiotów",
		),
		heldItemsPhaseLabel,
	};
}

async function synchronizeFallDamage(executor, message, state) {
	const existingDamage = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	if (state.cancelled === true) {
		if (existingDamage) await message.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
		return;
	}

	const { wounds } = fallResolution(executor, state);
	if (wounds <= 0) {
		if (existingDamage) await message.unsetFlag(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
		return;
	}

	const actor = await foundry.utils.fromUuid(String(state.actorUuid ?? ""));
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error(`Fall Actor '${String(state.actorUuid ?? "")}' is unavailable.`);
	}

	const packet = new DamagePacket({
		rawAmount: wounds,
		targetActorUuid: actor.uuid,
		source: {
			kind: "movement-procedure",
			id: "fall",
			uuid: message?.uuid ?? null,
			label: standardTestProcedureName(STANDARD_TEST_PROCEDURES.fall),
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
	});
	const resolution = DamageResolver.resolve(packet);
	await DamageChat.attach(message, { packet, resolution });
}

function canStartHeldItemsCheck(executor, message, user) {
	const state = executor.stateFor(message);
	if (state?.kind !== "fall" || state.cancelled === true || !user) return false;
	if (fallResolution(executor, state).wounds <= 0) return false;
	if (fallIsFinalizedForHeldItems(state)) return false;
	if (normalizedHeldItemsPhase(state) === HELD_ITEMS_PHASE.ROLLING) return false;

	const actor = actorFromUuidSync(state.actorUuid);
	if (!(actor instanceof foundry.documents.Actor)) return false;
	const canManage = user.isGM || actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
	if (!canManage) return false;
	return user.isGM || message?.canUserModify?.(user, "update") === true;
}

async function startHeldItemsCheck(executor, message) {
	if (!canStartHeldItemsCheck(executor, message, game.user)) {
		throw new Error(localize(
			"The held-items check is not available for this Fall result.",
			"Test utrzymania przedmiotów nie jest dostępny dla tego wyniku Upadku.",
		));
	}

	const state = foundry.utils.deepClone(executor.stateFor(message));
	const actor = await foundry.utils.fromUuid(String(state.actorUuid ?? ""));
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The Actor for this Fall result is unavailable.");
	}

	state.heldItemsPhase = HELD_ITEMS_PHASE.ROLLING;
	state.updatedAt = Date.now();
	await executor._updateMessageState(message, state);

	try {
		const resultMessage = await HeldItemsCheck.publish({
			actor,
			sourceMessage: message,
		});
		state.heldItemsPhase = HELD_ITEMS_PHASE.RESOLVED;
		state.heldItemsCheckMessageId = resultMessage.id;
		state.updatedAt = Date.now();
		await executor._updateMessageState(message, state);
		return resultMessage;
	} catch (error) {
		state.heldItemsPhase = HELD_ITEMS_PHASE.PENDING;
		state.heldItemsCheckMessageId = null;
		state.updatedAt = Date.now();
		await executor._updateMessageState(message, state);
		throw error;
	}
}

function normalizedHeldItemsPhase(state) {
	if (state?.heldItemsCheckMessageId) return HELD_ITEMS_PHASE.RESOLVED;
	return Object.values(HELD_ITEMS_PHASE).includes(state?.heldItemsPhase)
		? state.heldItemsPhase
		: HELD_ITEMS_PHASE.PENDING;
}

function fallIsFinalizedForHeldItems(state) {
	return normalizedHeldItemsPhase(state) !== HELD_ITEMS_PHASE.PENDING ||
		Boolean(state?.heldItemsCheckMessageId);
}

function hasOwnedSkill(actor, rulesId) {
	return [...(actor?.items ?? [])].some((item) =>
		item?.type === "skill" &&
		String(item.system?.rulesId ?? "").trim() === String(rulesId ?? ""),
	);
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return document instanceof foundry.documents.Actor ? document : null;
	} catch (_error) {
		return null;
	}
}

function setFieldVisible(body, field, visible) {
	const element = body?.querySelector?.(`[data-standard-field="${field}"]`);
	if (element) element.hidden = !visible;
}

function row(label, value) {
	return { label, value: String(value) };
}

function distanceUnit() {
	return game.i18n.lang === "pl" ? "m" : "yd";
}

function signed(value) {
	const number = Number(value);
	return number >= 0 ? `+${number}` : String(number);
}

function positiveNumber(value, label) {
	const number = finiteNumber(value, label);
	if (number <= 0) throw new Error(`${label} must be greater than zero.`);
	return number;
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be finite: ${String(value)}.`);
	}
	return number;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
