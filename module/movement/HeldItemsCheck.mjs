const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "heldItemsCheck";
const VERSION = 2;
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/held-items-check.hbs";

const SOCKET_CHANNEL = "system.wfrp1ed";
const ROLL_REQUEST_TYPE = "held-items-roll-edit-request";
const ROLL_RESPONSE_TYPE = "held-items-roll-edit-response";
const SOCKET_TIMEOUT_MS = 10000;
const pendingRollRequests = new Map();

const CONSEQUENCE_KIND = "drop-held-items";
const CONSEQUENCE_APPLIED = "applied";

export const HELD_ITEMS_LUCK_ROLL_ID = "consequence.heldItems.check";

/**
 * Separate consequence roll used after a Jump/Fall which caused Wounds.
 *
 * The Core rule is intentionally resolved as its own ChatMessage instead of
 * being embedded in the movement roll. This keeps the dependency explicit:
 * the movement result is finalized first, then the 50% held-items consequence
 * is rolled, and Luck may modify that d100 independently.
 *
 * Manual-dice policy:
 * every visible random roll must be replaceable by the GM or an OWNER of the
 * represented Actor so a table may roll physical dice and enter the real result.
 * The native Foundry Roll remains attached as the immutable audit roll while
 * this persisted snapshot becomes the adjudicated result used by mechanics.
 *
 * A roll becomes read-only only after an irreversible external consequence has
 * actually been applied. HeldItemsLootIntegration deliberately keeps a failed
 * check pending until the user explicitly resolves the physical Item drop, so a
 * physical d100 can always be entered first.
 */
export class HeldItemsCheck {
	static async publish({ actor, sourceMessage } = {}) {
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error(
				"Held-items check requires an Actor.",
			);
		}

		if (!(sourceMessage instanceof foundry.documents.ChatMessage)) {
			throw new Error(
				"Held-items check requires its source movement ChatMessage.",
			);
		}

		const roll = await new Roll("1d100").evaluate({
			allowInteractive: false,
		});
		const total = this._normalizedD100(
			roll.total,
			"held-items roll",
		);
		const state = this._state({
			actor,
			sourceMessage,
			roll: total,
		});
		const content = await this._render(state);

		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content,
			rolls: [roll],
			flags: {
				[FLAG_SCOPE]: {
					[FLAG_KEY]: state,
				},
			},
		});
	}

	static stateFor(message) {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		return state &&
			typeof state === "object" &&
			!Array.isArray(state)
			? state
			: null;
	}

	/**
	 * Expose the concrete d100 to the generic Luck subsystem.
	 *
	 * Only +10 is useful here: 01-50 means drop everything held, while 51-100
	 * means retain it. Repeated uses are deliberately allowed while the result
	 * is still in the unfavourable half of the table.
	 */
	static luckOptions(message) {
		const state = this.stateFor(message);
		if (!state || this._outcome(state.roll) !== "drop") {
			return [];
		}

		return [
			Object.freeze({
				id: HELD_ITEMS_LUCK_ROLL_ID,
				die: "d100",
				delta: 10,
				value: this._finiteNumber(
					state.roll,
					"held-items roll",
				),
				label: this._localize(
					"WFRP1ED.Luck.Roll.HeldItems",
					"Held-items d100",
					"K100 utrzymania przedmiotów",
				),
				blocksAfterDamage: false,
			}),
		];
	}

	static async applyLuck(message, rollId, delta) {
		const state = this.stateFor(message);
		const option = this.luckOptions(message).find(
			(entry) =>
				entry.id === String(rollId ?? "") &&
				entry.delta === Number(delta),
		);

		if (!state || !option) {
			throw new Error(
				"This held-items roll cannot be adjusted by Luck.",
			);
		}

		if (this._rollEditLockReason(state)) {
			throw new Error(this._rollEditLockReason(state));
		}

		const updated = foundry.utils.deepClone(state);
		const originalRoll = this._finiteNumber(
			updated.roll,
			"held-items roll",
		);
		const adjustedRoll = originalRoll + Number(delta);

		updated.roll = adjustedRoll;
		updated.outcome = this._outcome(adjustedRoll);
		updated.consequence = updated.outcome === "drop"
			? (updated.consequence ?? this._consequence(updated.outcome))
			: null;
		updated.updatedBy = String(game.user?.id ?? "");
		updated.updatedAt = Date.now();

		const content = await this._render(updated);
		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});

		return Object.freeze({
			rollId: HELD_ITEMS_LUCK_ROLL_ID,
			originalRoll,
			adjustedRoll,
			delta: Number(delta),
		});
	}

	/**
	 * GM-authoritative manual/physical-dice replacement of the adjudicated d100.
	 * Actor owners send their request through the system socket to the primary
	 * active GM, matching the authority model of generic TestResult roll editing.
	 */
	static async commitRollValue(message, value, requestingUser) {
		if (!game.user?.isGM) {
			throw new Error(
				"Held-items roll edits require GM authority.",
			);
		}

		const state = this.stateFor(message);
		if (!state) {
			throw new Error(
				"This chat message has no editable held-items snapshot.",
			);
		}
		if (!this.canEditRoll(message, requestingUser)) {
			throw new Error(this._rollEditDeniedMessage(state));
		}

		const normalized = this._normalizedD100(value, "held-items roll");
		const updated = foundry.utils.deepClone(state);
		const original = this._originalRoll(state);
		const previousOutcome = this._outcome(updated.roll);
		const nextOutcome = this._outcome(normalized);

		updated.version = Math.max(VERSION, Number(updated.version) || 0);
		updated.originalRoll = original;
		updated.roll = normalized;
		updated.outcome = nextOutcome;

		if (nextOutcome === "retain") {
			updated.consequence = null;
		} else if (previousOutcome !== "drop" || !updated.consequence) {
			updated.consequence = this._consequence(nextOutcome);
		}

		updated.rollEdited = normalized !== original;
		updated.rollEditedBy = updated.rollEdited
			? String(requestingUser?.id ?? "")
			: "";
		updated.rollEditedAt = updated.rollEdited ? Date.now() : null;
		updated.updatedBy = String(
			requestingUser?.id ?? game.user?.id ?? "",
		);
		updated.updatedAt = Date.now();

		const content = await this._render(updated);
		await message.update({
			content,
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: updated,
		});

		return Object.freeze({
			messageId: String(message.id ?? ""),
			roll: normalized,
			originalRoll: original,
			rollEdited: updated.rollEdited,
		});
	}

	static canEditRoll(message, user = game.user) {
		const state = this.stateFor(message);
		if (!state || !user) return false;
		if (this._rollEditLockReason(state)) return false;
		if (user.isGM) return true;

		const actor = this._actorForStateSync(state);
		return actor?.testUserPermission?.(
			user,
			CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
		) === true;
	}

	/**
	 * Localize persisted HTML independently for every connected client.
	 */
	static applyClientLocalization(message, html) {
		const state = this.stateFor(message);
		if (!state) return;

		const root = this._asElement(html);
		const card = root?.matches?.("[data-wfrp-held-items-card]")
			? root
			: root?.querySelector?.("[data-wfrp-held-items-card]");
		if (!card) return;

		const data = this._presentation(state);
		card.classList.toggle("is-success", data.success);
		card.classList.toggle("is-failure", !data.success);

		this._setText(card, "[data-held-items-title]", data.title);
		this._setText(card, "[data-held-items-rule]", data.rule);
		this._setText(card, "[data-held-items-roll-label]", data.rollLabel);
		this._setText(card, "[data-held-items-roll-value]", data.roll);
		this._setText(card, "[data-held-items-outcome]", data.outcomeLabel);
	}

	static activateRollEditor(message, html) {
		const state = this.stateFor(message);
		if (!state) return;

		const root = this._asElement(html);
		const card = root?.matches?.("[data-wfrp-held-items-card]")
			? root
			: root?.querySelector?.("[data-wfrp-held-items-card]");
		if (!(card instanceof HTMLElement)) return;

		let input = card.querySelector(
			"input[data-held-items-roll-value]",
		);
		if (!(input instanceof HTMLInputElement)) {
			const value = card.querySelector("[data-held-items-roll-value]");
			if (!(value instanceof HTMLElement)) return;

			input = document.createElement("input");
			input.type = "number";
			input.min = "1";
			input.max = "100";
			input.step = "1";
			input.inputMode = "numeric";
			input.autocomplete = "off";
			input.value = String(state.roll ?? value.textContent ?? "");
			input.dataset.heldItemsRollValue = "";
			input.classList.add("wfrp1e-test-card__modifier-input");
			value.replaceWith(input);
		}

		const lockReason = this._rollEditLockReason(state);
		if (lockReason || !this.canEditRoll(message, game.user)) {
			input.readOnly = true;
			input.tabIndex = -1;
			input.classList.remove("is-editable");
			input.classList.add("is-readonly");
			input.title = lockReason || this._localize(
				"WFRP1ED.Movement.HeldItemsRollReadOnly",
				"Only the GM or an OWNER of this Actor can replace the d100 result.",
				"Tylko MG albo Właściciel tego Aktora może zmienić wynik K100.",
			);
			return;
		}

		input.readOnly = false;
		input.classList.remove("is-readonly");
		input.classList.add("is-editable");
		input.title = this._localize(
			"WFRP1ED.Movement.HeldItemsRollEdit",
			"Enter a d100 result from 1 to 100, then press Enter or leave the field. This supports physical dice and recalculates the held-items outcome without rerolling.",
			"Wprowadź wynik K100 od 1 do 100, a następnie naciśnij Enter lub opuść pole. Umożliwia to używanie fizycznych kości i przelicza wynik utrzymania przedmiotów bez ponownego rzutu.",
		);

		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			input.blur();
		});

		input.addEventListener("change", () => {
			void this._setRollValue(message, input);
		});
	}

	static async _setRollValue(message, input) {
		try {
			const state = this.stateFor(message);
			if (!state) {
				throw new Error(
					"This chat message has no editable held-items snapshot.",
				);
			}
			if (!this.canEditRoll(message, game.user)) {
				throw new Error(this._rollEditDeniedMessage(state));
			}

			const raw = String(input?.value ?? "").trim();
			const requested = Number(raw);
			if (
				!raw ||
				!Number.isFinite(requested) ||
				!Number.isInteger(requested)
			) {
				throw new Error(this._localize(
					"WFRP1ED.Movement.HeldItemsRollInvalid",
					"Enter a whole d100 result from 1 to 100.",
					"Wprowadź całkowity wynik K100 od 1 do 100.",
				));
			}

			const value = Math.min(100, Math.max(1, requested));
			if (value !== requested) {
				input.value = String(value);
				ui.notifications.warn(this._localize(
					"WFRP1ED.Movement.HeldItemsRollClamped",
					`A d100 result must be between 1 and 100. The value was set to ${value}.`,
					`Wynik K100 musi mieścić się w zakresie od 1 do 100. Wartość ustawiono na ${value}.`,
				));
			}

			if (game.user?.isGM) {
				await this.commitRollValue(message, value, game.user);
				return;
			}

			await this._requestOwnerRollEdit(message, value);
		} catch (error) {
			console.error(
				"WFRP1ED | Unable to edit held-items d100.",
				error,
			);
			const current = this.stateFor(message);
			if (input) input.value = String(current?.roll ?? "");
			ui.notifications.error(
				error?.message ??
					"Unable to change the held-items d100 result.",
			);
		}
	}

	static async _requestOwnerRollEdit(message, value) {
		if (!this.canEditRoll(message, game.user)) {
			throw new Error(
				this._rollEditDeniedMessage(this.stateFor(message)),
			);
		}

		const gm = this._primaryActiveGM();
		if (!gm) {
			throw new Error(this._localize(
				"WFRP1ED.Movement.HeldItemsRollNeedsGM",
				"A GM must be connected to save an Actor owner's manual d100 result.",
				"MG musi być połączony, aby zapisać ręczny wynik K100 wprowadzony przez właściciela Aktora.",
			));
		}

		const requestId = foundry.utils.randomID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRollRequests.delete(requestId);
				reject(new Error(
					"Held-items roll edit request timed out.",
				));
			}, SOCKET_TIMEOUT_MS);

			pendingRollRequests.set(requestId, {
				resolve,
				reject,
				timeout,
			});
			game.socket.emit(SOCKET_CHANNEL, {
				type: ROLL_REQUEST_TYPE,
				requestId,
				requestUserId: String(game.user?.id ?? ""),
				messageId: String(message?.id ?? ""),
				roll: this._normalizedD100(value, "held-items roll"),
			});
		});
	}

	static registerSocket() {
		game.socket.on(SOCKET_CHANNEL, async (payload) => {
			if (!payload || typeof payload !== "object") return;

			if (payload.type === ROLL_RESPONSE_TYPE) {
				this._handleRollResponse(payload);
				return;
			}

			if (payload.type !== ROLL_REQUEST_TYPE) return;
			if (
				!game.user?.isGM ||
				this._primaryActiveGM()?.id !== game.user.id
			) return;

			const response = {
				type: ROLL_RESPONSE_TYPE,
				requestId: String(payload.requestId ?? ""),
				requestUserId: String(payload.requestUserId ?? ""),
			};

			try {
				const message = game.messages?.get(
					String(payload.messageId ?? ""),
				);
				const user = game.users?.get(
					String(payload.requestUserId ?? ""),
				);
				if (!message) {
					throw new Error(
						"Requested held-items ChatMessage is not available.",
					);
				}
				if (!user?.active) {
					throw new Error("Requesting user is not active.");
				}

				response.result = await this.commitRollValue(
					message,
					payload.roll,
					user,
				);
			} catch (error) {
				response.error = error instanceof Error
					? error.message
					: String(error);
			}

			game.socket.emit(SOCKET_CHANNEL, response);
		});
	}

	static _handleRollResponse(payload) {
		if (
			String(payload.requestUserId ?? "") !==
			String(game.user?.id ?? "")
		) return;

		const requestId = String(payload.requestId ?? "");
		const pending = pendingRollRequests.get(requestId);
		if (!pending) return;

		clearTimeout(pending.timeout);
		pendingRollRequests.delete(requestId);

		if (payload.error) {
			pending.reject(new Error(String(payload.error)));
			return;
		}
		pending.resolve(Object.freeze({ ...(payload.result ?? {}) }));
	}

	static _state({ actor, sourceMessage, roll }) {
		const outcome = this._outcome(roll);
		return {
			version: VERSION,
			actorUuid: actor.uuid,
			sourceMessageId: sourceMessage.id,
			originalRoll: roll,
			roll,
			rollEdited: false,
			rollEditedBy: "",
			rollEditedAt: null,
			outcome,
			consequence: this._consequence(outcome),
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
			updatedBy: String(game.user?.id ?? ""),
			updatedAt: Date.now(),
		};
	}

	static _consequence(outcome) {
		return outcome === "drop"
			? {
				kind: CONSEQUENCE_KIND,
				state: "pending",
			}
			: null;
	}

	static _outcome(roll) {
		return this._finiteNumber(roll, "held-items roll") <= 50
			? "drop"
			: "retain";
	}

	static _presentation(state) {
		const outcome = this._outcome(state.roll);
		return {
			title: this._localize(
				"WFRP1ED.Movement.HeldItemsTitle",
				"Held-items check",
				"Test utrzymania przedmiotów",
			),
			rule: this._localize(
				"WFRP1ED.Movement.HeldItemsRule",
				"01-50: drop everything held · 51-100: retain held items",
				"01-50: upuszcza wszystko · 51-100: utrzymuje trzymane przedmioty",
			),
			rollLabel: game.i18n.lang === "pl" ? "K100" : "d100",
			roll: this._finiteNumber(state.roll, "held-items roll"),
			outcome,
			outcomeLabel: outcome === "drop"
				? this._localize(
					"WFRP1ED.Movement.DropOutcomeShort",
					"DROPS HELD ITEMS",
					"UPUSZCZA",
				)
				: this._localize(
					"WFRP1ED.Movement.RetainOutcomeShort",
					"RETAINS HELD ITEMS",
					"UTRZYMUJE",
				),
			success: outcome === "retain",
		};
	}

	static async _render(state) {
		return foundry.applications.handlebars.renderTemplate(
			TEMPLATE_PATH,
			this._presentation(state),
		);
	}

	static _setText(root, selector, value) {
		const element = root?.querySelector?.(selector);
		if (element instanceof HTMLInputElement) {
			element.value = String(value ?? "");
			return;
		}
		if (element) element.textContent = String(value ?? "");
	}

	static _rollEditLockReason(state) {
		return state?.consequence?.kind === CONSEQUENCE_KIND &&
			state?.consequence?.state === CONSEQUENCE_APPLIED
			? this._localize(
				"WFRP1ED.Movement.HeldItemsRollAppliedLock",
				"The physical held-item drop has already been applied. Return or invalidate that world-state consequence before changing this d100 result.",
				"Fizyczne upuszczenie trzymanych przedmiotów zostało już zastosowane. Przed zmianą wyniku K100 trzeba najpierw cofnąć lub unieważnić tę zmianę stanu świata.",
			)
			: "";
	}

	static _rollEditDeniedMessage(state) {
		return this._rollEditLockReason(state) || this._localize(
			"WFRP1ED.Movement.HeldItemsRollEditDenied",
			"Only the GM or an OWNER of this Actor can change the d100 result.",
			"Tylko MG albo Właściciel tego Aktora może zmienić wynik K100.",
		);
	}

	static _actorForStateSync(state) {
		try {
			const actor = foundry.utils.fromUuidSync(
				String(state?.actorUuid ?? "").trim(),
			);
			return actor instanceof foundry.documents.Actor ? actor : null;
		} catch (_error) {
			return null;
		}
	}

	static _originalRoll(state) {
		return this._normalizedD100(
			state?.originalRoll ?? state?.roll,
			"original held-items roll",
		);
	}

	static _normalizedD100(value, label) {
		const number = this._finiteNumber(value, label);
		if (!Number.isInteger(number)) {
			throw new Error(
				`Held-items '${label}' must be a whole d100 value: ${String(value)}.`,
			);
		}
		return Math.min(100, Math.max(1, number));
	}

	static _finiteNumber(value, label) {
		const number = Number(value);
		if (!Number.isFinite(number)) {
			throw new Error(
				`Held-items '${label}' must be finite: ${String(value)}.`,
			);
		}
		return number;
	}

	static _primaryActiveGM() {
		return [...(game.users ?? [])]
			.filter((user) => user.active && user.isGM)
			.sort((first, second) =>
				String(first.id).localeCompare(String(second.id)),
			)[0] ?? null;
	}

	static _asElement(html) {
		if (html instanceof HTMLElement) return html;
		if (html?.[0] instanceof HTMLElement) return html[0];
		return null;
	}

	static _localize(key, englishFallback, polishFallback) {
		const localized = game.i18n.localize(key);
		if (localized !== key) return localized;
		return game.i18n.lang === "pl"
			? polishFallback
			: englishFallback;
	}
}

Hooks.once("ready", () => {
	HeldItemsCheck.registerSocket();
});

Hooks.on("renderChatMessageHTML", (message, html) => {
	HeldItemsCheck.applyClientLocalization(message, html);
	HeldItemsCheck.activateRollEditor(message, html);
});