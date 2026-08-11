const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "heldItemsCheck";
const VERSION = 1;
const TEMPLATE_PATH =
	"systems/wfrp1ed/templates/chat/held-items-check.hbs";

export const HELD_ITEMS_LUCK_ROLL_ID = "consequence.heldItems.check";

/**
 * Separate consequence roll used after a Jump/Fall which caused Wounds.
 *
 * The Core rule is intentionally resolved as its own ChatMessage instead of
 * being embedded in the movement roll. This keeps the dependency explicit:
 * the movement result is finalized first, then the 50% held-items consequence
 * is rolled, and Luck may modify that d100 independently.
 *
 * Polish note: wynik "upuszcza" jest już osobnym kontraktem konsekwencji, ale
 * faktyczne odpinanie/przenoszenie Itemów zostanie dodane dopiero wtedy, gdy
 * ekwipunek będzie miał kanoniczny stan "trzymany/wyposażony".
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
		const total = this._finiteNumber(
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

		const updated = foundry.utils.deepClone(state);
		const originalRoll = this._finiteNumber(
			updated.roll,
			"held-items roll",
		);
		const adjustedRoll = originalRoll + Number(delta);

		updated.roll = adjustedRoll;
		updated.outcome = this._outcome(adjustedRoll);
		updated.consequence = this._consequence(updated.outcome);
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

	static _state({ actor, sourceMessage, roll }) {
		const outcome = this._outcome(roll);
		return {
			version: VERSION,
			actorUuid: actor.uuid,
			sourceMessageId: sourceMessage.id,
			roll,
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
				kind: "drop-held-items",
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
		if (element) element.textContent = String(value ?? "");
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

Hooks.on("renderChatMessageHTML", (message, html) => {
	HeldItemsCheck.applyClientLocalization(message, html);
});
