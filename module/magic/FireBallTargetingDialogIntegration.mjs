import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";

const ACTIVE_DIALOGS = new Set();
let installed = false;

/**
 * Keep the Fire Ball cast dialog aligned with the target-picker interaction used
 * by combat dialogs while preserving Fire Ball's RAW multi-target group model.
 *
 * Scene-token selection has one source of truth: Foundry's current User targets.
 * The hidden legacy refresh action remains the procedure-owned persistence
 * boundary, so this integration does not duplicate FireBallProcedure state.
 */
export function installFireBallTargetingDialogIntegration() {
	if (installed) return;
	installed = true;

	Hooks.on("renderApplicationV2", (_application, element) => {
		const root = fireBallRoot(element);
		if (!root || root.dataset.wfrpFireBallTargetingEnhanced === "true") return;
		enhanceDialog(root);
	});

	Hooks.on("targetToken", (user) => {
		if (String(user?.id ?? "") !== String(game.user?.id ?? "")) return;
		for (const root of [...ACTIVE_DIALOGS]) {
			if (!root.isConnected) {
				ACTIVE_DIALOGS.delete(root);
				continue;
			}
			scheduleProcedureSync(root);
		}
	});
}

function enhanceDialog(root) {
	root.dataset.wfrpFireBallTargetingEnhanced = "true";
	ACTIVE_DIALOGS.add(root);

	const actions = root.querySelector(".wfrp-fireball-dialog__target-actions");
	const refresh = root.querySelector("[data-fire-ball-refresh-targets]");
	if (refresh instanceof HTMLButtonElement) {
		refresh.hidden = true;
		refresh.setAttribute("aria-hidden", "true");
		refresh.tabIndex = -1;
	}

	if (actions) {
		const picker = buildScenePicker(root);
		actions.prepend(picker);
	}

	refreshScenePicker(root);
}

function buildScenePicker(root) {
	const details = document.createElement("details");
	details.className = "wfrp-fireball-dialog__scene-picker";
	details.dataset.fireBallScenePicker = "";

	const summary = document.createElement("summary");
	summary.dataset.fireBallScenePickerSummary = "";
	details.append(summary);

	const options = document.createElement("div");
	options.className = "wfrp-fireball-dialog__scene-options";
	options.dataset.fireBallSceneOptions = "";
	details.append(options);

	options.addEventListener("change", (event) => {
		const input = event.target?.closest?.("[data-fire-ball-scene-token]");
		if (!(input instanceof HTMLInputElement)) return;

		const ids = new Set(
			[...options.querySelectorAll("[data-fire-ball-scene-token]:checked")]
				.map((checkbox) => String(checkbox.dataset.tokenId ?? "").trim())
				.filter(Boolean),
		);

		if (typeof canvas?.tokens?.setTargets === "function") {
			canvas.tokens.setTargets(ids, { mode: "replace" });
		}
		scheduleProcedureSync(root);
	});

	return details;
}

function refreshScenePicker(root) {
	const details = root.querySelector("[data-fire-ball-scene-picker]");
	const options = root.querySelector("[data-fire-ball-scene-options]");
	const summary = root.querySelector("[data-fire-ball-scene-picker-summary]");
	if (!(details instanceof HTMLDetailsElement) || !options || !summary) return;

	const open = details.open;
	const targetedTokenUuids = new Set(
		[...(game.user?.targets ?? [])]
			.map((token) => String(token?.document?.uuid ?? token?.uuid ?? ""))
			.filter(Boolean),
	);
	const entries = ActorTargetResolver.sceneTokenTargets();

	options.replaceChildren();
	if (entries.length === 0) {
		const empty = document.createElement("div");
		empty.className = "wfrp-fireball-dialog__scene-empty";
		empty.textContent = localize(
			"No targetable tokens on this Scene.",
			"Brak dostępnych tokenów na tej Scenie.",
		);
		options.append(empty);
	} else {
		for (const entry of entries) {
			const label = document.createElement("label");
			label.className = "wfrp1ed-checkbox wfrp-fireball-dialog__scene-option";

			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.dataset.fireBallSceneToken = "";
			checkbox.dataset.tokenId = entry.tokenId;
			checkbox.dataset.tokenUuid = entry.tokenUuid;
			checkbox.checked = targetedTokenUuids.has(entry.tokenUuid);

			const text = document.createElement("span");
			text.textContent = entry.name;
			label.append(checkbox, text);
			options.append(label);
		}
	}

	const selectedCount = targetedTokenUuids.size;
	summary.textContent = selectedCount > 0
		? localize(
			`Scene tokens — ${selectedCount} selected`,
			`Tokeny ze sceny — wybrano: ${selectedCount}`,
		)
		: localize("Choose Scene tokens…", "Wybierz tokeny ze sceny…");
	details.open = open;
}

function scheduleProcedureSync(root) {
	if (!root?.isConnected) return;
	if (root.dataset.wfrpFireBallTargetSyncQueued === "true") return;
	root.dataset.wfrpFireBallTargetSyncQueued = "true";

	queueMicrotask(() => {
		delete root.dataset.wfrpFireBallTargetSyncQueued;
		if (!root.isConnected) {
			ACTIVE_DIALOGS.delete(root);
			return;
		}

		const refresh = root.querySelector("[data-fire-ball-refresh-targets]");
		if (refresh instanceof HTMLButtonElement) refresh.click();
		refreshScenePicker(root);
	});
}

function fireBallRoot(element) {
	if (!(element instanceof HTMLElement)) return null;
	if (element.matches(".wfrp-fireball-dialog")) return element;
	return element.querySelector(".wfrp-fireball-dialog");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
