import { ExperienceTransactionService } from "./ExperienceTransactionService.mjs";
import { refreshVisibleChatMessage } from "../chat/ChatMessagePresentationRefresh.mjs";

const FLAG_SCOPE = "wfrp1ed";
const LEDGER_FLAG = "experienceLedger";
const MESSAGE_FLAG_KEY = "experienceAward";
const SOCKET_CHANNEL = "system.wfrp1ed";
const CLAIM_REQUEST = "experience-award-claim-request";
const CLAIM_RESPONSE = "experience-award-claim-response";
const messageQueues = new Map();

Hooks.on("renderApplicationV2", (application, element) => {
	if (!game.user?.isGM) return;
	if (application?.constructor?.name !== "ExperienceLogWindow") return;
	const toolbar = element?.querySelector?.(".experience-log__toolbar");
	if (!(toolbar instanceof HTMLElement) || toolbar.querySelector("[data-wfrp-create-xp-award]")) return;

	const button = document.createElement("button");
	button.type = "button";
	button.dataset.wfrpCreateXpAward = "true";
	button.innerHTML = `<i class="fas fa-gift" aria-hidden="true"></i><span>${localize("Award XP in chat", "Przyznaj PD przez czat")}</span>`;
	button.addEventListener("click", () => void createAwardFromDialog().catch(reportError));
	toolbar.append(button);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, MESSAGE_FLAG_KEY)) return;
	renderAwardCard(message, html);
});

Hooks.on("updateChatMessage", (message, changes) => {
	const path = `flags.${FLAG_SCOPE}.${MESSAGE_FLAG_KEY}`;
	if (
		foundry.utils.getProperty(changes ?? {}, path) === undefined &&
		!Object.hasOwn(changes ?? {}, path) &&
		!Object.keys(changes ?? {}).some((key) => key.startsWith(`${path}.`))
	) return;
	void refreshVisibleChatMessage(message);
});

Hooks.once("ready", () => {
	game.socket?.on?.(SOCKET_CHANNEL, (payload) => {
		if (payload?.type === CLAIM_REQUEST && isPrimaryActiveGm()) {
			queueClaim(payload);
			return;
		}
		if (payload?.type === CLAIM_RESPONSE && String(payload.requestUserId ?? "") === String(game.user?.id ?? "")) {
			if (payload.ok) {
				ui.notifications.info(localize("Experience claimed.", "Odebrano Punkty Doświadczenia."));
			} else {
				ui.notifications.warn(payload.error || localize("Unable to claim Experience.", "Nie udało się odebrać Punktów Doświadczenia."));
			}
		}
	});
});

async function createAwardFromDialog() {
	if (!game.user?.isGM) return;
	const actors = [...(game.actors ?? [])]
		.filter((actor) => actor?.type === "character" && actor.hasPlayerOwner)
		.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang));
	if (!actors.length) throw new Error(localize("No player-owned characters are available.", "Brak postaci należących do graczy."));

	const rows = actors.map((actor) => `
		<label style="display:flex;gap:6px;align-items:center">
			<input type="checkbox" name="actorUuid" value="${escapeHtml(actor.uuid)}">
			<span>${escapeHtml(actor.name)}</span>
		</label>`).join("");
	const content = `
		<div class="wfrp1ed experience-award-dialog">
			<label>${escapeHtml(localize("Experience", "Punkty Doświadczenia"))}
				<input type="number" name="amount" min="1" step="1" value="100" required>
			</label>
			<label>${escapeHtml(localize("Reason", "Powód"))}
				<input type="text" name="reason" autocomplete="off" required>
			</label>
			<fieldset><legend>${escapeHtml(localize("Entitled characters", "Uprawnione postacie"))}</legend>${rows}</fieldset>
		</div>`;

	const result = await foundry.applications.api.DialogV2.wait({
		window: { title: localize("Create Experience award", "Utwórz nagrodę PD") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "create",
			label: localize("Post to chat", "Wyślij na czat"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				return {
					amount: Math.max(0, Math.trunc(Number(data.get("amount")) || 0)),
					reason: String(data.get("reason") ?? "").trim(),
					actorUuids: data.getAll("actorUuid").map(String),
				};
			},
		}],
	});
	if (!result) return;
	if (result.amount < 1) throw new Error(localize("Experience award must be at least 1.", "Nagroda PD musi wynosić co najmniej 1."));
	if (!result.reason) throw new Error(localize("A reason for the Experience award is required.", "Powód przyznania Punktów Doświadczenia jest wymagany."));
	if (!result.actorUuids.length) throw new Error(localize("Select at least one entitled character.", "Wybierz co najmniej jedną uprawnioną postać."));

	const recipients = result.actorUuids.map((uuid) => {
		const actor = foundry.utils.fromUuidSync(uuid);
		if (!(actor instanceof foundry.documents.Actor) || actor.type !== "character") return null;
		return { actorUuid: actor.uuid, actorId: actor.id, name: actor.name, claimedAt: null, claimedBy: "" };
	}).filter(Boolean);
	if (!recipients.length) throw new Error(localize("No valid recipient characters were selected.", "Nie wybrano prawidłowych postaci odbiorców."));

	const awardId = foundry.utils.randomID();
	await foundry.documents.ChatMessage.create({
		user: game.user.id,
		content: '<div class="wfrp1ed-xp-award-card" data-wfrp-xp-award-card></div>',
		flags: {
			[FLAG_SCOPE]: {
				[MESSAGE_FLAG_KEY]: {
					version: 1,
					awardId,
					amount: result.amount,
					reason: result.reason,
					createdBy: String(game.user.id),
					createdAt: Date.now(),
					recipients,
				},
			},
		},
	});
}

function renderAwardCard(message, html) {
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-xp-award-card]") ? root : root?.querySelector?.("[data-wfrp-xp-award-card]");
	if (!card) return;
	const state = message.getFlag(FLAG_SCOPE, MESSAGE_FLAG_KEY);
	if (!state) return;
	const doc = card.ownerDocument ?? document;
	card.replaceChildren();

	const title = doc.createElement("strong");
	title.textContent = localize(`Experience Award: +${state.amount} XP`, `Nagroda PD: +${state.amount}`);
	const reason = doc.createElement("div");
	reason.textContent = String(state.reason ?? "");
	card.append(title, reason);

	for (const recipient of state.recipients ?? []) {
		const row = doc.createElement("div");
		row.style.display = "flex";
		row.style.justifyContent = "space-between";
		row.style.gap = "8px";
		row.style.alignItems = "center";
		row.style.marginTop = "6px";
		const name = doc.createElement("span");
		name.textContent = String(recipient.name ?? "");
		row.append(name);
		if (recipient.claimedAt) {
			const status = doc.createElement("strong");
			status.textContent = localize("Claimed", "Odebrano");
			row.append(status);
		} else {
			const actor = actorFromRecipient(recipient);
			if (actor && canClaimActor(actor, game.user)) {
				const button = doc.createElement("button");
				button.type = "button";
				button.textContent = localize("Claim", "Odbierz");
				button.addEventListener("click", () => {
					button.disabled = true;
					button.textContent = localize("Claiming…", "Odbieranie…");
					requestClaim(message, recipient);
				});
				row.append(button);
			}
		}
		card.append(row);
	}
}

function requestClaim(message, recipient) {
	const payload = {
		type: CLAIM_REQUEST,
		requestId: foundry.utils.randomID(),
		requestUserId: String(game.user?.id ?? ""),
		messageId: String(message.id ?? ""),
		actorUuid: String(recipient.actorUuid ?? ""),
	};
	if (isPrimaryActiveGm()) {
		queueClaim(payload);
	} else {
		game.socket?.emit?.(SOCKET_CHANNEL, payload);
	}
}

function queueClaim(payload) {
	const key = String(payload.messageId ?? "");
	const previous = messageQueues.get(key) ?? Promise.resolve();
	const next = previous.then(() => processClaim(payload)).catch((error) => sendResponse(payload, false, error?.message ?? String(error)));
	messageQueues.set(key, next.finally(() => {
		if (messageQueues.get(key) === next) messageQueues.delete(key);
	}));
}

async function processClaim(payload) {
	const message = game.messages?.get(String(payload.messageId ?? ""));
	if (!message) throw new Error(localize("Experience award message no longer exists.", "Wiadomość z nagrodą PD już nie istnieje."));
	const state = foundry.utils.deepClone(message.getFlag(FLAG_SCOPE, MESSAGE_FLAG_KEY));
	const recipient = state?.recipients?.find((entry) => String(entry.actorUuid ?? "") === String(payload.actorUuid ?? ""));
	if (!recipient) throw new Error(localize("This character is not entitled to this award.", "Ta postać nie jest uprawniona do tej nagrody."));
	if (recipient.claimedAt) throw new Error(localize("This character has already claimed this award.", "Ta postać już odebrała tę nagrodę."));
	const actor = actorFromRecipient(recipient);
	const user = game.users?.get(String(payload.requestUserId ?? ""));
	if (!actor || !user || !canClaimActor(actor, user)) throw new Error(localize("You do not control this character.", "Nie kontrolujesz tej postaci."));

	await grantAwardOnce(actor, state);
	const latest = foundry.utils.deepClone(message.getFlag(FLAG_SCOPE, MESSAGE_FLAG_KEY));
	const target = latest?.recipients?.find((entry) => String(entry.actorUuid ?? "") === String(payload.actorUuid ?? ""));
	if (target && !target.claimedAt) {
		target.claimedAt = Date.now();
		target.claimedBy = String(user.id ?? "");
		await message.update({ [`flags.${FLAG_SCOPE}.${MESSAGE_FLAG_KEY}`]: latest });
	}
	await refreshVisibleChatMessage(message);
	sendResponse(payload, true, "");
}

async function grantAwardOnce(actor, state) {
	const awardId = String(state.awardId ?? "");
	const ledger = ExperienceTransactionService.ledger(actor);
	const existing = ledger.find((entry) => (entry.events ?? []).some((event) => String(event?.sourceAwardId ?? "") === awardId));
	if (existing) return existing;

	const amount = Math.max(1, Math.trunc(Number(state.amount) || 0));
	const reason = String(state.reason ?? "").trim();
	if (!reason) throw new Error(localize("Experience award has no reason.", "Nagroda PD nie ma podanego powodu."));
	const now = Date.now();
	const event = {
		id: foundry.utils.randomID(),
		kind: "experience-adjustment",
		state: "committed",
		amount,
		description: reason,
		source: "chat-award",
		sourceAwardId: awardId,
		sourceMessageId: String(state.messageId ?? ""),
		createdAt: now,
		userId: String(game.user?.id ?? ""),
	};
	const entry = {
		id: foundry.utils.randomID(),
		kind: "manual-experience",
		createdAt: now,
		committedAt: now,
		userId: String(game.user?.id ?? ""),
		events: [event],
	};
	ledger.push(entry);
	const total = Math.max(0, Math.trunc(Number(actor.system?.experience?.totalAwarded) || 0));
	await actor.update({
		"system.experience.totalAwarded": total + amount,
		[`flags.${FLAG_SCOPE}.${LEDGER_FLAG}`]: ledger,
	});
	return entry;
}

function sendResponse(payload, ok, error) {
	game.socket?.emit?.(SOCKET_CHANNEL, {
		type: CLAIM_RESPONSE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok,
		error: error || null,
	});
}

function actorFromRecipient(recipient) {
	return game.actors?.get(String(recipient.actorId ?? "")) ?? foundry.utils.fromUuidSync(String(recipient.actorUuid ?? ""));
}

function canClaimActor(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) === true;
}

function isPrimaryActiveGm() {
	const primary = [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
	return Boolean(game.user?.isGM && primary?.id === game.user.id);
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1) return value[0];
	return null;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function reportError(error) {
	console.error("WFRP1ED | Experience award failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
