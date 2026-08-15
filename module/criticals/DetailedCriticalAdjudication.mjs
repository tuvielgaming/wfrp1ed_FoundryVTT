import { DamageApplication } from "../damage/DamageApplication.mjs";
import {
	detailedCriticalEffectText,
	DETAILED_CRITICAL_OUTCOME,
	isCoreDetailedEffectProvider,
} from "./CoreDetailedCriticalTables.mjs";
import { CriticalWoundApplication } from "./CriticalWoundApplication.mjs";
import { DetailedCriticalResolver } from "./DetailedCriticalResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const ROLL_SELECTOR = "[data-wfrp-detailed-critical-roll-input]";
const activeEdits = new Set();

/*
 * CriticalBootstrap is loaded before this module and registers the canonical
 * detailed-result render hook from its init callback. Register our editor from a
 * later init callback so the canonical renderer writes title/meta/effect first;
 * this adjudication layer then replaces only the d100 presentation with an input.
 */
Hooks.once("init", () => {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		const state = detailedResultState(message);
		if (!state) return;

		const root = asElement(html);
		const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
			? root
			: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
		if (!card) return;

		installCriticalRollEditor(message, state, card);
	});
});

/**
 * Post-resolution GM adjudication for the detailed Critical Hit d100.
 *
 * The original random event is never rerolled. Editing the visible d100 replaces
 * only the stored table-resolution snapshot, then synchronizes an already-
 * materialized Critical Wound to the newly selected Core/custom result.
 */
function installCriticalRollEditor(message, state, card) {
	const host = card.querySelector("[data-wfrp-detailed-roll]");
	if (!(host instanceof HTMLElement)) return;

	let input = host.querySelector(ROLL_SELECTOR);
	if (!(input instanceof HTMLInputElement)) {
		host.textContent = "";
		host.classList.add("wfrp1e-critical-result__roll-editor");

		const label = document.createElement("span");
		label.className = "wfrp1e-critical-result__roll-label";
		label.textContent = game.i18n.lang === "pl" ? "K100" : "d100";

		input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "100";
		input.step = "1";
		input.inputMode = "numeric";
		input.autocomplete = "off";
		input.dataset.wfrpDetailedCriticalRollInput = "";
		input.className = "wfrp1e-critical-result__roll-input";

		host.append(label, input);
	}

	input.value = String(state.resolution?.roll?.total ?? "");
	input.readOnly = !game.user?.isGM;
	input.classList.toggle("is-editable", game.user?.isGM === true);
	input.classList.toggle("is-readonly", game.user?.isGM !== true);
	input.title = game.user?.isGM
		? localize(
			"GM: enter a d100 result from 1 to 100. The critical result and any linked Critical Wound will be recalculated without rerolling.",
			"MG: wprowadź wynik K100 od 1 do 100. Trafienie krytyczne i powiązana Rana Krytyczna zostaną przeliczone bez ponownego rzutu.",
		)
		: localize(
			"Only the GM may adjudicate an already-resolved critical d100.",
			"Tylko MG może zmienić już rozstrzygnięty rzut krytyczny K100.",
		);

	if (!game.user?.isGM || input.dataset.wfrpCriticalEditorBound === "true") {
		return;
	}
	input.dataset.wfrpCriticalEditorBound = "true";

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});

	input.addEventListener("change", () => {
		void adjudicateCriticalRoll(message, input);
	});
}

async function adjudicateCriticalRoll(message, input) {
	const messageId = String(message?.id ?? "");
	if (!messageId || activeEdits.has(messageId)) return;

	try {
		if (!game.user?.isGM) {
			throw new Error("Only a GM may adjudicate a detailed critical result.");
		}

		const raw = String(input?.value ?? "").trim();
		const requested = Number(raw);
		if (
			!raw ||
			!Number.isInteger(requested) ||
			requested < 1 ||
			requested > 100
		) {
			throw new Error(localize(
				"Enter a whole d100 result from 1 to 100.",
				"Wprowadź całkowity wynik K100 od 1 do 100.",
			));
		}

		const state = detailedResultState(message);
		const sourceMessage = game.messages?.get(String(state?.sourceMessageId ?? ""));
		const damageState = sourceMessage?.getFlag?.(
			FLAG_SCOPE,
			DAMAGE_STATE_FLAG_KEY,
		);
		const actor = actorFromDamageState(damageState);
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error("The critical target Actor is no longer available.");
		}

		const packetId = String(state?.packetId ?? damageState?.packet?.id ?? "").trim();
		const transaction = DamageApplication.transactionFor(actor, packetId);
		if (
			transaction?.state !== "applied" ||
			!transaction.criticalResolution
		) {
			throw new Error(
				"Critical adjudication requires the still-applied damage transaction which produced this result.",
			);
		}

		assertFatalResultNotApplied(actor, packetId);

		if (Number(state.resolution?.roll?.total) === requested) return;

		activeEdits.add(messageId);
		input.disabled = true;

		const resolution = await DetailedCriticalResolver.resolve(
			Number(transaction.criticalValue),
			String(damageState?.packet?.hitLocation ?? ""),
			{
				/* A fixed adjudicated total is not another random Roll. */
				roll: {
					formula: "1d100",
					total: requested,
				},
			},
		);

		await DamageApplication.replaceCriticalResolution({
			actor,
			packetId,
			criticalResolution: resolution,
			user: game.user,
		});

		await synchronizeLinkedCriticalWound(
			message,
			actor,
			state,
			resolution,
		);

		const updatedState = foundry.utils.deepClone(state);
		updatedState.version = Math.max(3, Number(updatedState.version) || 0);
		updatedState.originalRoll = Number(
			state.originalRoll ?? state.resolution?.roll?.total ?? requested,
		);
		updatedState.rollEdited = requested !== updatedState.originalRoll;
		updatedState.rollEditedBy = String(game.user?.id ?? "");
		updatedState.rollEditedAt = Date.now();
		updatedState.resolution = foundry.utils.deepClone(resolution);

		await message.setFlag(
			FLAG_SCOPE,
			CRITICAL_RESULT_FLAG_KEY,
			updatedState,
		);

		void ui.chat?.render?.({ force: true });
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to adjudicate detailed critical d100.",
			error,
		);
		const current = detailedResultState(message);
		if (input) {
			input.value = String(current?.resolution?.roll?.total ?? "");
			input.disabled = false;
		}
		ui.notifications.error(error?.message ?? localize(
			"Unable to change the detailed critical result.",
			"Nie udało się zmienić wyniku szczegółowego trafienia krytycznego.",
		));
	} finally {
		activeEdits.delete(messageId);
	}
}

async function synchronizeLinkedCriticalWound(
	message,
	actor,
	resultState,
	resolution,
) {
	const existing = CriticalWoundApplication.existingForResolution(
		actor,
		{ resultMessageId: message.id },
	);

	if (resolution?.outcome === DETAILED_CRITICAL_OUTCOME.KILLED) {
		if (existing) await existing.delete();
		return;
	}

	if (!existing) return;

	await existing.update({
		name: woundName(resolution),
		"system.description": effectTextForClient(resolution),
		"system.criticalValue": Number(resolution.criticalValue),
		"system.hitLocation": String(resolution.hitLocation ?? ""),
		"system.resolution.damagePacketId": String(resultState.packetId ?? ""),
		"system.resolution.sourceMessageId": String(resultState.sourceMessageId ?? ""),
		"system.resolution.resultMessageId": String(message.id ?? ""),
		"system.resolution.tableRole": String(resolution.effect?.role ?? ""),
		"system.resolution.tableVariant": "default",
		"system.resolution.providerId": String(resolution.effect?.providerId ?? ""),
		"system.resolution.tableUuid": String(resolution.effect?.tableUuid ?? ""),
		"system.resolution.tableResultId": String(resolution.effect?.resultId ?? ""),
		"system.resolution.roll": Number(resolution.roll?.total ?? 0),
		"system.resolution.resolvedByUserId": String(resolution.resolvedBy ?? ""),
		"system.resolution.resolvedAt": Number(resolution.resolvedAt ?? 0),
	});

	void existing.sheet?.render?.({ force: true });
}

function assertFatalResultNotApplied(actor, packetId) {
	const fatalApplications = actor.getFlag?.(
		FLAG_SCOPE,
		FATAL_APPLICATIONS_FLAG_KEY,
	);
	const fatal = fatalApplications &&
		typeof fatalApplications === "object" &&
		!Array.isArray(fatalApplications)
			? fatalApplications[packetId]
			: null;
	if (fatal?.state === "applied") {
		throw new Error(localize(
			"This fatal critical has already been applied. Revert/invalidate that outcome before adjudicating its d100.",
			"To śmiertelne trafienie krytyczne zostało już zastosowane. Cofnij/unieważnij ten wynik przed zmianą jego K100.",
		));
	}

	const interventions = actor.getFlag?.(
		FLAG_SCOPE,
		FATE_INTERVENTIONS_FLAG_KEY,
	);
	if (
		interventions &&
		typeof interventions === "object" &&
		!Array.isArray(interventions) &&
		interventions[packetId]
	) {
		throw new Error(localize(
			"A Fate Point has already been spent for this critical result; its d100 can no longer be edited directly.",
			"Dla tego trafienia krytycznego wydano już Punkt Przeznaczenia; jego K100 nie może już być bezpośrednio edytowane.",
		));
	}
}

function detailedResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		state.kind === "detailed" &&
		state.resolution
		? state
		: null;
}

function actorFromDamageState(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.packet?.targetActorUuid ?? ""),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function effectTextForClient(resolution) {
	if (
		isCoreDetailedEffectProvider(resolution?.effect?.providerId) &&
		resolution?.effectLocation &&
		Number.isInteger(Number(resolution?.effectNumber))
	) {
		return detailedCriticalEffectText(
			String(resolution.effectLocation),
			Number(resolution.effectNumber),
			game.i18n.lang,
		);
	}
	return String(resolution?.effect?.text ?? "").trim();
}

function woundName(resolution) {
	return `${localize("Critical Wound", "Rana krytyczna")} — ${hitLocationLabel(
		resolution?.hitLocation,
	)} ${resolution?.effectNumber ?? ""}`.trim();
}

function hitLocationLabel(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "head": return localize("Head", "Głowa");
		case "rightArm": return localize("Right Arm", "Prawa ręka");
		case "leftArm": return localize("Left Arm", "Lewa ręka");
		case "body": return localize("Body", "Korpus");
		case "rightLeg": return localize("Right Leg", "Prawa noga");
		case "leftLeg": return localize("Left Leg", "Lewa noga");
		default: return localize("Unknown location", "Nieznana lokacja");
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
