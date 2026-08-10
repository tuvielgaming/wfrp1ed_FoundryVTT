import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";
import { SuddenDeathResolver } from "./SuddenDeathResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const CRITICAL_RESULT_TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/critical-result.hbs";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "critical-resolution-request";
const SOCKET_RESPONSE_TYPE = "critical-resolution-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingSocketRequests = new Map();

/**
 * Bridge applied damage transactions into the critical subsystem.
 *
 * Obrażenia i wynik krytyczny pozostają dwoma oddzielnymi etapami. Transakcja
 * na Actorze jest źródłem prawdy, natomiast karta obrażeń tylko prezentuje stan
 * i udostępnia akcję rozstrzygnięcia krytyka właściwemu użytkownikowi.
 */
export function registerCriticalDamageIntegration() {
	Hooks.on("updateActor", (actor) => {
		refreshActorCriticalCards(actor);

		// GM synchronizuje transakcję z wiadomością źródłową, aby gracz atakujący
		// widział stan krytyka nawet wtedy, gdy nie ma dostępu do Actor-a celu.
		if (isPrimaryActiveGm()) {
			void mirrorActorCriticalTransactions(actor).catch((error) => {
				console.error(
					"WFRP1ED | Unable to mirror critical damage state to ChatMessage.",
					error,
				);
			});
		}
	});

	Hooks.on(
		"renderChatMessageHTML",
		(message, html) => applyCriticalClientState(message, html),
	);

	Hooks.on(
		"getChatMessageContextOptions",
		(_application, menuItems) => addCriticalContextOptions(menuItems),
	);

	Hooks.once("ready", () => registerCriticalSocket());
}

/**
 * Resolve a pending critical attached to one damage-bearing ChatMessage.
 *
 * The d100 is evaluated by the clicking user, persisted first, and only then
 * published as a separate roll-bearing ChatMessage. This keeps Dice So Nice
 * on Foundry's normal roll-message path and prevents the damage card from
 * becoming a second critical-result card.
 */
export async function resolveDamageMessageCritical(message) {
	const state = damageState(message);
	const transaction = transactionForMessage(message, state);

	validatePendingCritical(message, state, transaction, game.user);

	const button = findResolveButton(message);
	if (button) button.disabled = true;

	try {
		const roll = await new Roll("1d100").evaluate({
			allowInteractive: false,
		});
		const persisted = await persistCriticalRoll({
			message,
			transaction,
			roll,
		});

		if (!persisted.created) {
			refreshVisibleCriticalMessage(message);
			ui.notifications.info(
				localize(
					"WFRP1ED.Critical.AlreadyResolved",
					"This critical result has already been resolved.",
					"To trafienie krytyczne zostało już rozstrzygnięte.",
				),
			);
			return persisted.resolution;
		}

		await publishCriticalResult(message, persisted.resolution, roll);
		refreshVisibleCriticalMessage(message);

		return persisted.resolution;
	} finally {
		if (button?.isConnected) button.disabled = false;
	}
}

function addCriticalContextOptions(menuItems) {
	if (!Array.isArray(menuItems)) return;

	menuItems.push({
		label: localize(
			"WFRP1ED.Critical.Resolve",
			"Resolve Critical",
			"Rozstrzygnij trafienie krytyczne",
		),
		icon: '<i class="fa-solid fa-skull"></i>',
		visible: (target) => canResolveMessageCritical(
			messageFromContextTarget(target),
		),
		onClick: (_event, target) => {
			const message = messageFromContextTarget(target);
			if (!message) return;

			void resolveDamageMessageCritical(message).catch((error) => {
				reportCriticalResolutionError(error);
			});
		},
	});
}

function canResolveMessageCritical(message, user = game.user) {
	const state = damageState(message);
	const transaction = transactionForMessage(message, state);

	return Boolean(
		state &&
		transaction?.state === "applied" &&
		Number(transaction.criticalValue) > 0 &&
		transaction.criticalMode === DAMAGE_CRITICAL_MODE.SUDDEN_DEATH &&
		!transaction.criticalResolution &&
		canUserResolveMessageCritical(message, state, user)
	);
}

function canUserResolveMessageCritical(message, state, user) {
	if (!user) return false;
	if (user.isGM) return true;

	return Boolean(
		sourceUserId(message, state) &&
		sourceUserId(message, state) === String(user.id ?? ""),
	);
}

function validatePendingCritical(message, state, transaction, user) {
	if (!state) {
		throw new Error(
			"This ChatMessage does not contain WFRP damage data.",
		);
	}

	if (!transaction || transaction.state !== "applied") {
		throw new Error(
			"Critical resolution requires an applied damage transaction.",
		);
	}

	const criticalValue = Number(transaction.criticalValue);
	if (!Number.isInteger(criticalValue) || criticalValue <= 0) {
		throw new Error("This damage transaction has no critical overflow.");
	}

	if (transaction.criticalMode !== DAMAGE_CRITICAL_MODE.SUDDEN_DEATH) {
		throw new Error(
			"This critical does not use the Sudden Death resolver.",
		);
	}

	if (transaction.criticalResolution) {
		throw new Error("This critical result has already been resolved.");
	}

	if (!canUserResolveMessageCritical(message, state, user)) {
		throw new Error(
			"Only a GM or the user who caused this damage may resolve the critical result.",
		);
	}
}

async function persistCriticalRoll({ message, transaction, roll }) {
	const state = damageState(message);
	const actor = actorFromStateSync(state);

	// Jeżeli klikający użytkownik może zapisać Actor-a (np. GM albo właściciel
	// celu, który jednocześnie spowodował obrażenia), nie potrzebujemy socketu.
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

		const resolution = await SuddenDeathResolver.resolve(
			Number(transaction.criticalValue),
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

	return requestGmCriticalPersistence(message, roll);
}

async function requestGmCriticalPersistence(message, roll) {
	if (!game.socket) {
		throw new Error(
			"The Foundry system socket is not available for critical resolution.",
		);
	}

	const gm = primaryActiveGm();
	if (!gm) {
		throw new Error(
			localize(
				"WFRP1ED.Critical.ActiveGmRequired",
				"An active GM is required to resolve this critical for a target you do not own.",
				"Do rozstrzygnięcia tego trafienia krytycznego wymagany jest aktywny MG, jeśli nie jesteś właścicielem celu.",
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
					"WFRP1ED.Critical.GmTimeout",
					"The GM did not confirm the critical result in time.",
					"MG nie potwierdził wyniku trafienia krytycznego w wymaganym czasie.",
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

function registerCriticalSocket() {
	if (!game.socket) return;

	game.socket.on(SOCKET_CHANNEL, (payload) => {
		void handleCriticalSocketPayload(payload);
	});
}

async function handleCriticalSocketPayload(payload) {
	if (!payload || typeof payload !== "object") return;

	if (payload.type === SOCKET_RESPONSE_TYPE) {
		handleCriticalSocketResponse(payload);
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
		const result = await resolveCriticalRequestAsGm(payload);
		response.ok = true;
		response.created = result.created;
		response.resolution = foundry.utils.deepClone(result.resolution);
	} catch (error) {
		console.error(
			"WFRP1ED | GM rejected critical resolution request.",
			error,
		);
		response.error = error?.message ?? "Unable to resolve critical result.";
	}

	game.socket.emit(SOCKET_CHANNEL, response);
}

function handleCriticalSocketResponse(payload) {
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
			String(payload.error ?? "Unable to resolve critical result."),
		));
		return;
	}

	pending.resolve({
		created: Boolean(payload.created),
		resolution: foundry.utils.deepClone(payload.resolution),
	});
}

async function resolveCriticalRequestAsGm(payload) {
	const requester = game.users?.get(String(payload.requesterUserId ?? ""));
	const message = game.messages?.get(String(payload.sourceMessageId ?? ""));
	const state = damageState(message);

	if (!requester || !requester.active) {
		throw new Error("The requesting user is not active.");
	}

	if (!message || !state) {
		throw new Error("The source damage message is not available.");
	}

	if (!canUserResolveMessageCritical(message, state, requester)) {
		throw new Error(
			"The requesting user is not allowed to resolve this critical result.",
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

	validatePendingCritical(message, state, transaction, requester);

	const roll = Roll.fromData(payload.roll);
	if (!Number.isInteger(Number(roll?.total))) {
		throw new Error("The submitted critical roll is not evaluated.");
	}

	const resolution = await SuddenDeathResolver.resolve(
		Number(transaction.criticalValue),
		{ roll },
	);
	const updated = await DamageApplication.recordCriticalResolution({
		actor,
		packetId: state.packet?.id ?? transaction.packetId,
		criticalResolution: resolution,
	});

	await mirrorCriticalTransactionToMessage(message, updated);

	return {
		created: true,
		resolution: updated.criticalResolution,
	};
}

async function publishCriticalResult(sourceMessage, resolution, roll) {
	const content = await foundry.applications.handlebars.renderTemplate(
		CRITICAL_RESULT_TEMPLATE_PATH,
		criticalResultTemplateContext(resolution),
	);
	const chatData = await roll.toMessage(
		{
			speaker: foundry.utils.deepClone(sourceMessage.speaker),
			flags: {
				[FLAG_SCOPE]: {
					[CRITICAL_RESULT_FLAG_KEY]: {
						version: 1,
						sourceMessageId: sourceMessage.id,
						packetId: damageState(sourceMessage)?.packet?.id ?? null,
						resolution: foundry.utils.deepClone(resolution),
					},
				},
			},
		},
		{ create: false },
	);

	// toMessage przygotowuje poprawne dane rzutu i tryb widoczności. Podmieniamy
	// wyłącznie treść na kartę WFRP, zachowując Roll w ChatMessage dla DSN.
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

function applyCriticalClientState(message, html) {
	const state = damageState(message);
	const root = asElement(html);

	if (!state || !root) return;

	const host =
		root.querySelector?.(".wfrp1e-test-card, .wfrp1e-damage-card") ??
		(root.matches?.(".wfrp1e-test-card, .wfrp1e-damage-card") ? root : null);

	if (!host) return;

	host.querySelector?.("[data-wfrp-critical-result]")?.remove();

	const transaction = transactionForMessage(message, state);
	if (
		!transaction ||
		Number(transaction.criticalValue) <= 0 ||
		transaction.criticalMode !== DAMAGE_CRITICAL_MODE.SUDDEN_DEATH
	) {
		return;
	}

	host.append(buildCriticalPanel(message, transaction));
}

function buildCriticalPanel(message, transaction) {
	const resolution = transaction.criticalResolution ?? null;
	const panel = document.createElement("section");
	panel.className = "wfrp1e-critical-result";
	panel.dataset.wfrpCriticalResult = "";

	if (resolution?.outcome) {
		panel.classList.add(`is-${resolution.outcome}`);
	}

	const header = document.createElement("div");
	header.className = "wfrp1e-critical-result__header";

	const title = document.createElement("strong");
	title.textContent = suddenDeathHeader(
		resolution?.variant ??
			SuddenDeathResolver.variantForCriticalValue(
				Number(transaction.criticalValue),
			),
	);
	header.append(title);
	panel.append(header);

	if (resolution) {
		const resolved = document.createElement("div");
		resolved.className = "wfrp1e-critical-result__resolved";
		resolved.textContent = localize(
			"WFRP1ED.Critical.ResolvedStatus",
			"✓ Critical resolved",
			"✓ Trafienie krytyczne rozstrzygnięte",
		);
		panel.append(resolved);
		return panel;
	}

	if (canResolveMessageCritical(message)) {
		const action = document.createElement("button");
		action.type = "button";
		action.className = "wfrp1e-critical-result__action";
		action.dataset.wfrpResolveCritical = "";
		action.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${localize(
			"WFRP1ED.Critical.Resolve",
			"Resolve Critical",
			"Rozstrzygnij trafienie krytyczne",
		)}`;
		action.addEventListener("click", () => {
			action.disabled = true;
			void resolveDamageMessageCritical(message).catch((error) => {
				action.disabled = false;
				reportCriticalResolutionError(error);
			});
		});
		panel.append(action);
		return panel;
	}

	const pending = document.createElement("div");
	pending.className = "wfrp1e-critical-result__pending";
	pending.textContent = localize(
		"WFRP1ED.Critical.PendingAuthorized",
		"Awaiting the GM or damage source to resolve the critical.",
		"Oczekuje na rozstrzygnięcie przez MG lub sprawcę obrażeń.",
	);
	panel.append(pending);

	return panel;
}

function criticalResultTemplateContext(resolution) {
	return {
		title: suddenDeathHeader(resolution?.variant),
		rollLabel: localize("WFRP1ED.Critical.Roll", "d100", "K100"),
		rollTotal: resolution?.roll?.total ?? "—",
		outcomeLabel: criticalOutcomeLabel(resolution) ||
			resolution?.results
				?.map((result) => String(result?.text ?? "").trim())
				.filter(Boolean)
				.join(" · ") ||
			localize(
				"WFRP1ED.Critical.CustomResult",
				"Custom table result",
				"Wynik tabeli własnej",
			),
		outcomeClass: resolution?.outcome
			? `is-${resolution.outcome}`
			: "",
	};
}

function suddenDeathHeader(variant) {
	return `${localize(
		"WFRP1ED.Critical.SuddenDeath",
		"Sudden Death",
		"Nagła Śmierć",
	)} +${displayCriticalVariant(variant)}`;
}

function displayCriticalVariant(variant) {
	return String(variant ?? "").replace(/\+$/, "") || "—";
}

function criticalOutcomeLabel(resolution) {
	switch (resolution?.outcome) {
		case "killed":
			return localize(
				"WFRP1ED.Critical.Killed",
				"Killed",
				"Śmierć",
			);

		case "no-effect":
			return localize(
				"WFRP1ED.Critical.NoEffect",
				"No Effect",
				"Bez efektu",
			);

		default:
			return "";
	}
}

async function mirrorActorCriticalTransactions(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const state = damageState(message);
		if (state?.packet?.targetActorUuid !== actor.uuid) continue;

		const transaction = DamageApplication.transactionFor(
			actor,
			state.packet?.id,
		);
		if (!transaction || Number(transaction.criticalValue) <= 0) continue;

		await mirrorCriticalTransactionToMessage(message, transaction);
	}
}

async function mirrorCriticalTransactionToMessage(message, transaction) {
	const state = damageState(message);
	if (!state || !message?.canUserModify?.(game.user, "update")) return;

	if (sameJson(state.application, transaction)) return;

	const updated = foundry.utils.deepClone(state);
	updated.application = foundry.utils.deepClone(transaction);
	updated.updatedBy = game.user?.id ?? "";
	updated.updatedAt = Date.now();

	await message.update({
		[`flags.${FLAG_SCOPE}.${DAMAGE_STATE_FLAG_KEY}`]: updated,
	});

	refreshVisibleCriticalMessage(message);
}

function refreshActorCriticalCards(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	for (const message of game.messages ?? []) {
		const state = damageState(message);
		if (state?.packet?.targetActorUuid !== actor.uuid) continue;
		refreshVisibleCriticalMessage(message);
	}
}

function refreshVisibleCriticalMessage(message) {
	if (!message?.id) return;

	const entry = document.querySelector(
		`[data-message-id="${message.id}"]`,
	);
	if (entry) applyCriticalClientState(message, entry);
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
		`[data-message-id="${message.id}"] [data-wfrp-resolve-critical]`,
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

function sameJson(left, right) {
	try {
		return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
	} catch (_error) {
		return false;
	}
}

function reportCriticalResolutionError(error) {
	console.error(
		"WFRP1ED | Unable to resolve critical from ChatMessage.",
		error,
	);
	ui.notifications.error(
		error?.message ?? localize(
			"WFRP1ED.Critical.ResolveFailedShort",
			"Unable to resolve critical result.",
			"Nie można rozstrzygnąć trafienia krytycznego.",
		),
	);
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);
	if (localized !== key) return localized;
	return game.i18n.lang === "pl" ? polishFallback : englishFallback;
}
