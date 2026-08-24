import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const TARGET_SELECTION_PENDING = "__pending__";
const ATTACK_DIALOG_CLASS = "wfrp1ed-combat-attack-dialog";

install();

/**
 * Keep attack dialogs connected to Foundry's native canvas targeting workflow.
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

	/* Native Foundry targeting is now live while this dialog is open. Keeping a
	 * second "Use current target" action would duplicate the normal workflow and
	 * encourage unnecessary extra clicks. The pending chat-card fallback keeps
	 * its own button because it is a separate, post-roll adjudication surface. */
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
