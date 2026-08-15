import { DamageApplication } from "./DamageApplication.mjs";
import { DamagePacket } from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "damageState";
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/damage-result.hbs";

/**
 * Chat integration for already-resolved WFRP damage.
 *
 * A ChatMessage stores the immutable packet/resolution snapshot. The target
 * Actor stores the authoritative application transaction because the target
 * owner may be allowed to apply damage without owning the originating message.
 * When possible, the transaction is mirrored back into the ChatMessage flag.
 */
export class DamageChat {
	static VERSION = 1;

	/**
	 * Publish a standalone damage result card.
	 *
	 * @param {Object} input
	 * @returns {Promise<ChatMessage>}
	 */
	static async publish({
		packet,
		resolution,
		speakerActor = null,
	} = {}) {
		const normalizedPacket = normalizePacket(packet);
		const normalizedResolution = normalizeResolution(resolution);
		validatePair(normalizedPacket, normalizedResolution);

		const targetActor = await foundry.utils.fromUuid(
			normalizedPacket.targetActorUuid,
		);
		const state = this._state(
			normalizedPacket,
			normalizedResolution,
			"standalone",
			targetActor instanceof foundry.documents.Actor
				? targetActor.name
				: null,
		);
		const transaction = targetActor instanceof foundry.documents.Actor
			? DamageApplication.transactionFor(
				targetActor,
				normalizedPacket.id,
			)
			: null;
		state.application = transaction;

		const content = await this._render(
			state,
			targetActor,
			transaction,
		);

		return ChatMessage.create({
			speaker: speakerActor instanceof foundry.documents.Actor
				? ChatMessage.getSpeaker({ actor: speakerActor })
				: ChatMessage.getSpeaker(),
			content,
			flags: {
				[FLAG_SCOPE]: {
					[FLAG_KEY]: state,
				},
			},
		});
	}

	/**
	 * Attach damage semantics to an existing result ChatMessage without
	 * replacing its content. Future attack/movement/spell cards can use this to
	 * gain the shared context-menu Apply Damage action.
	 *
	 * @param {ChatMessage} message
	 * @param {Object} input
	 * @returns {Promise<ChatMessage|undefined>}
	 */
	static async attach(message, { packet, resolution } = {}) {
		if (!(message instanceof foundry.documents.ChatMessage)) {
			throw new Error("DamageChat.attach requires a ChatMessage.");
		}

		const normalizedPacket = normalizePacket(packet);
		const normalizedResolution = normalizeResolution(resolution);
		validatePair(normalizedPacket, normalizedResolution);

		const targetActor = await foundry.utils.fromUuid(
			normalizedPacket.targetActorUuid,
		);
		const state = this._state(
			normalizedPacket,
			normalizedResolution,
			"attached",
			targetActor instanceof foundry.documents.Actor
				? targetActor.name
				: null,
		);

		if (targetActor instanceof foundry.documents.Actor) {
			state.application = DamageApplication.transactionFor(
				targetActor,
				normalizedPacket.id,
			);
		}

		return message.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: state,
		});
	}

	/**
	 * Add the shared Apply Damage action to Foundry's ChatMessage context menu.
	 *
	 * The current user must be a GM or OWNER of the packet target, and the same
	 * packet must not already have an applied Actor transaction.
	 *
	 * @param {Array<Object>} menuItems
	 */
	static addContextMenuOptions(menuItems) {
		if (!Array.isArray(menuItems)) {
			return;
		}

		menuItems.push({
			name: localize(
				"WFRP1ED.Damage.Apply",
				"Apply Damage",
				"Zastosuj obrażenia",
			),
			icon: '<i class="fa-solid fa-heart-crack"></i>',
			condition: (target) => {
				const message = this._messageFromContextTarget(target);
				return this.canApplyMessage(message);
			},
			callback: (target) => {
				const message = this._messageFromContextTarget(target);

				if (message) {
					void this.applyMessage(message);
				}
			},
		});
	}

	/**
	 * Whether the current user may apply one damage-bearing message.
	 *
	 * @param {ChatMessage|null} message
	 * @param {User} user
	 * @returns {boolean}
	 */
	static canApplyMessage(message, user = game.user) {
		const state = this._stateFromMessage(message);

		if (!state) {
			return false;
		}

		const actor = this._targetActorSync(state);

		if (!(actor instanceof foundry.documents.Actor)) {
			return false;
		}

		if (DamageApplication.isApplied(actor, state.packet.id)) {
			return false;
		}

		return DamageApplication.canApply(actor, user);
	}

	/**
	 * Apply one damage-bearing ChatMessage to its target Actor.
	 *
	 * @param {ChatMessage} message
	 * @returns {Promise<Object|null>}
	 */
	static async applyMessage(message) {
		try {
			const state = this._stateFromMessage(message);

			if (!state) {
				throw new Error(
					"This ChatMessage does not contain WFRP damage data.",
				);
			}

			const packet = DamagePacket.fromJSON(state.packet);
			const resolution = DamageResolution.fromJSON(state.resolution);
			const targetActor = await foundry.utils.fromUuid(
				packet.targetActorUuid,
			);

			if (!(targetActor instanceof foundry.documents.Actor)) {
				throw new Error(
					`Damage target '${packet.targetActorUuid}' is not available.`,
				);
			}

			/*
			 * The Actor transaction is authoritative. A chat button can survive one
			 * render frame after another client applies the packet; treating that
			 * harmless stale click as an error confuses players and creates a noisy
			 * console. Reconcile presentation and return the existing transaction.
			 */
			const existing = DamageApplication.transactionFor(targetActor, packet.id);
			if (existing?.state === "applied") {
				this.refreshActorCards(targetActor);
				requestChatRefresh();
				return foundry.utils.deepFreeze(
					foundry.utils.deepClone(existing),
				);
			}

			const transaction = await DamageApplication.apply({
				packet,
				resolution,
				targetActor,
			});

			await this._mirrorApplication(
				message,
				state,
				targetActor,
				transaction,
			);
			this.refreshActorCards(targetActor);
			this.refreshVisibleMessage(message);
			requestChatRefresh();

			ui.notifications.info(
				localize(
					"WFRP1ED.Damage.AppliedNotice",
					`Applied ${transaction.amountApplied} damage to ${targetActor.name}.`,
					`Zastosowano ${transaction.amountApplied} obrażeń: ${targetActor.name}.`,
				),
			);

			return transaction;
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to apply damage from ChatMessage.",
				error,
			);
			ui.notifications.error(
				error?.message ??
					localize(
						"WFRP1ED.Damage.ApplyFailed",
						"Unable to apply damage.",
						"Nie można zastosować obrażeń.",
					),
			);

			return null;
		}
	}

	/**
	 * Update the rendered standalone card from the authoritative Actor record.
	 * Attached result cards keep their own content and only gain the context
	 * action.
	 *
	 * @param {ChatMessage} message
	 * @param {HTMLElement|Object} html
	 */
	static applyClientState(message, html) {
		const state = this._stateFromMessage(message);

		if (!state || state.presentation !== "standalone") {
			return;
		}

		const root = asElement(html);
		const card = root?.matches?.("[data-wfrp-damage-card]")
			? root
			: root?.querySelector?.("[data-wfrp-damage-card]");

		if (!card) {
			return;
		}

		const actor = this._targetActorSync(state);
		const transaction = actor instanceof foundry.documents.Actor
			? DamageApplication.transactionFor(actor, state.packet.id)
			: state.application ?? null;
		const status = card.querySelector?.("[data-wfrp-damage-status]");

		if (!status) {
			return;
		}

		status.textContent = this._statusLabel(
			state,
			actor,
			transaction,
		);
		card.classList.toggle(
			"is-applied",
			transaction?.state === "applied",
		);
	}

	/**
	 * Repaint visible damage cards which target an Actor after that Actor is
	 * updated on any connected client.
	 *
	 * @param {Actor} actor
	 */
	static refreshActorCards(actor) {
		if (!(actor instanceof foundry.documents.Actor)) {
			return;
		}

		for (const message of game.messages ?? []) {
			const state = this._stateFromMessage(message);

			if (state?.packet?.targetActorUuid !== actor.uuid) {
				continue;
			}

			this.refreshVisibleMessage(message);
		}
	}

	/** @param {ChatMessage} message */
	static refreshVisibleMessage(message) {
		if (!message?.id) {
			return;
		}

		const entry = document.querySelector(
			`[data-message-id="${message.id}"]`,
		);

		if (entry) {
			this.applyClientState(message, entry);
		}
	}

	static _state(packet, resolution, presentation, targetName) {
		return {
			version: DamageChat.VERSION,
			presentation,
			packet: packet.toJSON(),
			resolution: resolution.toJSON(),
			targetName: targetName ? String(targetName) : null,
			application: null,
			createdBy: game.user?.id ?? "",
			createdAt: Date.now(),
		};
	}

	static _stateFromMessage(message) {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);

		if (!state || typeof state !== "object" || Array.isArray(state)) {
			return null;
		}

		if (!state.packet || !state.resolution) {
			return null;
		}

		return state;
	}

	static _targetActorSync(state) {
		try {
			const actor = foundry.utils.fromUuidSync(
				String(state?.packet?.targetActorUuid ?? ""),
			);

			return actor instanceof foundry.documents.Actor
				? actor
				: null;
		} catch (_error) {
			return null;
		}
	}

	static async _mirrorApplication(
		message,
		state,
		targetActor,
		transaction,
	) {
		if (!message?.canUserModify?.(game.user, "update")) {
			return;
		}

		const updated = foundry.utils.deepClone(state);
		updated.application = foundry.utils.deepClone(transaction);
		updated.updatedBy = game.user?.id ?? "";
		updated.updatedAt = Date.now();
		const changes = {
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		};

		if (updated.presentation === "standalone") {
			changes.content = await this._render(
				updated,
				targetActor,
				transaction,
			);
		}

		await message.update(changes);
	}

	static async _render(state, actor, transaction) {
		return foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			this._templateContext(state, actor, transaction),
		);
	}

	static _templateContext(state, actor, transaction) {
		const packet = state.packet;
		const resolution = state.resolution;
		const targetName = actor?.name ?? state.targetName ?? packet.targetActorUuid;
		const armourPolicy = packet?.mitigation?.armour;
		const toughnessPolicy = packet?.mitigation?.toughness;

		return {
			packet,
			resolution,
			targetName,
			sourceLabel: packet?.source?.label || packet?.source?.id || "—",
			hitLocation: packet?.hitLocation ?? null,
			showRawAmount: Number(packet?.rawAmount) !== Number(resolution?.finalAmount),
			applied: transaction?.state === "applied",
			statusLabel: this._statusLabel(state, actor, transaction),
			labels: {
				title: localize("WFRP1ED.Damage.Title", "Damage", "Obrażenia"),
				target: localize("WFRP1ED.Damage.Target", "Target", "Cel"),
				source: localize("WFRP1ED.Damage.Source", "Source", "Źródło"),
				raw: localize("WFRP1ED.Damage.Raw", "Raw damage", "Obrażenia bazowe"),
				final: localize("WFRP1ED.Damage.Final", "Damage", "Obrażenia"),
				armour: localize("WFRP1ED.Damage.Armour", "Armour", "Pancerz"),
				toughness: localize("WFRP1ED.Damage.Toughness", "Toughness", "Wytrzymałość"),
				hitLocation: localize("WFRP1ED.Damage.HitLocation", "Hit location", "Lokacja trafienia"),
				armourPolicy: mitigationLabel(armourPolicy),
				toughnessPolicy: mitigationLabel(toughnessPolicy),
				contextHint: localize(
					"WFRP1ED.Damage.ContextHint",
					"Right-click this message to apply damage.",
					"Kliknij wiadomość prawym przyciskiem, aby zastosować obrażenia.",
				),
			},
		};
	}

	static _statusLabel(state, actor, transaction) {
		if (transaction?.state === "applied") {
			return localize(
				"WFRP1ED.Damage.AppliedStatus",
				`Applied ${transaction.amountApplied} · Wounds ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
				`Zastosowano ${transaction.amountApplied} · Żywotność ${transaction.woundsBefore} → ${transaction.woundsAfter}`,
			);
		}

		if (actor instanceof foundry.documents.Actor && this.canApplyMessageState(state, actor)) {
			return localize(
				"WFRP1ED.Damage.ReadyStatus",
				"Ready to apply",
				"Gotowe do zastosowania",
			);
		}

		return localize(
			"WFRP1ED.Damage.PendingStatus",
			"Awaiting application",
			"Oczekuje na zastosowanie",
		);
	}

	static canApplyMessageState(state, actor, user = game.user) {
		if (!state || !(actor instanceof foundry.documents.Actor)) {
			return false;
		}

		if (DamageApplication.isApplied(actor, state.packet.id)) {
			return false;
		}

		return DamageApplication.canApply(actor, user);
	}

	static _messageFromContextTarget(target) {
		const element = target instanceof HTMLElement
			? target
			: target?.[0] instanceof HTMLElement
				? target[0]
				: null;
		const entry = element?.closest?.("[data-message-id]") ?? element;
		const messageId = String(
			entry?.dataset?.messageId ??
				target?.attr?.("data-message-id") ??
				target?.data?.("message-id") ??
				"",
		).trim();

		return messageId
			? game.messages?.get(messageId) ?? null
			: null;
	}
}

function requestChatRefresh() {
	requestAnimationFrame(() => {
		void ui.chat?.render?.({ force: true });
	});
}

function normalizePacket(packet) {
	return packet instanceof DamagePacket
		? packet
		: DamagePacket.fromJSON(packet);
}

function normalizeResolution(resolution) {
	return resolution instanceof DamageResolution
		? resolution
		: DamageResolution.fromJSON(resolution);
}

function validatePair(packet, resolution) {
	if (
		resolution.packetId !== packet.id ||
		resolution.targetActorUuid !== packet.targetActorUuid ||
		resolution.rawAmount !== packet.rawAmount
	) {
		throw new Error(
			"Damage packet and resolution do not describe the same result.",
		);
	}
}

function mitigationLabel(policy) {
	return policy === "ignore"
		? localize("WFRP1ED.Damage.Ignore", "ignored", "pomijany")
		: localize("WFRP1ED.Damage.ApplyMitigation", "applies", "uwzględniany");
}

function asElement(html) {
	if (html instanceof HTMLElement) {
		return html;
	}

	if (html?.[0] instanceof HTMLElement) {
		return html[0];
	}

	return null;
}

function localize(key, englishFallback, polishFallback) {
	const localized = game.i18n.localize(key);

	if (localized !== key) {
		return localized;
	}

	return game.i18n.lang === "pl"
		? polishFallback
		: englishFallback;
}
