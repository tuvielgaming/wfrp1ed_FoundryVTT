import { TestResultChat } from "../tests/TestResultChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "combatDefenceResult";

/**
 * Attach defence-specific context to the generic WS / Initiative Test card.
 *
 * The generic Test remains authoritative for the d100, modifiers, manual roll
 * edits and success/failure. This layer only explains why that Test was rolled
 * and which incoming attack it belongs to.
 */
export class CombatDefenceResultChat {
	static async attach(message, defenceState) {
		if (!message?.id) {
			throw new Error("Combat defence result requires a ChatMessage.");
		}

		const state = foundry.utils.deepClone(defenceState ?? {});
		state.version = Number(state.version) || 1;
		state.updatedBy = game.user?.id ?? "";
		state.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, FLAG_KEY, state);
		return message;
	}

	static activateListeners(message, html) {
		const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
		if (!state) return;

		const rendered = TestResultChat._asElement(html);
		const card = rendered?.matches?.(".wfrp1e-test-card")
			? rendered
			: rendered?.querySelector?.(".wfrp1e-test-card");
		if (!card || card.querySelector("[data-wfrp-combat-defence-result]")) {
			return;
		}

		const panel = document.createElement("section");
		panel.classList.add("wfrp1e-combat-defence-result");
		panel.dataset.wfrpCombatDefenceResult = "";

		const heading = document.createElement("div");
		heading.classList.add("combat-defence-result__heading");
		const title = document.createElement("strong");
		title.textContent = responseLabel(state.response);
		const attack = document.createElement("span");
		attack.textContent = [state.attackerName, state.weaponName]
			.filter(Boolean)
			.join(" — ");
		heading.append(title, attack);
		panel.append(heading);

		if (state.response === "parry") {
			panel.append(
				row(
					localize("Parry item", "Przedmiot do parowania"),
					state.itemName ?? "—",
				),
				row(
					localize("Parry modifier", "Modyfikator parowania"),
					signed(state.parryBonus ?? 0),
				),
			);

			if (Number(state.attackCost ?? 0) > 0) {
				panel.append(
					row(
						localize("Attack cost", "Koszt Ataków"),
						String(state.attackCost),
					),
				);
			}

			if (Number(state.parryDebtAdded ?? 0) > 0) {
				panel.append(
					row(
						localize("Parry debt added", "Dodany dług za parowanie"),
						String(state.parryDebtAdded),
					),
				);
			}
		}

		if (state.response === "dodge" && state.managedByCombat === true) {
			panel.append(
				row(
					localize("Round resource", "Zasób rundy"),
					localize("Dodge Blow attempt spent", "Wykorzystano próbę Uniku"),
				),
			);
		}

		const header = card.querySelector(".wfrp1e-test-card__header");
		if (header?.parentElement === card) {
			header.insertAdjacentElement("afterend", panel);
		} else {
			card.prepend(panel);
		}
	}
}

function row(labelText, value) {
	const element = document.createElement("div");
	element.classList.add("combat-defence-result__row");
	const label = document.createElement("span");
	label.textContent = labelText;
	const strong = document.createElement("strong");
	strong.textContent = String(value ?? "—");
	element.append(label, strong);
	return element;
}

function responseLabel(response) {
	return response === "dodge"
		? localize("Dodge Blow", "Uniki")
		: localize("Parry", "Parowanie");
}

function signed(value) {
	const numeric = Number(value);
	const finite = Number.isFinite(numeric) ? numeric : 0;
	return finite >= 0 ? `+${finite}` : String(finite);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
