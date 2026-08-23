import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { normalizeTestResultVisibility } from "../tests/TestResultVisibility.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import { COMBAT_ATTACK_TARGET_MODE } from "./CombatAttackResolution.mjs";
import { CombatRangedAttackResolution } from "./CombatRangedAttackResolution.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "pendingRangedCombatAttack";
const TEMPLATE_PATH = "systems/wfrp1ed/templates/chat/pending-combat-attack-v2.hbs";
const TARGET_SELECTION_PENDING = "__pending__";
const TARGET_SELECTION_NONE = "__none__";

/**
 * Deferred target selection for an already-configured ranged firing attempt.
 *
 * The generic melee pending transaction stays untouched. Ranged needs a separate
 * pending source because its eventual execution consumes readiness, ammunition
 * and the ranged firing pool instead of melee Attacks.
 */
export class PendingRangedCombatAttack {
	static async create(actor, weapon, configuration) {
		assertSources(actor, weapon);

		const request = {
			version: 1,
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

		const targetSelect = card.querySelector("[data-pending-attack-scene-target]");
		if (targetSelect instanceof HTMLSelectElement) {
			populateTargetChoices(targetSelect, request);
			targetSelect.addEventListener("change", () => {
				void this.#selectTarget(message, request, targetSelect);
			});
		}

		for (const button of card.querySelectorAll("[data-pending-attack-action]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				void this.#handleAction(
					message,
					request,
					button.dataset.pendingAttackAction,
					button,
				);
			});
		}

		const dropZone = card.querySelector("[data-pending-attack-drop]");
		if (dropZone && game.user?.isGM) {
			dropZone.addEventListener("dragover", (event) => {
				event.preventDefault();
				dropZone.classList.add("is-dragover");
			});
			dropZone.addEventListener("dragleave", () =>
				dropZone.classList.remove("is-dragover"));
			dropZone.addEventListener("drop", (event) => {
				event.preventDefault();
				dropZone.classList.remove("is-dragover");
				void this.#handleDrop(message, request, event);
			});
		}
	}

	static async #selectTarget(message, request, select) {
		try {
			assertCanResolve(ActorTargetResolver.actorFromUuidSync(request.actorUuid));
			const value = String(select.value ?? "");
			if (value === TARGET_SELECTION_PENDING) {
				await this.#setSelection(message, request, emptySelection());
				return;
			}
			if (value === TARGET_SELECTION_NONE) {
				await this.#setSelection(message, request, {
					targetMode: COMBAT_ATTACK_TARGET_MODE.NONE,
					targetUuid: "",
					targetName: localize("No defender / object", "Bez obrońcy / obiekt"),
				});
				return;
			}

			const target = ActorTargetResolver.actorFromUuidSync(value);
			if (!target) {
				await this.#setSelection(message, request, emptySelection());
				return;
			}
			await this.#setSelection(message, request, {
				targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(
					select.selectedOptions?.[0]?.textContent ?? target.name ?? "",
				),
			});
		} catch (error) {
			reportError(error);
		}
	}

	static async #handleAction(message, request, action, button) {
		try {
			assertCanResolve(ActorTargetResolver.actorFromUuidSync(request.actorUuid));

			if (action === "roll") {
				if (button instanceof HTMLButtonElement) button.disabled = true;
				await this.#executeSelected(message, request);
				return;
			}
			if (action === "clear-target") {
				await this.#setSelection(message, request, emptySelection());
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
				throw new Error(`Unknown pending ranged attack action '${String(action)}'.`);
			}

			if (!target) return;
			await this.#setSelection(message, request, {
				targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
				targetUuid: String(target.uuid ?? ""),
				targetName: String(target.name ?? ""),
			});
		} catch (error) {
			reportError(error);
			if (button instanceof HTMLButtonElement && button.isConnected) {
				button.disabled = false;
			}
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
		assertSources(actor, weapon);

		const updated = foundry.utils.deepClone(request);
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

		const actor = await ActorTargetResolver.fromUuid(request.actorUuid);
		const weapon = await ActorTargetResolver.fromUuid(request.weaponUuid);
		assertSources(actor, weapon);

		const result = await CombatRangedAttackResolution.execute(
			actor,
			weapon,
			request.configuration ?? {},
			{ targetMode, target },
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
			title: localize("Pending ranged attack", "Oczekujący atak dystansowy"),
			targetLabel: localize("Target", "Cel"),
			pendingLabel: targetResolved
				? String(selection.targetName || "—")
				: localize("Not selected", "Nie wybrano"),
			targetResolved,
			visibleTokenLabel: localize("Target", "Cel"),
			dropPrompt: localize(
				"GM: drop Actor from sidebar",
				"MG: upuść Aktora z panelu bocznego",
			),
			useCurrentTargetLabel: localize(
				"Use current target",
				"Użyj aktualnego celu",
			),
			clearTargetLabel: localize("Clear", "Usuń cel"),
			chooseActorLabel: localize("Choose Actor", "Wybierz Aktora"),
			rollLabel: localize("Roll", "Rzuć"),
			waitingGmLabel: localize(
				"Waiting for the attacker owner or GM to confirm the target and fire.",
				"Oczekiwanie na właściciela atakującego albo MG, aby potwierdzić cel i oddać strzał.",
			),
		};
	}
}

Hooks.on("renderChatMessageHTML", (message, html) => {
	PendingRangedCombatAttack.activateListeners(message, html);
});

function populateTargetChoices(select, request) {
	select.replaceChildren();
	appendOption(
		select,
		TARGET_SELECTION_PENDING,
		localize("Choose target…", "Wybierz cel…"),
	);
	appendOption(
		select,
		TARGET_SELECTION_NONE,
		localize("No defender / object", "Bez obrońcy / obiekt"),
	);

	for (const entry of ActorTargetResolver.sceneTokenTargets()) {
		appendOption(select, entry.actorUuid, entry.name);
	}

	const selection = request?.selection ?? {};
	const mode = String(selection.targetMode ?? "pending");
	if (mode === COMBAT_ATTACK_TARGET_MODE.NONE) {
		select.value = TARGET_SELECTION_NONE;
		return;
	}
	if (mode !== COMBAT_ATTACK_TARGET_MODE.DEFENDER) {
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

function emptySelection() {
	return { targetMode: "pending", targetUuid: "", targetName: "" };
}

function serializeConfiguration(configuration = {}) {
	const modifier = Number(configuration.modifier ?? 0);
	if (!Number.isFinite(modifier)) {
		throw new Error("Pending ranged attack modifier must be finite.");
	}
	const distance = Number(configuration.distance ?? 0);
	if (!Number.isFinite(distance) || distance < 0) {
		throw new Error("Pending ranged attack distance must be non-negative.");
	}
	const manualDamageModifier = Number(configuration.manualDamageModifier ?? 0);
	if (!Number.isFinite(manualDamageModifier)) {
		throw new Error("Pending ranged damage modifier must be finite.");
	}
	return {
		modifier,
		resultVisibility: normalizeTestResultVisibility(configuration.resultVisibility),
		ruleEffects: Array.isArray(configuration.ruleEffects)
			? configuration.ruleEffects.map((entry) => ({
				...entry,
				source: { ...(entry?.source ?? {}) },
			}))
			: [],
		automaticRangeEffects: configuration.automaticRangeEffects === true,
		distance,
		manualDamageModifier,
	};
}

function assertSources(actor, weapon) {
	if (actor?.documentName !== "Actor") {
		throw new Error("The attacking Actor is no longer available.");
	}
	if (weapon?.documentName !== "Item" || weapon.type !== "weapon") {
		throw new Error("The attacking ranged Weapon is no longer available.");
	}
	if (weapon.parent?.uuid !== actor.uuid || weapon.system?.kind !== WEAPON_KIND.RANGED) {
		throw new Error("The pending ranged attack source is no longer valid.");
	}
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
	return actor.testUserPermission?.(
		user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to resolve pending ranged attack.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to resolve the pending ranged attack.",
		"Nie udało się rozstrzygnąć oczekującego ataku dystansowego.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
