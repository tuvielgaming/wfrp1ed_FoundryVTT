import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "actorTestRequest";
const RESULT_SOURCE_FLAG_KEY = "actorTestRequestSource";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "actor-test-request-action";
const RESPONSE_TYPE = "actor-test-request-response";
const TIMEOUT_MS = 30000;
const pending = new Map();
const active = new Set();
const queued = new Set();
let installed = false;

/** Pending owner/GM Test request used by effects which do not own the target roll. */
export class ActorTestRequestWorkflow {
	static install() {
		if (installed) return;
		installed = true;
		Hooks.on("renderChatMessageHTML", (message, html) => requestAnimationFrame(() => decorate(message, html)));
		Hooks.once("ready", () => game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload)));
	}

	static async create({
		actor,
		testId,
		title,
		description = "",
		source = null,
		testOptions = null,
		speakerActor = null,
	} = {}) {
		if (!(actor instanceof foundry.documents.Actor)) throw new Error("ActorTestRequest requires an Actor.");
		if (speakerActor !== null && !(speakerActor instanceof foundry.documents.Actor)) {
			throw new Error("ActorTestRequest speakerActor must be an Actor when provided.");
		}
		const state = {
			version: 2,
			status: "pending",
			actorUuid: String(actor.uuid),
			actorName: String(actor.name ?? ""),
			testId: String(testId ?? ""),
			title: String(title ?? testId ?? "Test"),
			description: String(description ?? ""),
			source: source ? foundry.utils.deepClone(source) : null,
			testOptions: serializeTestOptions(testOptions),
			resultMessageId: null,
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
		};
		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor: speakerActor ?? actor }),
			content: `<section class="wfrp1ed actor-test-request" data-wfrp-actor-test-request></section>`,
			flags: { [FLAG_SCOPE]: { [FLAG_KEY]: state } },
		});
	}
}

function decorate(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-actor-test-request]") ? root : root?.querySelector?.("[data-wfrp-actor-test-request]");
	if (!(panel instanceof HTMLElement)) return;
	panel.replaceChildren();
	const heading = document.createElement("strong");
	heading.textContent = state.title;
	panel.append(heading);
	if (state.description) {
		const description = document.createElement("div");
		description.textContent = state.description;
		panel.append(description);
	}
	if (state.status === "resolved") {
		const status = document.createElement("div");
		status.className = "combat-damage-context__status is-applied";
		status.textContent = localize("Test resolved.", "Test rozstrzygnięty.");
		panel.append(status);
		return;
	}
	const actor = ActorRollPolicy.actorFromUuidSync(state.actorUuid);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button";
	button.textContent = localize(`Roll ${state.title}`, `Rzuć: ${state.title}`);
	button.disabled = !ActorRollPolicy.canAdjudicate(actor, game.user);
	button.title = button.disabled ? localize("Only the GM or an OWNER of this Actor may roll the Test.", "Tylko MG albo Właściciel tego Aktora może wykonać Test.") : "";
	button.addEventListener("click", () => void requestRoll(message).catch(reportError));
	panel.append(button);
	maybeAuto(message, actor);
}

async function requestRoll(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	const actor = ActorRollPolicy.actorFromUuidSync(state?.actorUuid);
	if (!state || !ActorRollPolicy.canAdjudicate(actor, game.user)) throw new Error(localize("You may not roll this Test.", "Nie masz uprawnień do wykonania tego Testu."));
	if (game.user?.isGM) return resolveAsAuthority(message, game.user);
	const gm = ActorRollPolicy.primaryActiveGM();
	if (!gm || !game.socket) throw new Error(localize("An active GM is required.", "Wymagany jest aktywny MG."));
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error(localize("The GM did not resolve the Test in time.", "MG nie rozstrzygnął Testu w wymaganym czasie.")));
		}, TIMEOUT_MS);
		pending.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, { type: REQUEST_TYPE, requestId, requestUserId: String(game.user?.id ?? ""), messageId: String(message.id ?? "") });
	});
}

async function handleSocket(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const entry = pending.get(String(payload.requestId ?? ""));
		if (!entry) return;
		pending.delete(String(payload.requestId ?? ""));
		clearTimeout(entry.timeout);
		if (payload.ok) entry.resolve(payload.result ?? null);
		else entry.reject(new Error(String(payload.error ?? "Unable to resolve Test.")));
		return;
	}
	if (payload.type !== REQUEST_TYPE || !ActorRollPolicy.isPrimaryActiveGM()) return;
	const requester = game.users?.get(String(payload.requestUserId ?? ""));
	const message = game.messages?.get(String(payload.messageId ?? ""));
	const response = { type: RESPONSE_TYPE, requestId: String(payload.requestId ?? ""), requestUserId: String(payload.requestUserId ?? ""), ok: false, result: null, error: null };
	try {
		if (!requester || !message) throw new Error("Request source is unavailable.");
		response.result = await resolveAsAuthority(message, requester);
		response.ok = true;
	} catch (error) {
		response.error = error?.message ?? "Unable to resolve Test.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function resolveAsAuthority(message, requestingUser) {
	const key = String(message?.id ?? "");
	if (!key || active.has(key)) return null;
	const state = foundry.utils.deepClone(message.getFlag?.(FLAG_SCOPE, FLAG_KEY) ?? {});
	const actor = ActorRollPolicy.actorFromUuidSync(state.actorUuid);
	if (!actor || !ActorRollPolicy.canAdjudicate(actor, requestingUser)) throw new Error("The requesting user does not own this Test.");
	if (state.status === "resolved") return state;
	active.add(key);
	try {
		const options = state.testOptions && typeof state.testOptions === "object"
			? foundry.utils.deepClone(state.testOptions)
			: { modifier: 0 };
		if (!Number.isFinite(Number(options.modifier))) options.modifier = 0;

		const result = await actor.rollTest(state.testId, options);
		if (!result?.chatMessage) throw new Error("The requested Test did not produce a result message.");

		/* Persist request provenance directly on the canonical TestResult before the
		 * request itself is marked resolved. Consumers such as spell-specific result
		 * presentation can therefore identify the result on its very first rerender
		 * without racing a reverse lookup through the request ChatMessage. */
		await result.chatMessage.setFlag(FLAG_SCOPE, RESULT_SOURCE_FLAG_KEY, {
			version: 1,
			requestMessageId: key,
			actorUuid: String(state.actorUuid ?? ""),
			testId: String(state.testId ?? ""),
			source: state.source ? foundry.utils.deepClone(state.source) : null,
			linkedAt: Date.now(),
		});

		state.status = "resolved";
		state.resultMessageId = String(result.chatMessage.id ?? "");
		state.resolvedBy = String(requestingUser?.id ?? "");
		state.resolvedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, FLAG_KEY, state);
		return state;
	} finally {
		active.delete(key);
	}
}

function maybeAuto(message, actor) {
	if (!ActorRollPolicy.shouldAutomaticallyRollMechanicTest(actor, game.user)) return;
	const key = `${message.id}:auto`;
	if (queued.has(key)) return;
	queued.add(key);
	queueMicrotask(() => void resolveAsAuthority(message, game.user).catch(reportError).finally(() => setTimeout(() => queued.delete(key), 250)));
}

function serializeTestOptions(options) {
	const serialized = { modifier: 0 };
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		return serialized;
	}

	if (Number.isFinite(Number(options.modifier))) {
		serialized.modifier = Number(options.modifier);
	}
	if (options.resultVisibility !== undefined) {
		serialized.resultVisibility = String(options.resultVisibility);
	}
	if (Array.isArray(options.modifiers)) {
		serialized.modifiers = options.modifiers
			.map((modifier) => ({
				id: String(modifier?.id ?? ""),
				value: Number(modifier?.value),
				source: String(modifier?.source ?? ""),
				type: String(modifier?.type ?? "modifier"),
				enabled: modifier?.enabled !== false,
			}))
			.filter((modifier) => Number.isFinite(modifier.value));
	}
	return serialized;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to resolve pending Actor Test.", error);
	ui.notifications.error(error?.message ?? localize("Unable to resolve Test.", "Nie udało się rozstrzygnąć Testu."));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

ActorTestRequestWorkflow.install();
