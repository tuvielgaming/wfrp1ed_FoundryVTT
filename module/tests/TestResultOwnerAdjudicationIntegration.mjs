import { TestResultChat } from "./TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "testResultState";
const SOCKET_CHANNEL = "system.wfrp1ed";
const SOCKET_REQUEST_TYPE = "test-result-owner-adjudication-request";

Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => activateOwnerAdjudication(message, html));
});

Hooks.once("ready", () => {
	game.socket?.on?.(SOCKET_CHANNEL, (payload) => {
		if (payload?.type !== SOCKET_REQUEST_TYPE) return;
		if (!isPrimaryActiveGm(game.user)) return;
		void handleOwnerRequest(payload);
	});
});

function activateOwnerAdjudication(message, html) {
	if (game.user?.isGM) return;
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state) return;

	const actor = actorForMessage(message);
	if (!actor || !hasOwnerPermission(actor, game.user)) return;

	const root = asElement(html);
	const card = root?.matches?.(".wfrp1e-test-card")
		? root
		: root?.querySelector?.(".wfrp1e-test-card");
	const input = card?.querySelector?.("[data-wfrp-test-general-modifier]");
	if (!(input instanceof HTMLInputElement)) return;
	if (input.dataset.wfrpOwnerAdjudication === "true") return;

	input.dataset.wfrpOwnerAdjudication = "true";
	input.readOnly = false;
	input.tabIndex = 0;
	input.classList.remove("is-readonly");
	input.classList.add("is-editable");
	input.title = localize(
		"Actor owner or GM: edit the modifier, then press Enter or leave the field.",
		"Właściciel Aktora lub MG: zmień modyfikator, a następnie naciśnij Enter lub opuść pole.",
	);

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		input.blur();
	});

	input.addEventListener("change", () => {
		void requestOwnerAdjudication(message, actor, input);
	});
}

async function requestOwnerAdjudication(message, actor, input) {
	try {
		const raw = String(input?.value ?? "").trim();
		const value = Number(raw);
		if (!raw || !Number.isFinite(value)) {
			throw new Error(localize(
				"Enter a finite test modifier.",
				"Wprowadź prawidłowy modyfikator testu.",
			));
		}
		if (!hasOwnerPermission(actor, game.user)) {
			throw new Error(localize(
				"Only the GM or an OWNER of this Actor may adjudicate the roll.",
				"Tylko MG albo Właściciel tego Aktora może rozstrzygać ten rzut.",
			));
		}

		if (message.isOwner) {
			await applyModifier(message, value);
			return;
		}

		const gm = primaryActiveGm();
		if (!gm) {
			throw new Error(localize(
				"A GM must be online to update a Test message owned by another user.",
				"MG musi być online, aby zaktualizować wynik Testu należący do innego użytkownika.",
			));
		}

		game.socket.emit(SOCKET_CHANNEL, {
			type: SOCKET_REQUEST_TYPE,
			messageId: String(message.id ?? ""),
			requestingUserId: String(game.user?.id ?? ""),
			value,
		});
	} catch (error) {
		reportError(error);
	}
}

async function handleOwnerRequest(payload) {
	try {
		const message = game.messages?.get(String(payload?.messageId ?? ""));
		if (!message) throw new Error("The requested Test message no longer exists.");

		const actor = actorForMessage(message);
		const user = game.users?.get(String(payload?.requestingUserId ?? ""));
		if (!actor || !user || !hasOwnerPermission(actor, user)) {
			throw new Error("The requesting user is not an OWNER of the Test Actor.");
		}

		const value = Number(payload?.value);
		if (!Number.isFinite(value)) throw new Error("Invalid Test adjudication value.");
		await applyModifier(message, value);
	} catch (error) {
		reportError(error);
	}
}

async function applyModifier(message, value) {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state) throw new Error("This ChatMessage has no editable Test snapshot.");

	const updated = TestResultChat._copyState(state);
	updated.generalModifier.value = Number(value);
	updated.updatedBy = String(game.user?.id ?? "");
	updated.updatedAt = Date.now();
	const content = await TestResultChat._render(updated);
	await message.update({
		content,
		[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
	});
}

function actorForMessage(message) {
	const speaker = message?.speaker ?? {};
	if (speaker.scene && speaker.token) {
		const scene = game.scenes?.get(String(speaker.scene));
		const token = scene?.tokens?.get(String(speaker.token));
		if (token?.actor) return token.actor;
	}
	return speaker.actor ? game.actors?.get(String(speaker.actor)) ?? null : null;
}

function hasOwnerPermission(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	try {
		return actor.testUserPermission?.(user, "OWNER") === true;
	} catch (_error) {
		return false;
	}
}

function primaryActiveGm() {
	return [...(game.users?.contents ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm(user) {
	const gm = primaryActiveGm();
	return Boolean(gm && user?.id === gm.id);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to adjudicate owner Test result.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to adjudicate this Test result.",
		"Nie udało się rozstrzygnąć tego wyniku Testu.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
