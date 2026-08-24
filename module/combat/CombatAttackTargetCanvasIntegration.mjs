import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const TARGET_SELECTION_PENDING = "__pending__";
const ATTACK_DIALOG_CLASS = "wfrp1ed-combat-attack-dialog";

install();

/**
 * Keep attack dialogs and pending attack cards connected to Foundry's native
 * canvas targeting workflow.
 *
 * DialogV2 stringifies HTMLElement content before render, so form-control state
 * assigned only as DOM properties while building the content is not a reliable
 * way to preserve a pre-selected target. The rendered dialog is therefore
 * synchronized from game.user.targets after its own listeners are attached.
 *
 * Attack dialogs are explicitly non-modal so the user can still interact with
 * the canvas and use normal Foundry token targeting while the dialog is open.
 * The targetToken hook then mirrors the current user's single target into the
 * dialog. Zero or multiple targets return the dialog to the pending/deferred
 * target state rather than silently retaining a stale defender.
 *
 * Foundry's canvas hotkeys are intentionally suppressed while a form control
 * owns keyboard focus. After a discrete dialog choice (select, checkbox or
 * button) is completed we release that focus again, so the user may immediately
 * hover another token and use their normal Foundry Target Token keybinding
 * without first clicking an empty part of the canvas. Text/number inputs retain
 * focus because typing into them must remain uninterrupted.
 *
 * DialogV2 also focuses its default Roll button when the window first opens.
 * We release that automatic initial focus after the render frame so native
 * canvas targeting works immediately, before the user touches any dialog input.
 *
 * Pending attack cards use the same native Foundry targeting convention. A real
 * targetToken event updates the newest pending card which the current user may
 * resolve. The persisted ChatMessage selection is otherwise authoritative and
 * is never re-derived from each client's private game.user.targets during card
 * rendering. This is essential because the GM and an Actor owner may have
 * different local canvas targets: whichever valid card action or targetToken
 * event updates the ChatMessage last becomes the shared selection for everyone.
 * Manual Clear, scene-dropdown selection and GM World-Actor/drop choices are
 * therefore not immediately overwritten by a stale local canvas target.
 *
 * If a live pre-roll attack dialog is also open, it takes priority so targeting
 * a new attack cannot silently rewrite an older pending ChatMessage.
 *
 * Target selectors deliberately distinguish visible Scene tokens from the GM's
 * broader World Actor picker. The latter keeps its compact button label but has
 * an explanatory tooltip in both the pre-roll dialog and pending chat card.
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

	Hooks.on("renderChatMessageHTML", (_message, html) => {
		const rendered = asElement(html);
		requestAnimationFrame(() => decoratePendingTargetCard(rendered));
	});

	Hooks.on("targetToken", (user) => {
		if (String(user?.id ?? "") !== String(game.user?.id ?? "")) return;
		syncNewestPendingCardFromFoundryTarget();
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

	const selection = root.querySelector('[name="targetSelection"]');
	const targetUuid = root.querySelector('[name="targetUuid"]');
	if (!(selection instanceof HTMLSelectElement) || !(targetUuid instanceof HTMLInputElement)) {
		return null;
	}

	decorateAttackTargetControls(root, selection);

	/* Native Foundry targeting is live while this dialog is open. Keeping a
	 * second "Use current target" action would duplicate the normal workflow and
	 * encourage unnecessary extra clicks. */
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

	/* Re-apply the current Foundry target after DialogV2 has rendered the
	 * stringified content. This repairs pre-selected targets on open. */
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

function decoratePendingTargetCard(rendered) {
	const card = pendingCardFromElement(rendered);
	if (!card) return;

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
			"Choose a visible token from the current scene. You can also change the target directly on the canvas.",
			"Wybierz widoczny token z bieżącej sceny. Możesz też normalnie zmieniać cel bezpośrednio na mapie.",
		);
	}

	const chooseActor = card.querySelector('[data-pending-attack-action="choose-actor"]');
	if (chooseActor instanceof HTMLButtonElement) {
		chooseActor.title = worldActorTooltip();
	}

	activatePendingCardFocusRelease(card);
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

function syncNewestPendingCardFromFoundryTarget() {
	if (attackDialogIsOpen()) return;
	const cards = [...document.querySelectorAll("[data-wfrp-pending-combat-attack]")]
		.filter((card) => card instanceof HTMLElement)
		.filter((card) => card.isConnected)
		.filter(canResolvePendingCard);
	const card = cards.at(-1);
	if (!card) return;
	applyFoundryTargetToPendingCard(card);
}

function applyFoundryTargetToPendingCard(card) {
	const select = card.querySelector("[data-pending-attack-scene-target]");
	if (!(select instanceof HTMLSelectElement)) return;

	const target = ActorTargetResolver.singleTargetActor();
	if (!target) {
		if (select.value === TARGET_SELECTION_PENDING) return;
		select.value = TARGET_SELECTION_PENDING;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		return;
	}

	const uuid = String(target.uuid ?? "");
	if (!uuid || select.value === uuid) return;
	ensureTargetOption(select, target);
	select.value = uuid;
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function canResolvePendingCard(card) {
	const controls = card.querySelector("[data-pending-attack-controls]");
	return controls instanceof HTMLElement && controls.hidden !== true;
}

function attackDialogIsOpen() {
	return Boolean(document.querySelector(`.${ATTACK_DIALOG_CLASS}`));
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

function ensureTargetOption(selection, target) {
	const uuid = String(target?.uuid ?? "");
	if (!uuid) return null;
	let option = [...selection.options].find((entry) => entry.value === uuid);
	const sceneEntry = ActorTargetResolver.sceneTokenTargets().find(
		(entry) => String(entry.actorUuid ?? "") === uuid,
	);
	const displayName = String(sceneEntry?.name ?? target?.name ?? "—");

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
