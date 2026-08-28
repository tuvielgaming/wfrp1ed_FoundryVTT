const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "coreCastingFailure";
const activeEdits = new Set();
let installed = false;

/**
 * WFRP 1e Core casting-failure check.
 *
 * Core rule: when Current Magic Points before casting are below 12, roll 2D6.
 * The spell takes effect when the total is <= Current MP. The spell cost is not
 * owned by this workflow: callers still spend it whether this check succeeds or
 * fails, because spell procedures know their actual cost.
 *
 * The result is stored as an ordinary ChatMessage transaction rather than only
 * as an animation. Both d6 values remain editable for later GM adjudication.
 */
export class CoreCastingFailureWorkflow {
	static install() {
		if (installed) return;
		installed = true;
		Hooks.on("renderChatMessageHTML", (message, html) => {
			requestAnimationFrame(() => decorate(message, html));
		});
	}

	static async resolve({ actor, spell, currentMagicPoints, spellCost, castId = "" } = {}) {
		if (!(actor instanceof foundry.documents.Actor)) {
			throw new Error("Core casting failure requires a caster Actor.");
		}
		const current = integerAtLeast(currentMagicPoints, 0, "Current Magic Points");
		const cost = integerAtLeast(spellCost, 0, "Spell cost");

		if (current >= 12) {
			return Object.freeze({
				required: false,
				success: true,
				total: null,
				dice: Object.freeze([]),
				messageId: null,
			});
		}

		const roll = await new Roll("2d6").evaluate({ allowInteractive: false });
		await showRollAnimation(roll);
		const dice = dieResults(roll);
		const total = dice.reduce((sum, value) => sum + value, 0);
		const state = {
			version: 1,
			castId: String(castId ?? ""),
			actorUuid: String(actor.uuid),
			actorName: String(actor.name ?? ""),
			spellUuid: String(spell?.uuid ?? ""),
			spellName: String(spell?.name ?? localize("Spell", "Czar")),
			currentMagicPoints: current,
			spellCost: cost,
			dice,
			originalDice: [...dice],
			total,
			success: total <= current,
			createdBy: String(game.user?.id ?? ""),
			createdAt: Date.now(),
		};

		const message = await ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor }),
			content: '<section class="wfrp1ed wfrp-core-casting-failure" data-wfrp-core-casting-failure></section>',
			flags: { [FLAG_SCOPE]: { [FLAG_KEY]: state } },
		});

		return Object.freeze({
			required: true,
			success: state.success,
			total: state.total,
			dice: Object.freeze([...state.dice]),
			messageId: String(message?.id ?? ""),
		});
	}
}

function decorate(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, FLAG_KEY);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-core-casting-failure]")
		? root
		: root?.querySelector?.("[data-wfrp-core-casting-failure]");
	if (!(panel instanceof HTMLElement)) return;
	panel.replaceChildren();
	panel.classList.add("wfrp1e-damage-card");

	const header = document.createElement("header");
	header.className = "wfrp1e-damage-card__header";
	const title = document.createElement("strong");
	title.textContent = localize(
		`Casting — ${state.spellName}`,
		`Rzucanie czaru — ${state.spellName}`,
	);
	const outcome = document.createElement("strong");
	outcome.textContent = state.success
		? localize("Success", "Sukces")
		: localize("Failure", "Porażka");
	outcome.style.whiteSpace = "nowrap";
	header.append(title, outcome);
	panel.append(header);

	panel.append(row(localize("Current Magic Points", "Aktualne Punkty Magii"), String(state.currentMagicPoints)));
	panel.append(row(localize("Spell cost", "Koszt czaru"), String(state.spellCost)));

	const rollRow = document.createElement("div");
	rollRow.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = localize("Casting roll", "Rzut czaru");
	const editor = document.createElement("span");
	editor.className = "wfrp1e-damage-roll";
	const editable = canEdit(message);

	for (let index = 0; index < 2; index += 1) {
		if (index > 0) {
			const plus = document.createElement("span");
			plus.className = "wfrp1e-damage-roll__operator";
			plus.textContent = "+";
			editor.append(plus);
		}
		editor.append(d6Badge(state.dice[index]));
		const equals = document.createElement("span");
		equals.className = "wfrp1e-damage-roll__operator";
		equals.textContent = "=";
		editor.append(equals);
		const input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "6";
		input.step = "1";
		input.value = String(state.dice[index]);
		input.className = "wfrp1e-damage-roll__total";
		input.dataset.wfrpCastingDie = String(index);
		input.readOnly = !editable;
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") input.blur();
		});
		input.addEventListener("change", () => {
			void adjudicateDie(message, index, input.value).catch(reportError);
		});
		editor.append(input);
	}
	rollRow.append(label, editor);
	panel.append(rollRow);
	panel.append(row(localize("Total", "Suma"), `${state.total} / ${state.currentMagicPoints}`));

	const note = document.createElement("div");
	note.className = "combat-damage-context__status";
	note.textContent = state.success
		? localize(
			"2D6 is not greater than Current Magic Points — the spell may take effect.",
			"2K6 nie przekracza Aktualnych Punktów Magii — czar może zadziałać.",
		)
		: localize(
			"2D6 exceeds Current Magic Points — the spell fails, but its Magic Point cost is still spent.",
			"2K6 przekracza Aktualne Punkty Magii — czar nie działa, ale jego koszt w Punktach Magii nadal zostaje wydany.",
		);
	panel.append(note);
}

async function adjudicateDie(message, index, rawValue) {
	if (!canEdit(message)) {
		throw new Error(localize("You may not edit this casting roll.", "Nie możesz zmienić tego rzutu czaru."));
	}
	const key = String(message?.id ?? "");
	if (!key || activeEdits.has(key)) return;
	const value = Number(rawValue);
	if (!isD6(value)) {
		ui.notifications.warn(localize(
			"Each casting die must be an integer from 1 to 6.",
			"Każda kość rzutu czaru musi być liczbą całkowitą od 1 do 6.",
		));
		void ui.chat?.render?.({ force: true });
		return;
	}

	activeEdits.add(key);
	try {
		const current = foundry.utils.deepClone(message.getFlag?.(FLAG_SCOPE, FLAG_KEY) ?? {});
		const dice = Array.isArray(current.dice) ? [...current.dice] : [];
		while (dice.length < 2) dice.push(1);
		dice[index] = value;
		const total = dice.reduce((sum, die) => sum + Number(die), 0);
		current.dice = dice;
		current.total = total;
		current.success = total <= Number(current.currentMagicPoints);
		current.adjudicated = dice.some((die, dieIndex) => Number(die) !== Number(current.originalDice?.[dieIndex]));
		current.adjudicatedBy = current.adjudicated ? String(game.user?.id ?? "") : null;
		current.adjudicatedAt = current.adjudicated ? Date.now() : null;
		current.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, FLAG_KEY, current);
	} finally {
		activeEdits.delete(key);
	}
}

function row(labelText, valueText) {
	const element = document.createElement("div");
	element.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = valueText;
	element.append(label, value);
	return element;
}

function d6Badge(value) {
	const number = Math.min(6, Math.max(1, Number(value) || 1));
	const names = ["one", "two", "three", "four", "five", "six"];
	const badge = document.createElement("i");
	badge.className = `fa-solid fa-dice-${names[number - 1]} wfrp1e-damage-die`;
	badge.title = `d6: ${number}`;
	badge.setAttribute("aria-label", `d6: ${number}`);
	return badge;
}

function dieResults(roll) {
	const term = roll?.dice?.find?.((candidate) => Number(candidate?.faces) === 6) ?? roll?.dice?.[0];
	const values = (term?.results ?? []).map((result) => Number(result?.result)).filter(isD6);
	if (values.length !== 2) throw new Error("Casting failure roll did not produce two d6 results.");
	return values;
}

async function showRollAnimation(roll) {
	if (!roll || typeof game.dice3d?.showForRoll !== "function") return;
	try {
		await game.dice3d.showForRoll(roll, game.user, true);
	} catch (_error) {
		/* Dice animation is presentation-only. */
	}
}

function canEdit(message) {
	return game.user?.isGM === true || message?.isAuthor === true;
}

function isD6(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 6;
}

function integerAtLeast(value, minimum, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum) {
		throw new Error(`${label} must be an integer greater than or equal to ${minimum}.`);
	}
	return number;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to adjudicate Core casting failure roll.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to change the casting roll.",
		"Nie udało się zmienić rzutu czaru.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

CoreCastingFailureWorkflow.install();
