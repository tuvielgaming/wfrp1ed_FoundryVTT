import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "pendingStandardTest";
let activePick = null;
let hoveredToken = null;

Hooks.on("renderChatMessageHTML", (message, html) => {
	const rendered = asElement(html);
	requestAnimationFrame(() => decoratePendingCard(message, rendered));
});

Hooks.on("hoverToken", (token, hovered) => {
	if (!activePick) return;
	if (hovered === true) {
		hoveredToken = token;
		return;
	}
	if (hoveredToken === token) hoveredToken = null;
});

Hooks.once("ready", () => {
	document.addEventListener("keydown", onGlobalKeydown, true);
	document.addEventListener("pointerdown", onGlobalPointerDown, true);
});

function decoratePendingCard(message, rendered) {
	const card = rendered?.matches?.("[data-wfrp-pending-standard-test]")
		? rendered
		: rendered?.querySelector?.("[data-wfrp-pending-standard-test]");
	if (!card || !message?.id) return;
	const request = message.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (request?.status !== "pending") return;

	card.dataset.wfrpPendingStandardMessageId = String(message.id);
	const controls = card.querySelector("[data-pending-standard-controls]");
	if (!(controls instanceof HTMLElement)) return;

	let button = controls.querySelector("[data-wfrp-pending-standard-pick-scene]");
	if (!(button instanceof HTMLButtonElement)) {
		button = document.createElement("button");
		button.type = "button";
		button.dataset.wfrpPendingStandardPickScene = "";
		const icon = document.createElement("i");
		icon.className = "fa-solid fa-crosshairs";
		icon.setAttribute("aria-hidden", "true");
		const label = document.createElement("span");
		label.dataset.wfrpPendingStandardPickSceneLabel = "";
		button.append(icon, label);

		const targetLabel = controls.querySelector(".pending-standard-test-scene-target");
		if (targetLabel) targetLabel.insertAdjacentElement("afterend", button);
		else controls.prepend(button);

		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			button.blur();
			if (!canResolve(message)) return;
			if (activePick?.messageId === String(message.id)) {
				disarm();
				return;
			}
			arm(message, card, button);
		}, true);
	}

	if (activePick?.messageId === String(message.id)) {
		activePick.card = card;
		activePick.button = button;
		setVisual(card, button, true);
	} else {
		setVisual(card, button, false);
	}
}

function arm(message, card, button) {
	disarm();
	hoveredToken = null;
	activePick = {
		messageId: String(message.id),
		card,
		button,
	};
	document.body?.classList.add("wfrp1ed-pending-scene-pick-active");
	setVisual(card, button, true);
}

function disarm() {
	if (activePick) setVisual(activePick.card, activePick.button, false);
	activePick = null;
	hoveredToken = null;
	document.body?.classList.remove("wfrp1ed-pending-scene-pick-active");
}

function setVisual(card, button, armed) {
	if (card instanceof HTMLElement) card.classList.toggle("is-picking-scene-target", armed);
	if (!(button instanceof HTMLButtonElement)) return;
	button.classList.toggle("is-active", armed);
	button.setAttribute("aria-pressed", String(armed));
	button.title = armed
		? localize(
			"Click a token on the scene to use it as this Standard Test's target. Press Esc or click this button again to cancel.",
			"Kliknij token na mapie, aby ustawić go jako cel tego Testu standardowego. Naciśnij Esc albo kliknij ten przycisk ponownie, aby anulować.",
		)
		: localize(
			"Pick this pending Standard Test's target directly from the scene.",
			"Wskaż cel tego oczekującego Testu standardowego bezpośrednio na mapie.",
		);
	const label = button.querySelector("[data-wfrp-pending-standard-pick-scene-label]");
	if (label) {
		label.textContent = armed
			? localize("Click token on scene…", "Kliknij token na mapie…")
			: localize("Pick on scene", "Wskaż na mapie");
	}
}

function onGlobalPointerDown(event) {
	if (!activePick || event.button !== 0 || !hoveredToken) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	void applyHoveredToken();
}

async function applyHoveredToken() {
	if (!activePick) return;
	const messageId = String(activePick.messageId ?? "");
	const message = game.messages?.get(messageId);
	if (!message || !canResolve(message)) {
		disarm();
		return;
	}
	const actor = hoveredToken?.actor;
	if (actor?.documentName !== "Actor" || !actor.uuid) return;

	let card = activePick.card;
	if (!(card instanceof HTMLElement) || !card.isConnected) {
		card = [...document.querySelectorAll("[data-wfrp-pending-standard-message-id]")]
			.find((entry) => String(entry.dataset.wfrpPendingStandardMessageId ?? "") === messageId) ?? null;
	}
	const select = card?.querySelector?.("[data-pending-standard-scene-target]");
	if (!(select instanceof HTMLSelectElement)) {
		disarm();
		return;
	}

	const uuid = String(actor.uuid);
	let option = [...select.options].find((entry) => entry.value === uuid);
	if (!option) {
		option = document.createElement("option");
		option.value = uuid;
		select.append(option);
	}
	option.textContent = String(hoveredToken?.name ?? actor.name ?? "—");
	select.value = uuid;
	disarm();
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function onGlobalKeydown(event) {
	if (!activePick || event.key !== "Escape") return;
	event.preventDefault();
	event.stopImmediatePropagation();
	disarm();
}

function canResolve(message) {
	const request = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (request?.status !== "pending") return false;
	const actor = ActorTargetResolver.actorFromUuidSync(request.actorUuid);
	if (!actor || !game.user) return false;
	if (game.user.isGM) return true;
	return actor.testUserPermission?.(
		game.user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl") ? polish : english;
}
