import { normalizeTestResultVisibility } from "../tests/TestResultVisibility.mjs";
import { ActorTargetResolver } from "../targets/ActorTargetResolver.mjs";
import {
	COMBAT_ATTACK_TARGET_MODE,
	CombatAttackResolution,
} from "./CombatAttackResolution.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "pendingCombatAttack";
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/pending-combat-attack.hbs";

/**
 * Defer a configured melee attack until a GM resolves its defender context.
 *
 * This mirrors the established PendingStandardTest UX: current canvas target,
 * world Actor chooser, and Actor/Token drag-and-drop. Combat additionally
 * offers an explicit No defender / object mode for doors, obstacles and other
 * cases where a defending Actor is intentionally absent.
 *
 * No Attack is spent while this card is pending.
 */
export class PendingCombatAttack {
	static async create(actor, weapon, configuration) {
		if (!actor?.uuid || !weapon?.uuid) {
			throw new Error("Pending combat attack requires Actor and Weapon UUIDs.");
		}

		const request = {
			version: 1,
			status: "pending",
			actorUuid: actor.uuid,
			weaponUuid: weapon.uuid,
			configuration: serializeConfiguration(configuration),
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};

		const content = await foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			this.#templateContext(actor, weapon),
		);

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content,
			flags: {
				[FLAG_SCOPE]: {
					[FLAG_KEY]: request,
				},
			},
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

		const controls = card.querySelector("[data-pending-attack-gm-controls]");
		const waiting = card.querySelector("[data-pending-attack-player-status]");

		if (!game.user?.isGM) {
			if (controls) controls.hidden = true;
			if (waiting) waiting.hidden = false;
			return;
		}

		if (controls) controls.hidden = false;
		if (waiting) waiting.hidden = true;

		for (const button of card.querySelectorAll("[data-pending-attack-action]")) {
			button.addEventListener("click", (event) => {
				event.preventDefault();
				void this.#handleAction(
					message,
					request,
					button.dataset.pendingAttackAction,
				);
			});
		}

		const dropZone = card.querySelector("[data-pending-attack-drop]");
		if (dropZone) {
			dropZone.addEventListener("dragover", (event) => {
				event.preventDefault();
				dropZone.classList.add("is-dragover");
			});
			dropZone.addEventListener("dragleave", () => {
				dropZone.classList.remove("is-dragover");
			});
			dropZone.addEventListener("drop", (event) => {
				event.preventDefault();
				dropZone.classList.remove("is-dragover");
				void this.#handleDrop(message, request, event);
			});
		}
	}

	static async #handleAction(message, request, action) {
		try {
			switch (action) {
				case "current-target": {
					const target = ActorTargetResolver.singleTargetActor();
					if (!target) {
						ui.notifications.warn(localize(
							"Target exactly one token on the canvas first.",
							"Najpierw wskaż dokładnie jeden token na mapie.",
						));
						return;
					}
					await this.#execute(message, request, {
						targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
						target,
					});
					return;
				}
				case "choose-actor": {
					const target = await ActorTargetResolver.chooseActor();
					if (!target) return;
					await this.#execute(message, request, {
						targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
						target,
					});
					return;
				}
				case "no-defender": {
					await this.#execute(message, request, {
						targetMode: COMBAT_ATTACK_TARGET_MODE.NONE,
						target: null,
					});
					return;
				}
				default:
					throw new Error(`Unknown pending attack action '${String(action)}'.`);
			}
		} catch (error) {
			reportError(error);
		}
	}

	static async #handleDrop(message, request, event) {
		try {
			const target = await ActorTargetResolver.actorFromDropEvent(event);
			if (!target) {
				throw new Error(localize(
					"Drop an Actor or a Token with an Actor here.",
					"Upuść tutaj Aktora albo token powiązany z Aktorem.",
				));
			}
			await this.#execute(message, request, {
				targetMode: COMBAT_ATTACK_TARGET_MODE.DEFENDER,
				target,
			});
		} catch (error) {
			reportError(error);
		}
	}

	static async #execute(message, request, resolution) {
		const actor = await ActorTargetResolver.fromUuid(request.actorUuid);
		const weapon = await ActorTargetResolver.fromUuid(request.weaponUuid);

		if (actor?.documentName !== "Actor") {
			throw new Error("The attacking Actor is no longer available.");
		}
		if (weapon?.type !== "weapon") {
			throw new Error("The attacking Weapon is no longer available.");
		}

		const result = await CombatAttackResolution.execute(
			actor,
			weapon,
			request.configuration ?? {},
			resolution,
		);

		if (result) await message.delete();
		return result;
	}

	static #templateContext(actor, weapon) {
		return {
			actorName: actor.name,
			weaponName: weapon.name,
			title: localize("Pending melee attack", "Oczekujący atak wręcz"),
			targetLabel: localize("Target", "Cel"),
			pendingLabel: localize(
				"Waiting for defender context",
				"Oczekuje na wybór obrońcy",
			),
			dropPrompt: localize(
				"Drop an Actor or Token here",
				"Upuść tutaj Aktora lub token",
			),
			useCurrentTargetLabel: localize(
				"Use current target",
				"Użyj aktualnego celu",
			),
			chooseActorLabel: localize("Choose Actor", "Wybierz Aktora"),
			noDefenderLabel: localize(
				"No defender / object",
				"Bez obrońcy / obiekt",
			),
			waitingGmLabel: localize(
				"Waiting for the GM to resolve the attack target.",
				"Oczekiwanie na MG, który rozstrzygnie cel ataku.",
			),
		};
	}
}

function serializeConfiguration(configuration = {}) {
	const modifier = Number(configuration.modifier ?? 0);
	if (!Number.isFinite(modifier)) {
		throw new Error("Pending attack modifier must be finite.");
	}

	return {
		modifier,
		resultVisibility: normalizeTestResultVisibility(
			configuration.resultVisibility,
		),
		ruleEffects: Array.isArray(configuration.ruleEffects)
			? configuration.ruleEffects.map((entry) => ({
				...entry,
				source: { ...(entry?.source ?? {}) },
			}))
			: [],
		automaticRangeEffects: configuration.automaticRangeEffects === true,
		distance: Number(configuration.distance ?? 0) || 0,
		manualDamageModifier: Number(configuration.manualDamageModifier ?? 0) || 0,
	};
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to resolve pending combat attack.", error);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to resolve the pending combat attack.",
			"Nie udało się rozstrzygnąć oczekującego ataku.",
		),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
