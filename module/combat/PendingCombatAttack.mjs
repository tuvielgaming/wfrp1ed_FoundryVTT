import { normalizeTestResultVisibility } from "../tests/TestResultVisibility.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import {
	COMBAT_ATTACK_TARGET_MODE,
	CombatAttackResolution,
} from "./CombatAttackResolution.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "pendingCombatAttack";
const TEMPLATE_PATH = "systems/wfrp1ed/templates/chat/pending-combat-attack-v2.hbs";

/** Pending configured melee roll awaiting a confirmed defender context. */
export class PendingCombatAttack {
	static async create(actor, weapon, configuration) {
		if (!actor?.uuid || !weapon?.uuid) {
			throw new Error("Pending combat attack requires Actor and Weapon UUIDs.");
		}

		const request = {
			version: 2,
			status: "pending",
			actorUuid: actor.uuid,
			weaponUuid: weapon.uuid,
			configuration: serializeConfiguration(configuration),
			selection: {
				targetMode: "pending",
				targetUuid: "",
				targetName: "",
			},
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: await this.#render(actor, weapon, request),
			flags: { [FLAG_SCOPE]: { [FLAG_KEY]: request } },
		});
	}

	static activateListeners(message, html) {
		const request = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!request || request.status !== "pending") return;

		const rendered = asElement(html);
		const card = rendered?.matches?.("[data-wfrp-pending-combat-attack]")
			? rendered
			: rendered?.querySelector?.("[data-wfrp-pending-combat-attack]");
		if (!card) return;

		const actor = ActorTargetResolver.actorFromUuidSync(request.actorUuid);
		const canResolve = canResolveRequest(actor, game.user);
		const controls = card.querySelector("[data-pending-attack-controls]");
		const waiting = card.querySelector("[data-pending-attack-player-status]");

		if (!canResolve) {
			if (controls) controls.hidden = true;
			if (waiting) waiting.hidden = false;
			return;
		}

		if (controls) controls.hidden = false;
		if (waiting) waiting.hidden = true;

		for (const gmOnly of card.querySelectorAll("[data-pending-attack-gm-only]")) {
			gmOnly.hidden = !game.user?.isGM;
		}

		const rollButton = card.querySelector('[data-pending-attack-action="roll"]');
		if (rollButton instanceof HTMLButtonElement) {
			rollButton.disabled = rollButton.dataset.targetResolved !== "true";
		}

		const sceneSelect = card.querySelector("[data-pending-attack-scene-target]");
		if (sceneSelect instanceof HTMLSelectElement) {
			populateSceneTargets(sceneSelect, request);
			sceneSelect.addEventListener("change", () => {
				void this.#selectSceneTarget(message, request, sceneSelect);
			});
		}

		for (const button of card.querySelectorAll("[data-pending-attack-action]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				void this.#handleAction(message, request, button.dataset.pendingAttackAction);
			});
		}

		const dropZone = card.querySelector("[data-pending-attack-drop]");
		if (dropZone && game.user?.isGM) {
			dropZone.addEventListener("dragover", (event) => {
				event.preventDefault();
				dropZone.classList.add("is-dragover");
			});
			dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
			dropZone.addEventListener("drop", (event) => {
				event.preventDefault();
				dropZone.classList.remove("is-dragover");
				void this.#handleDrop(message, request, event);
			});
		}
	}

	static async #selectSceneTarget(message, request, select) {
		try {
			assertCanResolve(ActorTargetResolver.actorFromUuidSync(request.actorUuid));
			const target = ActorTargetResolver.actorFromUuidSync(select.value);
			if (!target) {
				await this.#setSelection(message, request, emptySelection());
				return;
			}
			await this.#setSelection(message, request, {
				targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(select.selectedOptions?.[0]?.textContent ?? target.name ?? ""),
			});
		} catch (error) {
			reportError(error);
		}
	}

	static async #handleAction(message, request, action) {
		try {
			assertCanResolve(ActorTargetResolver.actorFromUuidSync(request.actorUuid));

			if (action === "roll") {
				await this.#executeSelected(message, request);
				return;
			}
			if (action === "clear-target") {
				await this.#setSelection(message, request, emptySelection());
				return;
			}
			if (action === "no-defender") {
				await this.#setSelection(message, request, {
					targetMode: COMBAT_ATTACK_TARGET_MODE.NONE,
					targetUuid: "",
					targetName: localize("No defender / object", "Bez obrońcy / obiekt"),
				});
				return;
			}

			let target = null;
			if (action === "current-target") {
				target = ActorTargetResolver.singleTargetActor();
				if (!target) {
					ui.notifications.warn(localize(
						"Target exactly one token on the canvas first.",
						"Najpierw wskaż dokładnie jeden token na mapie.",
					));
					return;
				}
			} else if (action === "choose-actor") {
				if (!game.user?.isGM) {
					throw new Error(localize(
						"Only a GM can choose a world Actor here.",
						"Tylko MG może tutaj wybrać Aktora świata.",
					));
				}
				target = await ActorTargetResolver.chooseActor();
			} else {
				throw new Error(`Unknown pending attack action '${String(action)}'.`);
			}

			if (!target) return;
			await this.#setSelection(message, request, {
				targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(target.name ?? ""),
			});
		} catch (error) {
			reportError(error);
		}
	}

	static async #handleDrop(message, request, event) {
		try {
			if (!game.user?.isGM) {
				throw new Error(localize(
					"Only a GM can drag a world Actor here.",
					"Tylko MG może tutaj przeciągnąć Aktora świata.",
				));
			}
			assertCanResolve(ActorTargetResolver.actorFromUuidSync(request.actorUuid));
			const target = await ActorTargetResolver.actorFromDropEvent(event);
			if (!target) {
				throw new Error(localize(
					"Drop an Actor from the sidebar here.",
					"Upuść tutaj Aktora z panelu bocznego.",
				));
			}
			await this.#setSelection(message, request, {
				targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(target.name ?? ""),
			});
		} catch (error) {
			reportError(error);
		}
	}

	static async #setSelection(message, request, selection) {
		const actor = await ActorTargetResolver.fromUuid(request.actorUuid);
		const weapon = await ActorTargetResolver.fromUuid(request.weaponUuid);
		if (actor?.documentName !== "Actor" || weapon?.type !== "weapon") {
			throw new Error("The pending attack source is no longer available.");
		}

		const updated = foundry.utils.deepClone(request);
		updated.version = 2;
		updated.selection = {
			targetMode: String(selection.targetMode ?? "pending"),
			targetUuid: String(selection.targetUuid ?? ""),
			targetName: String(selection.targetName ?? ""),
		};
		updated.updatedBy = game.user?.id ?? "";
		updated.updatedAt = Date.now();

		await message.update({
			content: await this.#render(actor, weapon, updated),
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});
	}

	static async #executeSelected(message, request) {
		const selection = request.selection ?? {};
		const targetMode = String(selection.targetMode ?? "pending");
		if (!Object.values(COMBAT_ATTACK_TARGET_MODE).includes(targetMode)) {
			throw new Error(localize(
				"Select and verify a target before rolling.",
				"Wybierz i sprawdź cel przed rzutem.",
			));
		}

		let target = null;
		if (targetMode === COMBAT_ATTACK_TARGET_MODE.DEFENDER) {
			const document = await ActorTargetResolver.fromUuid(selection.targetUuid);
			target = ActorTargetResolver.actorFromDocument(document);
			if (!target) {
				throw new Error(localize(
					"The selected defender is no longer available.",
					"Wybrany obrońca nie jest już dostępny.",
				));
			}
		}

		await this.#execute(message, request, { targetMode, target });
	}

	static async #execute(message, request, resolution) {
		const actor = await ActorTargetResolver.fromUuid(request.actorUuid);
		const weapon = await ActorTargetResolver.fromUuid(request.weaponUuid);
		if (actor?.documentName !== "Actor") throw new Error("The attacking Actor is no longer available.");
		if (weapon?.type !== "weapon") throw new Error("The attacking Weapon is no longer available.");

		const result = await CombatAttackResolution.execute(
			actor,
			weapon,
			request.configuration ?? {},
			resolution,
		);
		if (result) await message.delete();
		return result;
	}

	static async #render(actor, weapon, request) {
		return foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			this.#templateContext(actor, weapon, request),
		);
	}

	static #templateContext(actor, weapon, request) {
		const selection = request?.selection ?? {};
		const targetResolved = Object.values(COMBAT_ATTACK_TARGET_MODE).includes(
			String(selection.targetMode ?? "pending"),
		);
		return {
			actorName: actor.name,
			weaponName: weapon.name,
			title: localize("Pending melee attack", "Oczekujący atak wręcz"),
			targetLabel: localize("Target", "Cel"),
			pendingLabel: targetResolved
				? String(selection.targetName || "—")
				: localize("Not selected", "Nie wybrano"),
			targetResolved,
			visibleTokenLabel: localize("Visible token", "Widoczny token"),
			dropPrompt: localize("GM: drop Actor from sidebar", "MG: upuść Aktora z panelu bocznego"),
			useCurrentTargetLabel: localize("Use current target", "Użyj aktualnego celu"),
			clearTargetLabel: localize("Clear", "Usuń cel"),
			chooseActorLabel: localize("Choose Actor", "Wybierz Aktora"),
			noDefenderLabel: localize("No defender / object", "Bez obrońcy / obiekt"),
			rollLabel: localize("Roll", "Rzuć"),
			waitingGmLabel: localize(
				"Waiting for the attacker owner or GM to confirm the target and roll.",
				"Oczekiwanie na właściciela atakującego albo MG, aby potwierdzić cel i rzucić.",
			),
		};
	}
}

function populateSceneTargets(select, request) {
	select.replaceChildren();
	const empty = document.createElement("option");
	empty.value = "";
	empty.textContent = localize("Choose visible token…", "Wybierz widoczny token…");
	select.append(empty);
	for (const entry of ActorTargetResolver.sceneTokenTargets()) {
		const option = document.createElement("option");
		option.value = entry.actorUuid;
		option.textContent = entry.name;
		if (request?.selection?.targetUuid === entry.actorUuid) option.selected = true;
		select.append(option);
	}
}

function emptySelection() {
	return { targetMode: "pending", targetUuid: "", targetName: "" };
}

function serializeConfiguration(configuration = {}) {
	const modifier = Number(configuration.modifier ?? 0);
	if (!Number.isFinite(modifier)) throw new Error("Pending attack modifier must be finite.");
	return {
		modifier,
		resultVisibility: normalizeTestResultVisibility(configuration.resultVisibility),
		ruleEffects: Array.isArray(configuration.ruleEffects)
			? configuration.ruleEffects.map((entry) => ({ ...entry, source: { ...(entry?.source ?? {}) } }))
			: [],
		automaticRangeEffects: configuration.automaticRangeEffects === true,
		distance: Number(configuration.distance ?? 0) || 0,
		manualDamageModifier: Number(configuration.manualDamageModifier ?? 0) || 0,
	};
}

function assertCanResolve(actor) {
	if (!canResolveRequest(actor, game.user)) {
		throw new Error(localize(
			"Only the attacker owner or a GM can resolve this target.",
			"Tylko właściciel atakującego albo MG może rozstrzygnąć ten cel.",
		));
	}
}

function canResolveRequest(actor, user) {
	if (!actor || !user) return false;
	if (user.isGM) return true;
	return actor.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) === true;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to resolve pending combat attack.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to resolve the pending combat attack.",
		"Nie udało się rozstrzygnąć oczekującego ataku.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
