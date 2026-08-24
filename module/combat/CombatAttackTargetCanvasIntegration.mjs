import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PENDING_FLAG_KEYS = Object.freeze([
	"pendingCombatAttack",
	"pendingRangedCombatAttack",
]);
const TARGET_SELECTION_PENDING = "__pending__";
const ATTACK_DIALOG_CLASS = "wfrp1ed-combat-attack-dialog";

let activePendingPick = null;
let hoveredPendingPickToken = null;

install();

/**
 * Target-selection presentation for attack dialogs and pending attack cards.
 *
 * Pre-roll attack dialogs intentionally follow Foundry's normal Target Token
 * state. They are non-modal and mirror the current user's single target through
 * the targetToken hook.
 *
 * Pending ChatMessage cards are different: their selected defender is shared
 * adjudication state, while Foundry target markers are private per-user state.
 * They therefore do NOT follow game.user.targets. Instead a card can enter an
 * explicit "pick on scene" mode. While armed, hovering a visible Token and
 * left-clicking the canvas copies that Token into the specific pending card.
 * This works for GM and Actor owners even when they cannot control the target
 * Token, and it does not change the user's Foundry Target Token state.
 * The existing dropdown / clear / GM Actor picker / GM drag-drop paths remain
 * authoritative alternatives.
 */
function install() {
	const DialogV2 = foundry.applications?.api?.DialogV2;
	if (!DialogV2 || DialogV2.__wfrpAttackCanvasTargetingInstalled === true) return;

	const originalWait = DialogV2.wait;
	DialogV2.wait = function wfrpAttackCanvasTargetingWait(config = {}, ...args) {
		if (!isAttackDialogConfig(config)) {
			return originalWait.call(this, config, ...args);
		}

		const originalRender = config.render;
		const originalClose = config.close;
		let cleanupTargetHook = null;

		const cleanup = () => {
			if (typeof cleanupTargetHook === "function") cleanupTargetHook();
			cleanupTargetHook = null;
		};

		const promise = originalWait.call(this, {
			...config,
			modal: false,
			render: (...renderArgs) => {
				const result = typeof originalRender === "function"
					? originalRender(...renderArgs)
					: undefined;
				cleanup();
				cleanupTargetHook = activateTargetSync(renderArgs[1]?.element);
				return result;
			},
			close: (...closeArgs) => {
				cleanup();
				return typeof originalClose === "function"
					? originalClose(...closeArgs)
					: undefined;
			},
		}, ...args);

		return Promise.resolve(promise).finally(cleanup);
	};

	Hooks.on("renderChatMessageHTML", (message, html) => {
		const rendered = asElement(html);
		requestAnimationFrame(() => decoratePendingTargetCard(message, rendered));
	});

	/* `controlToken` only fires when a user can actually control the clicked
	 * Token. Players commonly cannot control hostile targets, so pending target
	 * picking is instead based on Foundry's public hoverToken hook plus the next
	 * left pointer press on the canvas. */
	Hooks.on("hoverToken", (token, hovered) => {
		if (!activePendingPick) return;
		if (hovered === true) {
			hoveredPendingPickToken = token;
			return;
		}
		if (hoveredPendingPickToken === token) hoveredPendingPickToken = null;
	});

	Hooks.once("ready", () => {
		document.addEventListener("keydown", onGlobalKeydown, true);
		document.addEventListener("pointerdown", onGlobalPointerDown, true);
	});

	Object.defineProperty(
		DialogV2,
		"__wfrpAttackCanvasTargetingInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function isAttackDialogConfig(config) {
	return Array.isArray(config?.classes) && config.classes.includes(ATTACK_DIALOG_CLASS);
}

function activateTargetSync(root) {
	if (!root?.classList?.contains?.(ATTACK_DIALOG_CLASS)) return null;

	/* A live pre-roll dialog is a new targeting workflow. Do not leave an older
	 * pending ChatMessage armed for a scene pick at the same time. */
	disarmPendingPick();

	const selection = root.querySelector('[name="targetSelection"]');
	const targetUuid = root.querySelector('[name="targetUuid"]');
	if (!(selection instanceof HTMLSelectElement) || !(targetUuid instanceof HTMLInputElement)) {
		return null;
	}

	decorateAttackTargetControls(root, selection);

	/* Native Foundry targeting is live while this dialog is open. Keeping a
	 * second "Use current target" action would duplicate the normal workflow. */
	root.querySelector('[data-attack-target-action="current-target"]')?.remove();

	const syncFromFoundryTarget = () => {
		const target = ActorTargetResolver.singleTargetActor();
		if (!target) {
			selection.value = TARGET_SELECTION_PENDING;
			targetUuid.value = "";
			selection.dispatchEvent(new Event("change", { bubbles: true }));
			return;
		}

		const uuid = String(target.uuid ?? "");
		if (!uuid) return;
		ensureTargetOption(selection, target);
		selection.value = uuid;
		targetUuid.value = uuid;
		selection.dispatchEvent(new Event("change", { bubbles: true }));
	};

	syncFromFoundryTarget();
	releaseInitialDialogFocus(root);

	const onChange = (event) => {
		const control = event.target;
		if (control instanceof HTMLSelectElement) {
			releaseFocusAfterInteraction(control);
			return;
		}
		if (
			control instanceof HTMLInputElement &&
			(control.type === "checkbox" || control.type === "radio")
		) {
			releaseFocusAfterInteraction(control);
		}
	};

	const onClick = (event) => {
		const button = event.target?.closest?.("button");
		if (!(button instanceof HTMLButtonElement) || !root.contains(button)) return;
		releaseFocusAfterInteraction(button);
	};

	root.addEventListener("change", onChange);
	root.addEventListener("click", onClick);

	const hookId = Hooks.on("targetToken", (user) => {
		if (String(user?.id ?? "") !== String(game.user?.id ?? "")) return;
		if (!root.isConnected) return;
		syncFromFoundryTarget();
	});

	return () => {
		Hooks.off("targetToken", hookId);
		root.removeEventListener("change", onChange);
		root.removeEventListener("click", onClick);
	};
}

function decorateAttackTargetControls(root, selection) {
	const pendingOption = [...selection.options].find(
		(option) => option.value === TARGET_SELECTION_PENDING,
	);
	if (pendingOption) {
		pendingOption.textContent = localize(
			"Choose scene token…",
			"Wybierz token ze sceny…",
		);
	}
	selection.title = localize(
		"Choose a visible token on the current scene. You can also change the target directly on the canvas.",
		"Wybierz widoczny token na bieżącej scenie. Możesz też normalnie zmieniać cel bezpośrednio na mapie.",
	);

	const chooseActor = root.querySelector('[data-attack-target-action="choose-actor"]');
	if (chooseActor instanceof HTMLButtonElement) {
		chooseActor.title = worldActorTooltip();
	}
}

function decoratePendingTargetCard(message, rendered) {
	const card = pendingCardFromElement(rendered);
	if (!card || !message?.id) return;
	card.dataset.wfrpPendingMessageId = String(message.id);

	const select = card.querySelector("[data-pending-attack-scene-target]");
	if (select instanceof HTMLSelectElement) {
		const pendingOption = [...select.options].find(
			(option) => option.value === TARGET_SELECTION_PENDING,
		);
		if (pendingOption) {
			pendingOption.textContent = localize(
				"Choose scene token…",
				"Wybierz token ze sceny…",
			);
		}
		select.title = localize(
			"Choose a visible token from the current scene.",
			"Wybierz widoczny token z bieżącej sceny.",
		);
	}

	const chooseActor = card.querySelector('[data-pending-attack-action="choose-actor"]');
	if (chooseActor instanceof HTMLButtonElement) {
		chooseActor.title = worldActorTooltip();
	}

	installPendingScenePickButton(message, card);
	activatePendingCardFocusRelease(card);
}

function installPendingScenePickButton(message, card) {
	const actions = card.querySelector(".pending-combat-attack__actions");
	if (!(actions instanceof HTMLElement)) return;

	let button = actions.querySelector("[data-wfrp-pending-pick-scene-target]");
	if (!(button instanceof HTMLButtonElement)) {
		button = document.createElement("button");
		button.type = "button";
		button.dataset.wfrpPendingPickSceneTarget = "";
		button.classList.add("pending-combat-attack__pick-scene");

		const icon = document.createElement("i");
		icon.className = "fa-solid fa-crosshairs";
		const label = document.createElement("span");
		label.dataset.wfrpPendingPickSceneLabel = "";
		button.append(icon, label);
		actions.prepend(button);

		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			button.blur();

			if (!canResolvePendingMessage(message)) return;
			if (activePendingPick?.messageId === String(message.id)) {
				disarmPendingPick();
				return;
			}
			armPendingPick(message, card, button);
		}, true);
	}

	if (activePendingPick?.messageId === String(message.id)) {
		activePendingPick.card = card;
		activePendingPick.button = button;
		setPendingPickVisual(card, button, true);
	} else {
		setPendingPickVisual(card, button, false);
	}
}

function armPendingPick(message, card, button) {
	disarmPendingPick();
	hoveredPendingPickToken = null;
	activePendingPick = {
		messageId: String(message.id),
		card,
		button,
	};
	document.body?.classList.add("wfrp1ed-pending-scene-pick-active");
	setPendingPickVisual(card, button, true);
}

function disarmPendingPick() {
	if (activePendingPick) {
		setPendingPickVisual(activePendingPick.card, activePendingPick.button, false);
	}
	activePendingPick = null;
	hoveredPendingPickToken = null;
	document.body?.classList.remove("wfrp1ed-pending-scene-pick-active");
}

function setPendingPickVisual(card, button, armed) {
	if (card instanceof HTMLElement) {
		card.classList.toggle("is-picking-scene-target", armed);
	}
	if (!(button instanceof HTMLButtonElement)) return;
	button.classList.toggle("is-active", armed);
	button.setAttribute("aria-pressed", String(armed));
	button.title = armed
		? localize(
			"Click a token on the scene to use it as this attack's target. Press Esc or click this button again to cancel.",
			"Kliknij token na mapie, aby ustawić go jako cel tego ataku. Naciśnij Esc albo kliknij ten przycisk ponownie, aby anulować.",
		)
		: localize(
			"Pick this pending attack's target directly from the scene without changing Foundry Target Token state.",
			"Wskaż cel tego oczekującego ataku bezpośrednio na mapie bez zmiany stanu celu Foundry.",
		);
	const label = button.querySelector("[data-wfrp-pending-pick-scene-label]");
	if (label) {
		label.textContent = armed
			? localize("Click token on scene…", "Kliknij token na mapie…")
			: localize("Pick on scene", "Wskaż na mapie");
	}
}

function onGlobalPointerDown(event) {
	if (!activePendingPick || event.button !== 0) return;
	const token = hoveredPendingPickToken;
	if (!token) return;

	/* Consume this pointer press before Foundry starts token control/movement.
	 * Scene-pick mode is an attack-card action, not a canvas selection action. */
	event.preventDefault();
	event.stopImmediatePropagation();
	void applySceneTokenToPendingPick(token);
}

async function applySceneTokenToPendingPick(token) {
	if (!activePendingPick) return;
	const messageId = String(activePendingPick.messageId ?? "");
	const message = game.messages?.get(messageId);
	if (!message || !canResolvePendingMessage(message)) {
		disarmPendingPick();
		return;
	}

	const actor = token?.actor;
	if (actor?.documentName !== "Actor" || !actor.uuid) return;

	let card = activePendingPick.card;
	if (!(card instanceof HTMLElement) || !card.isConnected) {
		card = findPendingCard(messageId);
	}
	const select = card?.querySelector?.("[data-pending-attack-scene-target]");
	if (!(select instanceof HTMLSelectElement)) {
		disarmPendingPick();
		return;
	}

	const displayName = String(token?.name ?? token?.document?.name ?? actor.name ?? "—");
	ensureTargetOption(select, actor, displayName);
	select.value = String(actor.uuid);

	/* Keep the orange armed state until a valid Token has actually been chosen;
	 * then clear it before the ChatMessage update re-renders every client. */
	disarmPendingPick();
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function canResolvePendingMessage(message) {
	const entry = pendingEntry(message);
	if (!entry) return false;
	const actor = ActorTargetResolver.actorFromUuidSync(entry.request.actorUuid);
	if (!actor || !game.user) return false;
	if (game.user.isGM) return true;
	return actor.testUserPermission?.(
		game.user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function pendingEntry(message) {
	for (const flagKey of PENDING_FLAG_KEYS) {
		const request = message?.getFlag?.(FLAG_SCOPE, flagKey);
		if (request?.status === "pending") return { flagKey, request };
	}
	return null;
}

function findPendingCard(messageId) {
	const id = String(messageId ?? "");
	if (!id) return null;
	return [...document.querySelectorAll("[data-wfrp-pending-message-id]")]
		.find((card) => String(card.dataset?.wfrpPendingMessageId ?? "") === id) ?? null;
}

function activatePendingCardFocusRelease(card) {
	if (card.dataset.wfrpCanvasTargetFocusRelease === "true") return;
	card.dataset.wfrpCanvasTargetFocusRelease = "true";

	card.addEventListener("change", (event) => {
		const control = event.target;
		if (control instanceof HTMLSelectElement) {
			releaseFocusAfterInteraction(control);
		}
	});

	card.addEventListener("click", (event) => {
		const button = event.target?.closest?.("button");
		if (!(button instanceof HTMLButtonElement) || !card.contains(button)) return;
		releaseFocusAfterInteraction(button);
	});
}

function onGlobalKeydown(event) {
	if (!activePendingPick || event.key !== "Escape") return;
	event.preventDefault();
	event.stopImmediatePropagation();
	disarmPendingPick();
}

function pendingCardFromElement(rendered) {
	return rendered?.matches?.("[data-wfrp-pending-combat-attack]")
		? rendered
		: rendered?.querySelector?.("[data-wfrp-pending-combat-attack]") ?? null;
}

function worldActorTooltip() {
	return localize(
		"Choose any Actor from the World Actors directory, including an Actor without a token on the current scene.",
		"Wybierz dowolnego Aktora z panelu Aktorów świata, także takiego, który nie ma tokenu na bieżącej scenie.",
	);
}

function releaseInitialDialogFocus(root) {
	requestAnimationFrame(() => {
		if (!root?.isConnected) return;
		const active = document.activeElement;
		if (!active || !root.contains(active)) return;
		if (
			active instanceof HTMLButtonElement ||
			active instanceof HTMLSelectElement ||
			(active instanceof HTMLInputElement &&
				(active.type === "checkbox" || active.type === "radio"))
		) {
			active.blur();
		}
	});
}

function releaseFocusAfterInteraction(control) {
	queueMicrotask(() => {
		if (document.activeElement === control) control.blur();
	});
}

function ensureTargetOption(selection, target, explicitName = "") {
	const uuid = String(target?.uuid ?? "");
	if (!uuid) return null;
	let option = [...selection.options].find((entry) => entry.value === uuid);
	const sceneEntry = ActorTargetResolver.sceneTokenTargets().find(
		(entry) => String(entry.actorUuid ?? "") === uuid,
	);
	const displayName = String(explicitName || sceneEntry?.name || target?.name || "—");

	if (!option) {
		option = document.createElement("option");
		option.value = uuid;
		selection.append(option);
	}
	option.textContent = displayName;
	option.dataset.targetName = displayName;
	return option;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
		? polish
		: english;
}
