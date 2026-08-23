const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "gmGameplayNotice";
const SETTING_KEY = "persistGmGameplayNotices";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "gm-gameplay-notice-request";
const RESPONSE_TYPE = "gm-gameplay-notice-response";
const TIMEOUT_MS = 8000;

const pending = new Map();
let socketRegistered = false;

/**
 * Persistent, GM-only presentation for gameplay/rule information which may need
 * later adjudication.
 *
 * This is deliberately separate from technical/system errors. Callers opt in
 * only for expected gameplay notices. With the world setting disabled (the
 * default), the notice remains an ordinary temporary Foundry warning. With the
 * setting enabled, the full notice is authored by an active GM and whispered to
 * every GM account; the initiating client receives only a short confirmation.
 * Authoring on the GM client is important because Foundry lets a whisper author
 * see their own message even when they are not one of the listed recipients.
 */
export class GMGameplayNotice {
	static persistenceEnabled() {
		try {
			return game.settings.get(game.system.id, SETTING_KEY) === true;
		} catch (_error) {
			return false;
		}
	}

	/**
	 * Present one expected gameplay/rule notice.
	 *
	 * @param {Object} options
	 * @param {string} options.message Full gameplay/rule explanation.
	 * @param {string} [options.title] Compact notice heading.
	 * @param {string} [options.summary] Short toast used when persisted.
	 * @param {string} [options.category="rules"] Stable notice category.
	 * @param {Actor|null} [options.actor=null]
	 * @param {Item|null} [options.item=null]
	 * @returns {Promise<ChatMessage|null>}
	 */
	static async warn(options = {}) {
		const notice = normalizeNotice(options);

		if (!this.persistenceEnabled()) {
			ui.notifications.warn(notice.message);
			return null;
		}

		if (game.user?.isGM) {
			try {
				const chatMessage = await persistNotice(notice);
				ui.notifications.warn(notice.summary);
				return chatMessage;
			} catch (error) {
				reportPersistenceFailure(error, notice.message);
				return null;
			}
		}

		const gm = primaryActiveGM();
		if (!gm) {
			/* Without an active GM there is nobody who can safely author a message
			 * that is truly GM-only. Keep the gameplay explanation visible locally. */
			ui.notifications.warn(notice.message);
			return null;
		}

		try {
			await requestPersistence(notice);
			ui.notifications.warn(notice.summary);
			return null;
		} catch (error) {
			reportPersistenceFailure(error, notice.message);
			return null;
		}
	}
}

/*
 * Foundry v14 lifecycle contract:
 *   init -> i18nInit -> setup -> ready
 *
 * Localized setting labels must not be resolved during init. The official
 * i18nInit hook fires after translations have been loaded and before setup, so
 * the setting is registered early enough for normal Settings initialization but
 * only after the active language is authoritative.
 */
Hooks.once("i18nInit", () => {
	game.settings.register(game.system.id, SETTING_KEY, {
		name: localize(
			"Save GM gameplay notices in chat",
			"Zachowuj komunikaty dla MG w czacie",
		),
		hint: localize(
			"Optional, disabled by default. Important gameplay/rule information which may require GM adjudication is saved as a private chat message visible to all GM users. Technical/system errors and ordinary UI feedback keep the normal Foundry notification lifecycle.",
			"Opcjonalne, domyślnie wyłączone. Ważne informacje dotyczące zasad lub rozstrzygnięć są zapisywane jako prywatne wiadomości czatu widoczne dla wszystkich użytkowników MG. Błędy techniczne/systemowe i zwykłe komunikaty interfejsu zachowują standardowy cykl powiadomień Foundry.",
		),
		scope: "world",
		config: true,
		type: Boolean,
		default: false,
	});
});

Hooks.once("ready", () => registerSocket());

function normalizeNotice({
	message,
	title = "",
	summary = "",
	category = "rules",
	actor = null,
	item = null,
} = {}) {
	const fullMessage = String(message ?? "").trim();
	if (!fullMessage) {
		throw new Error("GMGameplayNotice requires a non-empty message.");
	}

	const heading = String(title ?? "").trim() || localize(
		"GM gameplay notice",
		"Komunikat dla MG",
	);
	const short = String(summary ?? "").trim() || localize(
		`${heading} — details saved in private GM chat.`,
		`${heading} — szczegóły zapisano w prywatnym czacie MG.`,
	);

	return Object.freeze({
		message: fullMessage,
		title: heading,
		summary: short,
		category: String(category ?? "rules"),
		actorUuid: String(actor?.uuid ?? ""),
		actorName: String(actor?.name ?? "").trim(),
		itemUuid: String(item?.uuid ?? ""),
		itemName: String(item?.name ?? "").trim(),
		createdBy: String(game.user?.id ?? ""),
		createdAt: Date.now(),
	});
}

async function persistNotice(notice) {
	if (!game.user?.isGM) {
		throw new Error("Persistent GM gameplay notices must be authored by a GM.");
	}

	const recipients = gmRecipientIds();
	if (!recipients.length) {
		throw new Error("No GM recipients are available for the gameplay notice.");
	}

	const content = noticeContent(notice);
	return ChatMessage.create({
		speaker: { alias: "WFRP 1e" },
		content,
		whisper: recipients,
		flags: {
			[FLAG_SCOPE]: {
				[FLAG_KEY]: {
					version: 1,
					category: notice.category,
					title: notice.title,
					actorUuid: notice.actorUuid,
					itemUuid: notice.itemUuid,
					createdBy: notice.createdBy,
					createdAt: notice.createdAt,
				},
			},
		},
	});
}

function requestPersistence(notice) {
	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error("GM gameplay notice request timed out."));
		}, TIMEOUT_MS);
		pending.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			notice,
		});
	});
}

function registerSocket() {
	if (socketRegistered) return;
	socketRegistered = true;

	game.socket.on(SOCKET_CHANNEL, async (message) => {
		if (!message || typeof message !== "object") return;

		if (message.type === RESPONSE_TYPE) {
			if (String(message.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
			const entry = pending.get(String(message.requestId ?? ""));
			if (!entry) return;
			pending.delete(String(message.requestId ?? ""));
			clearTimeout(entry.timeout);
			if (message.error) entry.reject(new Error(String(message.error)));
			else entry.resolve(message.result ?? null);
			return;
		}

		if (message.type !== REQUEST_TYPE) return;
		if (!game.user?.isGM || primaryActiveGM()?.id !== game.user.id) return;

		const response = {
			type: RESPONSE_TYPE,
			requestId: String(message.requestId ?? ""),
			requestUserId: String(message.requestUserId ?? ""),
		};

		try {
			const requestingUser = game.users?.get(String(message.requestUserId ?? ""));
			if (!requestingUser?.active) {
				throw new Error("The user requesting the GM gameplay notice is not active.");
			}
			const notice = normalizeSocketNotice(message.notice, requestingUser.id);
			const chatMessage = await persistNotice(notice);
			ui.notifications.warn(notice.summary);
			response.result = { messageId: String(chatMessage?.id ?? "") };
		} catch (error) {
			console.error("WFRP1ED | Unable to persist requested GM gameplay notice.", error);
			response.error = error?.message ?? String(error);
		}

		game.socket.emit(SOCKET_CHANNEL, response);
	});
}

function normalizeSocketNotice(value, requestingUserId) {
	const source = value && typeof value === "object" ? value : {};
	const message = String(source.message ?? "").trim();
	if (!message) throw new Error("Requested GM gameplay notice has no message.");
	return Object.freeze({
		message,
		title: String(source.title ?? "").trim() || localize(
			"GM gameplay notice",
			"Komunikat dla MG",
		),
		summary: String(source.summary ?? "").trim() || localize(
			"Gameplay notice saved in private GM chat.",
			"Komunikat rozgrywki zapisano w prywatnym czacie MG.",
		),
		category: String(source.category ?? "rules"),
		actorUuid: String(source.actorUuid ?? ""),
		actorName: String(source.actorName ?? "").trim(),
		itemUuid: String(source.itemUuid ?? ""),
		itemName: String(source.itemName ?? "").trim(),
		createdBy: String(requestingUserId ?? ""),
		createdAt: Number(source.createdAt) || Date.now(),
	});
}

function gmRecipientIds() {
	return [...(game.users ?? [])]
		.filter((user) => user?.isGM)
		.map((user) => String(user.id ?? ""))
		.filter(Boolean);
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function noticeContent(notice) {
	const root = document.createElement("section");
	root.className = "wfrp1e-gm-gameplay-notice";
	root.dataset.wfrpGmGameplayNotice = "";

	const header = document.createElement("header");
	header.className = "wfrp1e-gm-gameplay-notice__header";
	const heading = document.createElement("strong");
	heading.className = "wfrp1e-gm-gameplay-notice__title";
	const icon = document.createElement("i");
	icon.className = "fa-solid fa-scale-balanced";
	icon.setAttribute("aria-hidden", "true");
	const text = document.createElement("span");
	text.textContent = notice.title;
	heading.append(icon, text);

	const badge = document.createElement("span");
	badge.className = "wfrp1e-gm-gameplay-notice__badge";
	badge.textContent = "MG";
	header.append(heading, badge);
	root.append(header);

	const context = [notice.actorName, notice.itemName].filter(Boolean).join(" — ");
	if (context) {
		const contextRow = document.createElement("div");
		contextRow.className = "wfrp1e-gm-gameplay-notice__context";
		contextRow.textContent = context;
		root.append(contextRow);
	}

	const body = document.createElement("div");
	body.className = "wfrp1e-gm-gameplay-notice__body";
	body.textContent = notice.message;
	root.append(body);

	const footer = document.createElement("footer");
	footer.className = "wfrp1e-gm-gameplay-notice__footer";
	footer.textContent = localize(
		"Private gameplay notice — GM only",
		"Prywatny komunikat rozgrywki — tylko MG",
	);
	root.append(footer);

	return root.outerHTML;
}

function reportPersistenceFailure(error, fallbackMessage) {
	console.error("WFRP1ED | Unable to persist GM gameplay notice.", error);
	ui.notifications.error(localize(
		"The GM gameplay notice could not be saved to chat. Showing it as a temporary notification instead.",
		"Nie udało się zapisać komunikatu dla MG w czacie. Zostanie pokazany jako zwykłe tymczasowe powiadomienie.",
	));
	ui.notifications.warn(fallbackMessage);
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
		? polish
		: english;
}
