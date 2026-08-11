import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";
import {
	CriticalWoundApplication,
} from "./CriticalWoundApplication.mjs";
import {
	DETAILED_CRITICAL_OUTCOME,
	detailedCriticalEffectText,
	isCoreDetailedEffectProvider,
} from "./CoreDetailedCriticalTables.mjs";
import { CRITICAL_TABLE_ROLE } from "./CriticalTableRegistry.mjs";
import { DetailedCriticalResolver } from "./DetailedCriticalResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const RESULT_TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/detailed-critical-result.hbs";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "detailed-critical-resolution-request";
const SOCKET_RESPONSE_TYPE = "detailed-critical-resolution-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingSocketRequests = new Map();

/** Register the detailed Critical Hit chat/result lifecycle. */
export function registerDetailedCriticalIntegration() {
	Hooks.on("renderChatMessageHTML", (message, html) => {
		applyDetailedDamageClientState(message, html);
		applyDetailedResultClientState(message, html);
	});

	Hooks.on(
		"getChatMessageContextOptions",
		(_application, menuItems) => addDetailedCriticalContextOptions(menuItems),
	);

	Hooks.once("ready", () => registerDetailedCriticalSocket());
}

/** Resolve one applied damage transaction which uses the detailed critical mode. */
export async function resolveDetailedDamageMessageCritical(message) {
	const state = damageState(message);
	const transaction = transactionForMessage(message, state);

	validatePendingDetailedCritical(
		message,
		state,
		transaction,
		game.user,
	);

	const button = findResolveButton(message);
	if (button) button.disabled = true;

	try {
		const roll = await new Roll("1d100").evaluate({
			allowInteractive: false,
		});
		const persisted = await persistDetailedCriticalRoll({
			message,
			transaction,
			roll,
		});

		if (!persisted.created) {
			refreshVisibleMessage(message);
			ui.notifications.info(
				localize(
					"This detailed critical result has already been resolved.",
					"To szczegółowe trafienie krytyczne zostało już rozstrzygnięte.",
				),
			);
			return persisted.resolution;
		}

		const resultMessage = await publishDetailedCriticalResult(
			message,
			persisted.resolution,
			roll,
		);
		refreshVisibleMessage(message);

		return {
			resolution: persisted.resolution,
			resultMessage,
		};
	} finally {
		if (button?.isConnected) button.disabled = false;
	}
}

/** Materialize a non-fatal detailed result as one persistent Critical Wound. */
export async function applyDetailedCriticalWound(message) {
	const resultState = detailedResultState(message);
	if (!resultState) {
		throw new Error("This ChatMessage is not a detailed critical result.");
	}

	const resolution = resultState.resolution;
	if (resolution?.outcome === DETAILED_CRITICAL_OUTCOME.KILLED) {
		throw new Error(
			"Fatal detailed criticals are handled by the Fate/death lifecycle and are not materialized as persistent wounds automatically.",
		);
	}

	const sourceMessage = game.messages?.get(
		String(resultState.sourceMessageId ?? ""),
	);
	const sourceState = damageState(sourceMessage);
	const actor = actorFromStateSync(sourceState);

	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The detailed critical target Actor is not available.");
	}

	if (!CriticalWoundApplication.canApply(actor, game.user)) {
		throw new Error(
			"Only a GM or the target Actor OWNER may apply this Critical Wound.",
		);
	}

	const existing = CriticalWoundApplication.existingForResolution(
		actor,
		{ resultMessageId: message.id },
	);
	if (existing) {
		await existing.sheet?.render?.({ force: true });
		refreshVisibleMessage(message);
		return { created: false, wound: existing };
	}

	const description = effectTextForClient(resolution);
	const result = await CriticalWoundApplication.create({
		actor,
		name: woundName(resolution),
		description,
		criticalValue: Number(resolution.criticalValue),
		hitLocation: String(resolution.hitLocation ?? ""),
		resolution: {
			damagePacketId: String(resultState.packetId ?? ""),
			sourceMessageId: String(resultState.sourceMessageId ?? ""),
			resultMessageId: String(message.id ?? ""),
			tableRole: String(resolution.effect?.role ?? ""),
			tableVariant: "default",
			providerId: String(resolution.effect?.providerId ?? ""),
			tableUuid: String(resolution.effect?.tableUuid ?? ""),
			tableResultId: String(resolution.effect?.resultId ?? ""),
			roll: Number(resolution.roll?.total ?? 0),
			resolvedByUserId: String(resolution.resolvedBy ?? ""),
			resolvedAt: Number(resolution.resolvedAt ?? 0),
		},
		effects: [],
	});

	refreshVisibleMessage(message);
	return result;
}

function addDetailedCriticalContextOptions(menuItems) {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize(
			"Resolve Detailed Critical",
			"Rozstrzygnij szczegółowe trafienie krytyczne",
		),
		icon: '<i class="fa-solid fa-burst"></i>',
		visible: (target) => canResolveDetailedCritical(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (!message) return;

			void resolveDetailedDamageMessageCritical(message).catch((error) => {
				reportDetailedCriticalError(error);
			});
		},
	});
}

function canResolveDetailedCritical(message, user = game.user) {
	const state = damageState(message);
	const transaction = transactionForMessage(message, state);

	return Boolean(
		state &&
		transaction?.state === "applied" &&
		Number(transaction.criticalValue) > 0 &&
		transaction.criticalMode === DAMAGE_CRITICAL_MODE.DETAILED &&
		!transaction.criticalResolution &&
		hasDetailedHitLocation(state.packet?.hitLocation) &&
		canUserResolveDetailedCritical(message, state, user)
	);
}

function canUserResolveDetailedCritical(message, state, user) {
	if (!user) return false;
	if (user.isGM) return true;

	return Boolean(
		sourceUserId(message, state) &&
		sourceUserId(message, state) === String(user.id ?? ""),
	);
}

function validatePendingDetailedCritical(
	message,
	state,
	transaction,
	user,
) {
	if (!state) {
		throw new Error(
			"This ChatMessage does not contain WFRP damage data.",
		);
	}

	if (!transaction || transaction.state !== "applied") {
		throw new Error(
			"Detailed critical resolution requires an applied damage transaction.",
		);
	}

	const criticalValue = Number(transaction.criticalValue);
	if (!Number.isInteger(criticalValue) || criticalValue <= 0) {
		throw new Error("This damage transaction has no critical overflow.");
	}

	if (transaction.criticalMode !== DAMAGE_CRITICAL_MODE.DETAILED) {
		throw new Error(
			"This critical does not use the detailed Critical Hit resolver.",
		);
	}

	if (transaction.criticalResolution) {
		throw new Error("This critical result has already been resolved.");
	}

	if (!hasDetailedHitLocation(state.packet?.hitLocation)) {
		throw new Error(
			"Detailed Critical Hits require a humanoid hit location on the DamagePacket.",
		);
	}

	if (!canUserResolveDetailedCritical(message, state, user)) {
		throw new Error(
			"Only a GM or the user who caused this damage may resolve the detailed critical result.",
		);
	}
}

async function persistDetailedCriticalRoll({ message, transaction, roll }) {
	const state = damageState(message);
	const actor = actorFromStateSync(state);

	if (
		actor instanceof foundry.documents.Actor &&
		DamageApplication.canApply(actor, game.user)
	) {
		const current = DamageApplication.transactionFor(
			actor,
			state.packet?.id,
		);

		if (current?.criticalResolution) {
			return {
				created: false,
				resolution: current.criticalResolution,
			};
		}

		const resolution = await DetailedCriticalResolver.resolve(
			Number(transaction.criticalValue),
			String(state.packet?.hitLocation ?? ""),
			{ roll },
		);
		const updated = await DamageApplication.recordCriticalResolution({
			actor,
			packetId: state.packet?.id ?? transaction.packetId,
			criticalResolution: resolution,
		});

		return {
			created: true,
			resolution: updated.criticalResolution,
		};
	}

	return requestGmDetailedCriticalPersistence(message, roll);
}

async function requestGmDetailedCriticalPersistence(message, roll) {
	if (!game.socket) {
		throw new Error(
			"The Foundry system socket is not available for detailed critical resolution.",
		);
	}

	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(
			localize(
				"An active GM is required to resolve this detailed critical for a target you do not own.",
				"Do rozstrzygnięcia tego szczegółowego trafienia krytycznego wymagany jest aktywny MG, jeśli nie jesteś właścicielem celu.",
			),
		);
	}

	const requestId = foundry.utils.randomID();
	const payload = {
		type: SOCKET_REQUEST_TYPE,
		requestId,
		requesterUserId: game.user?.id ?? "",
		sourceMessageId: message.id,
		roll: roll.toJSON(),
	};

	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			pendingSocketRequests.delete(requestId);
			reject(new Error(
				localize(
					"The GM did not confirm the detailed critical result in time.",
					"MG nie potwierdził wyniku szczegółowego trafienia krytycznego w wymaganym czasie.",
				),
			));
		}, SOCKET_TIMEOUT_MS);

		pendingSocketRequests.set(requestId, {
			resolve,
			reject,
			timeoutId,
		});

		game.socket.emit(SOCKET_CHANNEL, payload);
	});
}

function registerDetailedCriticalSocket() {
	if (!game.socket) return;

	game.socket.on(SOCKET_CHANNEL, (payload) => {
		void handleDetailedCriticalSocketPayload(payload);
	});
}

async function handleDetailedCriticalSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;

	if (payload.type === SOCKET_RESPONSE_TYPE) {
		handleDetailedCriticalSocketResponse(payload);
		return;
	}

	if (payload.type !== SOCKET_REQUEST_TYPE || !isPrimaryActiveGm()) {
		return;
	}

	const response = {
		type: SOCKET_RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requesterUserId: String(payload.requesterUserId ?? ""),
		ok: false,
		created: false,
		resolution: null,
		error: null,
	};

	try {
		const result = await resolveDetailedCriticalRequestAsGm(payload);
		response.ok = true;
		response.created = result.created;
		response.resolution = foundry.utils.deepClone(result.resolution);
	} catch (error) {
		console.error(
			"WFRP1ED | GM rejected detailed critical resolution request.",
			error,
		);
		response.error =
			error?.message ?? "Unable to resolve detailed critical result.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleDetailedCriticalSocketResponse(payload) {
	if (String(payload.requesterUserId ?? "") !== String(game.user?.id ?? "")) {
		return;
	}

	const requestId = String(payload.requestId ?? "");
	const pending = pendingSocketRequests.get(requestId);
	if (!pending) return;

	pendingSocketRequests.delete(requestId);
	clearTimeout(pending.timeoutId);

	if (!payload.ok) {
		pending.reject(new Error(
			String(payload.error ?? "Unable to resolve detailed critical result."),
		));
		return;
	}

	pending.resolve({
		created: Boolean(payload.created),
		resolution: foundry.utils.deepClone(payload.resolution),
	});
}

async function resolveDetailedCriticalRequestAsGm(payload) {
	const requester = game.users?.get(String(payload.requesterUserId ?? ""));
	const message = game.messages?.get(String(payload.sourceMessageId ?? ""));
	const state = damageState(message);

	if (!requester || !requester.active) {
		throw new Error("The requesting user is not active.");
	}

	if (!message || !state) {
		throw new Error("The source damage message is not available.");
	}

	if (!canUserResolveDetailedCritical(message, state, requester)) {
		throw new Error(
			"The requesting user is not allowed to resolve this detailed critical result.",
		);
	}

	const actor = await foundry.utils.fromUuid(
		String(state.packet?.targetActorUuid ?? ""),
	);
	if (!(actor instanceof foundry.documents.Actor)) {
		throw new Error("The damage target Actor is not available.");
	}

	const transaction = DamageApplication.transactionFor(
		actor,
		state.packet?.id,
	);

	if (transaction?.criticalResolution) {
		return {
			created: false,
			resolution: transaction.criticalResolution,
		};
	}

	validatePendingDetailedCritical(
		message,
		state,
		transaction,
		requester,
	);

	const roll = Roll.fromData(payload.roll);
	if (!Number.isInteger(Number(roll?.total))) {
		throw new Error("The submitted detailed critical roll is not evaluated.");
	}

	const resolution = await DetailedCriticalResolver.resolve(
		Number(transaction.criticalValue),
		String(state.packet?.hitLocation ?? ""),
		{ roll },
	);
	const updated = await DamageApplication.recordCriticalResolution({
		actor,
		packetId: state.packet?.id ?? transaction.packetId,
		criticalResolution: resolution,
	});

	return {
		created: true,
		resolution: updated.criticalResolution,
	};
}

async function publishDetailedCriticalResult(sourceMessage, resolution, roll) {
	const content = await foundry.applications.handlebars.renderTemplate(
		RESULT_TEMPLATE_PATH,
		detailedResultTemplateContext(resolution),
	);
	const chatData = await roll.toMessage(
		{
			speaker: foundry.utils.deepClone(sourceMessage.speaker),
			flags: {
				[FLAG_SCOPE]: {
					[CRITICAL_RESULT_FLAG_KEY]: {
						version: 2,
						kind: "detailed",
						sourceMessageId: sourceMessage.id,
						packetId: damageState(sourceMessage)?.packet?.id ?? null,
						resolution: foundry.utils.deepClone(resolution),
					},
				},
			},
		},
		{ create: false },
	);

	chatData.content = content;
	const criticalMessage = await ChatMessage.create(chatData);

	if (
		criticalMessage?.id &&
		game.dice3d?.waitFor3DAnimationByMessageID
	) {
		await game.dice3d.waitFor3DAnimationByMessageID(criticalMessage.id);
	}

	return criticalMessage;
}

function detailedResultTemplateContext(resolution) {
	return {
		title: detailedHeader(resolution),
		rollLabel: game.i18n.lang === "pl" ? "K100" : "d100",
		rollTotal: resolution?.roll?.total ?? "—",
		meta: detailedMeta(resolution),
		effectText: effectTextForClient(resolution),
		fleeText: resolution?.flee
			? localize(
				"The victim must flee combat if possible.",
				"Ofiara musi uciekać z walki, jeśli jest to możliwe.",
			)
			: "",
		outcomeClass: resolution?.outcome
			? `is-${resolution.outcome}`
			: "",
	};
}

function applyDetailedDamageClientState(message, html) {
	const state = damageState(message);
	if (!state) return;

	const transaction = transactionForMessage(message, state);
	if (
		!transaction ||
		Number(transaction.criticalValue) <= 0 ||
		transaction.criticalMode !== DAMAGE_CRITICAL_MODE.DETAILED
	) {
		return;
	}

	const root = asElement(html);
	const host =
		root?.querySelector?.(".wfrp1e-test-card, .wfrp1e-damage-card") ??
		(root?.matches?.(".wfrp1e-test-card, .wfrp1e-damage-card") ? root : null);
	if (!host) return;

	host.querySelector?.("[data-wfrp-detailed-critical-panel]")?.remove();
	const panel = document.createElement("section");
	panel.className = "wfrp1e-critical-result";
	panel.dataset.wfrpDetailedCriticalPanel = "";

	const header = document.createElement("div");
	header.className = "wfrp1e-critical-result__header";
	const title = document.createElement("strong");
	title.textContent = `${localize("Critical Hit", "Trafienie krytyczne")} +${displayCriticalVariant(
		DetailedCriticalResolver.variantForCriticalValue(
			Number(transaction.criticalValue),
		),
	)} — ${hitLocationLabel(state.packet?.hitLocation)}`;
	header.append(title);
	panel.append(header);

	if (!hasDetailedHitLocation(state.packet?.hitLocation)) {
		const warning = document.createElement("div");
		warning.className = "wfrp1e-critical-result__pending";
		warning.textContent = localize(
			"A detailed Critical Hit cannot be resolved until the damage has a humanoid hit location.",
			"Szczegółowego trafienia krytycznego nie można rozstrzygnąć, dopóki obrażenia nie mają określonej lokacji trafienia humanoida.",
		);
		panel.append(warning);
		host.append(panel);
		return;
	}

	if (transaction.criticalResolution) {
		const resolved = document.createElement("div");
		resolved.className = "wfrp1e-critical-result__resolved";
		resolved.textContent = localize(
			"✓ Detailed critical resolved",
			"✓ Szczegółowe trafienie krytyczne rozstrzygnięte",
		);
		panel.append(resolved);
		host.append(panel);
		return;
	}

	if (canResolveDetailedCritical(message)) {
		const action = document.createElement("button");
		action.type = "button";
		action.className = "wfrp1e-critical-result__action";
		action.dataset.wfrpResolveDetailedCritical = "";
		action.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${localize(
			"Resolve Detailed Critical",
			"Rozstrzygnij szczegółowe trafienie krytyczne",
		)}`;
		action.addEventListener("click", () => {
			action.disabled = true;
			void resolveDetailedDamageMessageCritical(message).catch((error) => {
				action.disabled = false;
				reportDetailedCriticalError(error);
			});
		});
		panel.append(action);
	} else {
		const pending = document.createElement("div");
		pending.className = "wfrp1e-critical-result__pending";
		pending.textContent = localize(
			"Awaiting the GM or damage source to resolve the detailed critical.",
			"Oczekuje na rozstrzygnięcie szczegółowego trafienia krytycznego przez MG lub sprawcę obrażeń.",
		);
		panel.append(pending);
	}

	host.append(panel);
}

function applyDetailedResultClientState(message, html) {
	const state = detailedResultState(message);
	if (!state) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	const resolution = state.resolution;
	card.classList.toggle(
		"is-killed",
		resolution?.outcome === DETAILED_CRITICAL_OUTCOME.KILLED,
	);

	setText(
		card,
		"[data-wfrp-detailed-title]",
		detailedHeader(resolution),
	);
	setText(
		card,
		"[data-wfrp-detailed-roll]",
		`${game.i18n.lang === "pl" ? "K100" : "d100"}: ${resolution?.roll?.total ?? "—"}`,
	);
	setText(card, "[data-wfrp-detailed-meta]", detailedMeta(resolution));
	setText(
		card,
		"[data-wfrp-detailed-effect]",
		effectTextForClient(resolution),
	);

	const flee = card.querySelector("[data-wfrp-detailed-flee]");
	if (flee) {
		flee.hidden = !resolution?.flee;
		flee.textContent = resolution?.flee
			? localize(
				"The victim must flee combat if possible.",
				"Ofiara musi uciekać z walki, jeśli jest to możliwe.",
			)
			: "";
	}

	applyWoundApplicationPanel(message, card, state);
}

function applyWoundApplicationPanel(message, card, resultState) {
	card.querySelector?.("[data-wfrp-critical-wound-application]")?.remove();

	const resolution = resultState.resolution;
	if (resolution?.outcome === DETAILED_CRITICAL_OUTCOME.KILLED) {
		return;
	}

	const sourceMessage = game.messages?.get(
		String(resultState.sourceMessageId ?? ""),
	);
	const actor = actorFromStateSync(damageState(sourceMessage));
	if (!(actor instanceof foundry.documents.Actor)) return;

	const panel = document.createElement("section");
	panel.className = "wfrp1e-fate-intervention";
	panel.dataset.wfrpCriticalWoundApplication = "";

	const existing = CriticalWoundApplication.existingForResolution(
		actor,
		{ resultMessageId: message.id },
	);

	if (existing) {
		const status = document.createElement("div");
		status.className = "wfrp1e-fate-intervention__spent";
		status.textContent = localize(
			"✓ Critical Wound applied to the character",
			"✓ Rana krytyczna została przypisana do postaci",
		);
		panel.append(status);

		const open = document.createElement("button");
		open.type = "button";
		open.className = "wfrp1e-fate-intervention__action";
		open.innerHTML = `<i class="fa-solid fa-heart-crack"></i> ${localize(
			"Open Critical Wound",
			"Otwórz ranę krytyczną",
		)}`;
		open.addEventListener("click", () => {
			void existing.sheet?.render?.({ force: true });
		});
		panel.append(open);
		card.append(panel);
		return;
	}

	if (CriticalWoundApplication.canApply(actor, game.user)) {
		const action = document.createElement("button");
		action.type = "button";
		action.className = "wfrp1e-fate-intervention__action";
		action.innerHTML = `<i class="fa-solid fa-heart-crack"></i> ${localize(
			"Apply Critical Wound",
			"Zastosuj ranę krytyczną",
		)}`;
		action.addEventListener("click", () => {
			action.disabled = true;
			void applyDetailedCriticalWound(message).catch((error) => {
				action.disabled = false;
				reportWoundApplicationError(error);
			});
		});
		panel.append(action);
	} else {
		const pending = document.createElement("div");
		pending.className = "wfrp1e-critical-result__pending";
		pending.textContent = localize(
			"Awaiting the GM or target owner to apply the persistent Critical Wound.",
			"Oczekuje na MG lub właściciela celu, który zastosuje trwałą ranę krytyczną.",
		);
		panel.append(pending);
	}

	card.append(panel);
}

function detailedResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		state?.resolution?.role === CRITICAL_TABLE_ROLE.DETAILED_CHART
		? state
		: null;
}

function detailedHeader(resolution) {
	return `${localize("Critical Hit", "Trafienie krytyczne")} +${displayCriticalVariant(
		resolution?.variant,
	)} — ${hitLocationLabel(resolution?.hitLocation)}`;
}

function detailedMeta(resolution) {
	return `${localize("Effect", "Efekt")}: ${resolution?.effectNumber ?? "—"} · ${localize(
		"Location",
		"Lokacja",
	)}: ${hitLocationLabel(resolution?.hitLocation)}`;
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

	return String(resolution?.effect?.text ?? "").trim() ||
		localize("Custom critical effect", "Własny efekt krytyczny");
}

function woundName(resolution) {
	return `${localize("Critical Wound", "Rana krytyczna")} — ${hitLocationLabel(
		resolution?.hitLocation,
	)} ${resolution?.effectNumber ?? ""}`.trim();
}

function hitLocationLabel(hitLocation) {
	switch (String(hitLocation ?? "")) {
		case "head":
			return localize("Head", "Głowa");
		case "rightArm":
			return localize("Right Arm", "Prawa ręka");
		case "leftArm":
			return localize("Left Arm", "Lewa ręka");
		case "body":
			return localize("Body", "Korpus");
		case "rightLeg":
			return localize("Right Leg", "Prawa noga");
		case "leftLeg":
			return localize("Left Leg", "Lewa noga");
		default:
			return localize("Unknown location", "Nieznana lokacja");
	}
}

function hasDetailedHitLocation(value) {
	try {
		DetailedCriticalResolver.effectLocationForHitLocation(value);
		return true;
	} catch (_error) {
		return false;
	}
}

function displayCriticalVariant(variant) {
	return String(variant ?? "").replace(/\+$/, "") || "—";
}

function transactionForMessage(message, state = damageState(message)) {
	if (!state) return null;

	const actor = actorFromStateSync(state);
	const authoritative = actor instanceof foundry.documents.Actor
		? DamageApplication.transactionFor(actor, state.packet?.id)
		: null;

	return authoritative ?? state.application ?? null;
}

function damageState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function actorFromStateSync(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.packet?.targetActorUuid ?? ""),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function sourceUserId(message, state) {
	return String(
		state?.createdBy ??
			message?.user?.id ??
			message?.author?.id ??
			"",
	).trim();
}

function primaryActiveGm() {
	const activeGms = (game.users ?? [])
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)));

	return activeGms[0] ?? null;
}

function isPrimaryActiveGm() {
	const primary = primaryActiveGm();
	return Boolean(
		game.user?.isGM &&
		primary &&
		String(primary.id) === String(game.user.id),
	);
}

function findResolveButton(message) {
	if (!message?.id) return null;
	return document.querySelector(
		`[data-message-id="${message.id}"] [data-wfrp-resolve-detailed-critical]`,
	);
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

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function setText(root, selector, value) {
	const element = root?.querySelector?.(selector);
	if (element) element.textContent = String(value ?? "");
}

function refreshVisibleMessage(message) {
	if (!message?.id) return;

	const entry = document.querySelector(
		`[data-message-id="${message.id}"]`,
	);
	if (entry) {
		applyDetailedDamageClientState(message, entry);
		applyDetailedResultClientState(message, entry);
	}
}

function reportDetailedCriticalError(error) {
	console.error(
		"WFRP1ED | Unable to resolve detailed critical from ChatMessage.",
		error,
	);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to resolve detailed critical result.",
			"Nie można rozstrzygnąć szczegółowego trafienia krytycznego.",
		),
	);
}

function reportWoundApplicationError(error) {
	console.error(
		"WFRP1ED | Unable to apply Critical Wound from detailed result.",
		error,
	);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to apply the Critical Wound.",
			"Nie można zastosować rany krytycznej.",
		),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
