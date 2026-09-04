import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import { TestManager } from "./TestManager.mjs";
import { normalizeTestResultVisibility } from "./TestResultVisibility.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "pendingStandardTest";
const TEMPLATE_PATH = "systems/wfrp1ed/templates/chat/pending-standard-test.hbs";
const TARGET_SELECTION_PENDING = "__pending__";
const TARGET_MODE_PENDING = "pending";
const TARGET_MODE_ACTOR = "actor";

const SERIALIZED_OPTION_KEYS = Object.freeze([
	"movement",
	"noise",
	"lockDifficulty",
	"modifier",
]);

/**
 * Pending target-dependent Standard Test.
 *
 * This follows the same interaction contract as pending attacks: the roll may
 * be configured before target data is known, target selection is persisted in
 * the ChatMessage, and the actual d100 is not rolled until either an Actor
 * target or every required raw target characteristic is available.
 */
export class PendingStandardTest {
	static needsResolution(testId, options = {}) {
		const test = TestManager.get(testId);
		if (!test?.tags.includes("requires-target")) return false;
		if (options.target ?? options.targetActor) return false;

		const requirements = this.targetRequirements(test);
		const targetValues = options.targetValues ?? {};
		return !requirements.every((id) =>
			Number.isFinite(Number(targetValues?.[id])),
		);
	}

	static targetRequirements(testOrId) {
		const test = typeof testOrId === "string"
			? TestManager.get(testOrId)
			: testOrId;
		if (!test) {
			throw new Error("Pending Standard Test requires a registered Test.");
		}

		const requirements = new Set();
		for (const match of String(test.formula ?? "").matchAll(
			/\btarget\.([A-Za-z][A-Za-z0-9]*)\b/g,
		)) {
			requirements.add(String(match[1]).trim().toLowerCase());
		}
		return Object.freeze([...requirements]);
	}

	static async create(actor, testId, options = {}) {
		if (!actor?.uuid) {
			throw new Error("Pending Standard Test requires an Actor with a UUID.");
		}
		const test = TestManager.get(testId);
		if (!test?.tags.includes("requires-target")) {
			throw new Error(`Test '${String(testId)}' does not require deferred target data.`);
		}
		if (!this.needsResolution(testId, options)) {
			throw new Error(`Test '${String(testId)}' already has enough target data.`);
		}

		const serialized = this._serializeOptions(options);
		const manualTargetValues = foundry.utils.deepClone(serialized.targetValues ?? {});
		delete serialized.targetValues;

		const request = {
			version: 3,
			status: "pending",
			actorUuid: actor.uuid,
			testId: test.id,
			options: serialized,
			targetRequirements: [...this.targetRequirements(test)],
			selection: emptySelection(),
			manualTargetValues,
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
		};

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: await this._render(actor, test, request),
			flags: { [FLAG_SCOPE]: { [FLAG_KEY]: request } },
		});
	}

	static activateListeners(message, html) {
		const request = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!request || request.status !== "pending") return;

		const rendered = this._asElement(html);
		const card = rendered?.matches?.("[data-wfrp-pending-standard-test]")
			? rendered
			: rendered?.querySelector?.("[data-wfrp-pending-standard-test]");
		if (!card) return;

		const actor = ActorTargetResolver.actorFromUuidSync(request.actorUuid);
		const canResolve = canResolveActor(actor, game.user);
		const controls = card.querySelector("[data-pending-standard-controls]");
		const waiting = card.querySelector("[data-pending-standard-player-status]");
		if (!canResolve) {
			if (controls) controls.hidden = true;
			if (waiting) waiting.hidden = false;
			return;
		}
		if (controls) controls.hidden = false;
		if (waiting) waiting.hidden = true;

		for (const gmOnly of card.querySelectorAll("[data-pending-standard-gm-only]")) {
			gmOnly.hidden = !game.user?.isGM;
		}

		const select = card.querySelector("[data-pending-standard-scene-target]");
		const manual = card.querySelector("[data-pending-standard-manual]");
		const roll = card.querySelector('[data-pending-standard-action="roll"]');
		if (select instanceof HTMLSelectElement) {
			populateTargetChoices(select, request);
			select.addEventListener("change", () => {
				void this._selectTarget(message, request, select);
			});
		}

		const refreshReady = () => {
			const selection = String(select?.value ?? TARGET_SELECTION_PENDING);
			const actorSelected = selection !== TARGET_SELECTION_PENDING;
			if (manual instanceof HTMLElement) manual.hidden = actorSelected;
			const ready = actorSelected || manualValuesComplete(card, request.targetRequirements);
			if (roll instanceof HTMLButtonElement) roll.disabled = !ready;
		};
		for (const input of card.querySelectorAll("[data-pending-standard-manual-value]")) {
			input.addEventListener("input", refreshReady);
			input.addEventListener("change", () => {
				void this._persistManualValues(message, request, card);
			});
		}
		refreshReady();

		for (const button of card.querySelectorAll("[data-pending-standard-action]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				void this._handleAction(message, request, card, button.dataset.pendingStandardAction);
			});
		}

		const dropZone = card.querySelector("[data-pending-standard-target-drop]");
		if (dropZone && game.user?.isGM) {
			dropZone.addEventListener("dragover", (event) => {
				event.preventDefault();
				dropZone.classList.add("is-dragover");
			});
			dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
			dropZone.addEventListener("drop", (event) => {
				event.preventDefault();
				dropZone.classList.remove("is-dragover");
				void this._handleDrop(message, request, event);
			});
		}
	}

	static async _selectTarget(message, request, select) {
		try {
			assertCanResolve(request);
			const value = String(select.value ?? TARGET_SELECTION_PENDING);
			if (value === TARGET_SELECTION_PENDING) {
				await this._setSelection(message, request, emptySelection());
				return;
			}
			const target = ActorTargetResolver.actorFromUuidSync(value);
			if (!target) {
				await this._setSelection(message, request, emptySelection());
				return;
			}
			await this._setSelection(message, request, {
				targetMode: TARGET_MODE_ACTOR,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(select.selectedOptions?.[0]?.textContent ?? target.name ?? ""),
			});
		} catch (error) {
			this._reportError(error);
		}
	}

	static async _handleAction(message, request, card, action) {
		try {
			assertCanResolve(request);
			if (action === "roll") {
				await this._executeSelected(message, request, card);
				return;
			}
			if (action === "choose-actor") {
				if (!game.user?.isGM) throw new Error("Only a GM can choose a world Actor here.");
				const target = await ActorTargetResolver.chooseActor();
				if (!target) return;
				await this._setSelection(message, request, {
					targetMode: TARGET_MODE_ACTOR,
					targetUuid: String(target.uuid ?? ""),
					targetName: String(target.name ?? ""),
				});
				return;
			}
			throw new Error(`Unknown pending Standard Test action '${String(action)}'.`);
		} catch (error) {
			this._reportError(error);
		}
	}

	static async _handleDrop(message, request, event) {
		try {
			if (!game.user?.isGM) throw new Error("Only a GM can drag a world Actor here.");
			assertCanResolve(request);
			const target = await ActorTargetResolver.actorFromDropEvent(event);
			if (!target) {
				throw new Error(this._localize(
					"WFRP1ED.StandardTest.DropActorOnly",
					"Drop an Actor or a Token with an Actor here.",
					"Upuść tutaj Aktora albo token powiązany z Aktorem.",
				));
			}
			await this._setSelection(message, request, {
				targetMode: TARGET_MODE_ACTOR,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(target.name ?? ""),
			});
		} catch (error) {
			this._reportError(error);
		}
	}

	static async _persistManualValues(message, request, card) {
		try {
			assertCanResolve(request);
			const updated = foundry.utils.deepClone(request);
			updated.manualTargetValues = readManualValues(card);
			updated.updatedBy = String(game.user?.id ?? "");
			updated.updatedAt = Date.now();
			await this._updateRequest(message, updated);
		} catch (error) {
			this._reportError(error);
		}
	}

	static async _setSelection(message, request, selection) {
		const updated = foundry.utils.deepClone(request);
		updated.version = 3;
		updated.selection = {
			targetMode: String(selection.targetMode ?? TARGET_MODE_PENDING),
			targetUuid: String(selection.targetUuid ?? ""),
			targetName: String(selection.targetName ?? ""),
		};
		updated.updatedBy = String(game.user?.id ?? "");
		updated.updatedAt = Date.now();
		await this._updateRequest(message, updated);
	}

	static async _updateRequest(message, request) {
		const actor = ActorTargetResolver.actorFromUuidSync(request.actorUuid);
		const test = TestManager.get(request.testId);
		if (!actor || !test) throw new Error("The pending Standard Test source is no longer available.");
		await message.update({
			content: await this._render(actor, test, request),
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: request,
		});
	}

	static async _executeSelected(message, request, card) {
		const selection = request.selection ?? emptySelection();
		const targetMode = String(selection.targetMode ?? TARGET_MODE_PENDING);
		let resolution = {};
		if (targetMode === TARGET_MODE_ACTOR) {
			const target = ActorTargetResolver.actorFromUuidSync(selection.targetUuid);
			if (!target) throw new Error(this._localize(
				"WFRP1ED.StandardTest.TargetUnavailable",
				"The selected target Actor is no longer available.",
				"Wybrany Aktor celu nie jest już dostępny.",
			));
			resolution.target = target;
		} else {
			const targetValues = readManualValues(card);
			if (!requirementsComplete(targetValues, request.targetRequirements)) {
				throw new Error(this._localize(
					"WFRP1ED.StandardTest.ManualTargetInvalid",
					"Select a target Actor or enter every required target characteristic before rolling.",
					"Wybierz Aktora celu albo wprowadź wszystkie wymagane cechy celu przed rzutem.",
				));
			}
			resolution.targetValues = targetValues;
		}
		await this._execute(message, request, resolution);
	}

	static async _execute(message, request, resolution) {
		const actor = ActorTargetResolver.actorFromUuidSync(request.actorUuid);
		if (typeof actor?.rollTest !== "function") {
			throw new Error("The Actor which created this pending Test is no longer available.");
		}
		const options = { ...(request.options ?? {}) };
		if (resolution.target) options.target = resolution.target;
		if (resolution.targetValues) options.targetValues = { ...resolution.targetValues };
		const result = await actor.rollTest(request.testId, options);
		if (!result) return null;
		await message.delete();
		return result;
	}

	static _serializeOptions(options) {
		const serialized = {};
		for (const key of SERIALIZED_OPTION_KEYS) {
			const raw = options?.[key];
			if (raw === undefined || raw === null || raw === "") continue;
			const value = Number(raw);
			if (!Number.isFinite(value)) {
				throw new Error(`Pending Standard Test option '${key}' must be finite.`);
			}
			serialized[key] = value;
		}
		serialized.resultVisibility = normalizeTestResultVisibility(options?.resultVisibility);

		if (Array.isArray(options?.modifiers)) {
			serialized.modifiers = options.modifiers.map((modifier) => ({ ...modifier }));
		}
		if (Array.isArray(options?.ruleEffects)) {
			serialized.ruleEffects = options.ruleEffects.map((entry) => ({
				...entry,
				source: { ...(entry?.source ?? {}) },
			}));
		}
		if (options?.targetValues && typeof options.targetValues === "object" && !Array.isArray(options.targetValues)) {
			serialized.targetValues = {};
			for (const [rawKey, rawValue] of Object.entries(options.targetValues)) {
				const key = String(rawKey ?? "").trim().toLowerCase();
				const value = Number(rawValue);
				if (key && Number.isFinite(value)) serialized.targetValues[key] = value;
			}
		}
		return serialized;
	}

	static async _render(actor, test, request) {
		return foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			this._templateContext(actor, test, request),
		);
	}

	static _templateContext(actor, test, request) {
		const selection = request.selection ?? emptySelection();
		const actorSelected = String(selection.targetMode ?? "") === TARGET_MODE_ACTOR;
		const manualValues = request.manualTargetValues ?? {};
		const targetResolved = actorSelected || requirementsComplete(manualValues, request.targetRequirements);
		return {
			actorName: actor.name,
			testName: test.name,
			targetLabel: this._localize("WFRP1ED.StandardTest.Target", "Target", "Cel"),
			pendingLabel: actorSelected
				? String(selection.targetName || "—")
				: this._localize(
					"WFRP1ED.StandardTest.PendingTarget",
					"No target Actor selected",
					"Nie wybrano Aktora celu",
				),
			dropPrompt: this._localize(
				"WFRP1ED.StandardTest.DropTarget",
				"GM: drop Actor from sidebar",
				"MG: upuść Aktora z panelu bocznego",
			),
			chooseActorLabel: this._localize(
				"WFRP1ED.StandardTest.ChooseActor",
				"Choose Actor",
				"Wybierz Aktora",
			),
			rollLabel: this._localize("WFRP1ed.TestDialog.Roll", "Roll", "Rzuć"),
			waitingLabel: this._localize(
				"WFRP1ED.StandardTest.WaitingForResolution",
				"Waiting for the rolling Actor owner or GM to resolve target data.",
				"Oczekiwanie na właściciela rzucającego Aktora albo MG, aby uzupełnić dane celu.",
			),
			targetResolved,
			manualInputs: (request.targetRequirements ?? []).map((id) => ({
				id,
				label: this._characteristicLabel(id),
				value: Number.isFinite(Number(manualValues?.[id])) ? Number(manualValues[id]) : "",
			})),
		};
	}

	static _characteristicLabel(id) {
		const labels = {
			m: ["Movement", "Szybkość"], ws: ["Weapon Skill", "Walka Wręcz"],
			bs: ["Ballistic Skill", "Umiejętności Strzeleckie"], s: ["Strength", "Siła"],
			t: ["Toughness", "Wytrzymałość"], w: ["Wounds", "Żywotność"],
			i: ["Initiative", "Inicjatywa"], a: ["Attacks", "Atak"],
			dex: ["Dexterity", "Zręczność"], ld: ["Leadership", "Cechy Przywódcze"],
			int: ["Intelligence", "Inteligencja"], cl: ["Cool", "Opanowanie"],
			wp: ["Will Power", "Siła Woli"], fel: ["Fellowship", "Ogłada"],
		};
		const pair = labels[String(id ?? "").toLowerCase()] ?? [String(id), String(id)];
		return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
			? `${pair[1]} celu`
			: `Target ${pair[0]}`;
	}

	static _asElement(html) {
		if (html instanceof HTMLElement) return html;
		if (html?.[0] instanceof HTMLElement) return html[0];
		return null;
	}

	static _reportError(error) {
		console.error("WFRP1ED | Unable to resolve pending Standard Test.", error);
		ui.notifications.error(error?.message ?? "Unable to resolve the pending Standard Test.");
	}

	static _localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);
		if (localized !== key) return localized;
		return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl")
			? polishFallback
			: englishFallback;
	}
}

function populateTargetChoices(select, request) {
	select.replaceChildren();
	appendOption(select, TARGET_SELECTION_PENDING, localize("Choose scene token…", "Wybierz token ze sceny…"));
	for (const entry of ActorTargetResolver.sceneTokenTargets()) {
		appendOption(select, entry.actorUuid, entry.name);
	}
	const selection = request?.selection ?? emptySelection();
	if (String(selection.targetMode ?? "") !== TARGET_MODE_ACTOR) {
		select.value = TARGET_SELECTION_PENDING;
		return;
	}
	const uuid = String(selection.targetUuid ?? "");
	if (uuid && ![...select.options].some((option) => option.value === uuid)) {
		appendOption(select, uuid, String(selection.targetName || "—"));
	}
	select.value = uuid || TARGET_SELECTION_PENDING;
}

function appendOption(select, value, label) {
	const option = document.createElement("option");
	option.value = String(value);
	option.textContent = String(label);
	select.append(option);
}

function readManualValues(card) {
	const values = {};
	for (const input of card?.querySelectorAll?.("[data-pending-standard-manual-value]") ?? []) {
		const id = String(input.dataset.characteristicId ?? "").trim();
		const raw = String(input.value ?? "").trim();
		const value = Number(raw);
		if (id && raw && Number.isFinite(value)) values[id] = value;
	}
	return values;
}

function manualValuesComplete(card, requirements) {
	return requirementsComplete(readManualValues(card), requirements);
}

function requirementsComplete(values, requirements) {
	const ids = Array.isArray(requirements) ? requirements : [];
	return ids.length > 0 && ids.every((id) => Number.isFinite(Number(values?.[id])));
}

function emptySelection() {
	return { targetMode: TARGET_MODE_PENDING, targetUuid: "", targetName: "" };
}

function canResolveActor(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function assertCanResolve(request) {
	const actor = ActorTargetResolver.actorFromUuidSync(request?.actorUuid);
	if (!canResolveActor(actor, game.user)) {
		throw new Error(localize(
			"Only the rolling Actor owner or a GM can resolve this pending test.",
			"Tylko właściciel rzucającego Aktora albo MG może rozstrzygnąć ten oczekujący test.",
		));
	}
}

function localize(english, polish) {
	return String(game.i18n?.lang ?? "").toLowerCase().startsWith("pl") ? polish : english;
}
