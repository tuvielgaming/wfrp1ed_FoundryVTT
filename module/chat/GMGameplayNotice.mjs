const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "gmGameplayNotice";
const SETTING_KEY = "persistGmGameplayNotices";

/**
 * Persistent, GM-only presentation for gameplay/rule information which may need
 * later adjudication.
 *
 * This is deliberately separate from technical/system errors. Callers opt in
 * only for expected gameplay notices. With the world setting disabled (the
 * default), the notice remains an ordinary temporary Foundry warning. With the
 * setting enabled, the full notice is whispered to every GM and a short toast
 * confirms that the details were saved in private GM chat.
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
	static async warn({
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

		if (!this.persistenceEnabled()) {
			ui.notifications.warn(fullMessage);
			return null;
		}

		const recipients = gmRecipientIds();
		if (!recipients.length) {
			/* A world should normally always have a GM account. Never lose the
			 * gameplay information if that assumption is violated. */
			ui.notifications.warn(fullMessage);
			return null;
		}

		try {
			const content = noticeContent({
				title: heading,
				message: fullMessage,
				actor,
				item,
			});
			const chatMessage = await ChatMessage.create({
				content,
				whisper: recipients,
				flags: {
					[FLAG_SCOPE]: {
						[FLAG_KEY]: {
							version: 1,
							category: String(category ?? "rules"),
							title: heading,
							actorUuid: String(actor?.uuid ?? ""),
							itemUuid: String(item?.uuid ?? ""),
							createdBy: String(game.user?.id ?? ""),
							createdAt: Date.now(),
						},
					},
				},
			});

			ui.notifications.warn(
				String(summary ?? "").trim() || localize(
					`${heading} — details saved in private GM chat.`,
					`${heading} — szczegóły zapisano w prywatnym czacie MG.`,
				),
			);
			return chatMessage;
		} catch (error) {
			/* Persistence itself is infrastructure. Report that failure as a real
			 * system error, but still show the original gameplay information. */
			console.error("WFRP1ED | Unable to persist GM gameplay notice.", error);
			ui.notifications.error(localize(
				"The GM gameplay notice could not be saved to chat. Showing it as a temporary notification instead.",
				"Nie udało się zapisać komunikatu dla MG w czacie. Zostanie pokazany jako zwykłe tymczasowe powiadomienie.",
			));
			ui.notifications.warn(fullMessage);
			return null;
		}
	}
}

Hooks.once("init", () => {
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

function gmRecipientIds() {
	return [...(game.users ?? [])]
		.filter((user) => user?.isGM)
		.map((user) => String(user.id ?? ""))
		.filter(Boolean);
}

function noticeContent({ title, message, actor, item }) {
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
	text.textContent = title;
	heading.append(icon, text);

	const badge = document.createElement("span");
	badge.className = "wfrp1e-gm-gameplay-notice__badge";
	badge.textContent = "MG";
	header.append(heading, badge);
	root.append(header);

	const context = [
		String(actor?.name ?? "").trim(),
		String(item?.name ?? "").trim(),
	].filter(Boolean).join(" — ");
	if (context) {
		const contextRow = document.createElement("div");
		contextRow.className = "wfrp1e-gm-gameplay-notice__context";
		contextRow.textContent = context;
		root.append(contextRow);
	}

	const body = document.createElement("div");
	body.className = "wfrp1e-gm-gameplay-notice__body";
	body.textContent = message;
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

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
