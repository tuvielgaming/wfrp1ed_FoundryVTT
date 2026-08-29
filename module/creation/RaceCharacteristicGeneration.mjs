import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

const CHARACTERISTICS = Object.freeze([
	"m", "ws", "bs", "s", "t", "w", "i", "a",
	"dex", "ld", "int", "cl", "wp", "fel",
]);

installRaceCharacteristicGeneration();

/**
 * Character Creation Mode integration for the WFRP 1e racial starting profile.
 *
 * The Character may still type any starting Characteristic manually. When a
 * Race Item is embedded, this integration adds a small dice action to every
 * initial Characteristic cell and an all-profile dice action in the row label.
 * Rolling writes only `system.characteristics.<id>.initial`; the Race formula
 * remains a generation instruction, never a permanent modifier.
 *
 * Evaluated rolls are also passed to Dice So Nice when available. Animation is
 * presentation only: the exact already-evaluated Roll drives both the displayed
 * dice and the value persisted on the Actor, so animation can never reroll the
 * Characteristic or alter the mechanical result.
 *
 * The same evaluated Roll is logged to chat after the Actor update. Chat cards
 * deliberately do not attach Foundry Roll objects, because Dice So Nice already
 * received the authoritative Roll explicitly and attaching it to ChatMessage
 * would risk a second animation.
 */
function installRaceCharacteristicGeneration() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		if (!(root instanceof HTMLElement)) return;
		const sheet = root.classList?.contains("wfrp1ed-classic-sheet")
			? root
			: root.querySelector?.(".wfrp1ed-classic-sheet");
		if (!(sheet instanceof HTMLElement)) return;

		installRollControls(actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const root = asElement(actor.sheet?.element);
			const sheet = root?.querySelector?.(".wfrp1ed-classic-sheet") ??
				(root?.classList?.contains("wfrp1ed-classic-sheet") ? root : null);
			if (sheet instanceof HTMLElement) installRollControls(actor, sheet);
		});
	}
}

function installRollControls(actor, sheet) {
	const race = embeddedRace(actor);
	const profile = race?.system?.profile ?? null;
	const initialRow = sheet.querySelector('[data-characteristic-row="initial"]');
	if (!(initialRow instanceof HTMLElement)) return;

	for (const old of initialRow.querySelectorAll(".wfrp1ed-race-characteristic-roll")) old.remove();
	initialRow.querySelector(".wfrp1ed-race-profile-roll-all")?.remove?.();

	if (!race || !profile) return;

	const rowLabel = initialRow.querySelector(".characteristics-row-label");
	if (rowLabel instanceof HTMLElement) {
		const rollAll = document.createElement("button");
		rollAll.type = "button";
		rollAll.className = "wfrp1ed-race-profile-roll-all";
		rollAll.innerHTML = '<i class="fa-solid fa-dice"></i>';
		rollAll.title = localize(
			`Roll all starting Characteristics from ${race.name}`,
			`Rzuć wszystkie Cechy początkowe według rasy ${race.name}`,
		);
		rollAll.setAttribute("aria-label", rollAll.title);
		rollAll.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void rollAllCharacteristics(actor, race).catch(reportError);
		});
		rowLabel.append(rollAll);
	}

	for (const id of CHARACTERISTICS) {
		const cell = initialRow.querySelector(`.characteristic-cell--initial[data-characteristic="${id}"]`);
		if (!(cell instanceof HTMLElement)) continue;

		const formula = String(profile?.[id] ?? "").trim();
		if (!formula) continue;

		cell.classList.add("wfrp1ed-race-generation-cell");
		const button = document.createElement("button");
		button.type = "button";
		button.className = "wfrp1ed-race-characteristic-roll";
		button.dataset.characteristic = id;
		button.innerHTML = '<i class="fa-solid fa-dice-d6"></i>';
		button.title = localize(
			`Roll ${formula} from Race: ${race.name}`,
			`Rzuć ${formula} według rasy: ${race.name}`,
		);
		button.setAttribute("aria-label", button.title);
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			void rollCharacteristic(actor, race, id).catch(reportError);
		});
		cell.append(button);
	}
}

async function rollCharacteristic(actor, race, id) {
	const formula = raceFormula(race, id);
	if (!formula) return;

	const resolved = await evaluateFormula(formula, id);
	await animateResolvedRoll(resolved.roll);
	await actor.update({
		[`system.characteristics.${id}.initial`]: resolved.value,
	});
	await createSingleGenerationMessage(actor, race, id, formula, resolved);
}

async function rollAllCharacteristics(actor, race) {
	const updates = {};
	const entries = [];

	for (const id of CHARACTERISTICS) {
		const formula = raceFormula(race, id);
		if (!formula) continue;

		const resolved = await evaluateFormula(formula, id);
		updates[`system.characteristics.${id}.initial`] = resolved.value;
		entries.push({ id, formula, resolved });
	}

	if (!Object.keys(updates).length) {
		ui.notifications.warn(localize(
			"The assigned Race has no starting Characteristic formulas.",
			"Przypisana Rasa nie ma formuł początkowych Cech.",
		));
		return;
	}

	/* Roll-all means one generation action. Let Dice So Nice display all of the
	 * already-resolved characteristic rolls together rather than forcing the
	 * player through fourteen sequential animation waits. */
	await Promise.all(entries.map(({ resolved }) => animateResolvedRoll(resolved.roll)));
	await actor.update(updates);
	await createAllGenerationMessage(actor, race, entries);
}

async function evaluateFormula(formula, id) {
	try {
		const roll = await (new Roll(formula)).evaluate({
			allowInteractive: false,
		});
		const total = Number(roll.total);
		if (!Number.isFinite(total)) {
			throw new Error(`Non-numeric result for ${formula}`);
		}
		return {
			roll,
			value: Math.trunc(total),
			rolled: rolledDiceTotal(roll),
		};
	} catch (error) {
		throw new Error(localize(
			`Invalid Race formula for ${id.toUpperCase()}: ${formula}`,
			`Błędna formuła Rasy dla ${id.toUpperCase()}: ${formula}`,
		), { cause: error });
	}
}

async function createSingleGenerationMessage(actor, race, id, formula, resolved) {
	const content = `
		<section class="wfrp1e-race-generation-card">
			<h3 class="wfrp1e-race-generation-card__title">${escapeHtml(generationTitle())}</h3>
			${generationDetailRows(id, formula, resolved)}
		</section>
	`;
	await createGenerationChatMessage(actor, race, content);
}

async function createAllGenerationMessage(actor, race, entries) {
	const details = entries.map(({ id, formula, resolved }) => {
		const abbreviation = characteristicAbbreviation(id);
		return `
			<details class="wfrp1e-race-generation-card__entry">
				<summary>
					<span>${escapeHtml(abbreviation)}</span>
					<strong>${escapeHtml(String(resolved.value))}</strong>
				</summary>
				<div class="wfrp1e-race-generation-card__entry-body">
					${generationDetailRows(id, formula, resolved)}
				</div>
			</details>
		`;
	}).join("");

	const content = `
		<section class="wfrp1e-race-generation-card wfrp1e-race-generation-card--all">
			<h3 class="wfrp1e-race-generation-card__title">${escapeHtml(generationTitle())}</h3>
			<div class="wfrp1e-race-generation-card__entries">${details}</div>
		</section>
	`;
	await createGenerationChatMessage(actor, race, content);
}

async function createGenerationChatMessage(actor, race, content) {
	try {
		const speaker = ChatMessage.getSpeaker?.({ actor }) ?? {
			actor: actor?.id ?? null,
			alias: actor?.name ?? game.user?.name ?? "",
		};
		await ChatMessage.create({
			speaker,
			content,
			flags: {
				wfrp1ed: {
					raceCharacteristicGeneration: {
						actorUuid: actor?.uuid ?? null,
						raceUuid: race?.uuid ?? null,
					},
				},
			},
		});
	} catch (error) {
		/* Chat logging is audit/presentation and must never undo generated values. */
		console.error(
			"WFRP1ED | Unable to create Race characteristic generation chat card.",
			error,
		);
		ui.notifications.warn(localize(
			"The Characteristic was generated, but its chat card could not be created.",
			"Charakterystyka została wylosowana, ale nie udało się utworzyć jej karty na czacie.",
		));
	}
}

function generationDetailRows(id, formula, resolved) {
	return [
		generationRow(localize("Target", "Cel"), characteristicAbbreviation(id)),
		generationRow(localize("Formula", "Formuła"), formula),
		generationRow(localize("Roll", "Rzut"), resolved.rolled),
		generationRow(localize("Final value", "Wartość końcowa"), resolved.value, true),
	].join("");
}

function generationRow(label, value, final = false) {
	return `
		<div class="wfrp1e-race-generation-card__row${final ? " wfrp1e-race-generation-card__row--final" : ""}">
			<span>${escapeHtml(String(label))}</span>
			<strong>${escapeHtml(String(value))}</strong>
		</div>
	`;
}

function generationTitle() {
	return localize(
		"Starting Characteristic Generation",
		"Losowanie Charakterystyk Początkowych ",
	);
}

function characteristicAbbreviation(id) {
	const key = `WFRP1ed.CHARAbbrev.${id === "m" ? "sp" : id}`;
	const translated = game.i18n.localize(key);
	return translated && translated !== key ? translated : String(id).toUpperCase();
}

function rolledDiceTotal(roll) {
	const dice = Array.isArray(roll?.dice) ? roll.dice : [];
	const values = dice.flatMap((term) =>
		(term?.results ?? [])
			.filter((result) => result?.active !== false)
			.map((result) => Number(result.result))
			.filter(Number.isFinite),
	);
	if (!values.length) return "—";
	return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Display the authoritative evaluated Roll through the same Dice So Nice API
 * already used elsewhere in the system. No ChatMessage is created by Dice So
 * Nice here; chat logging is handled separately from the same resolved Roll.
 *
 * Dice So Nice has no ordinary d2/d3 mesh in the standard Roll path. WFRP 1e
 * uses those dice in racial profiles, so a roll containing only d2/d3 dice is
 * represented visually by d6s whose faces encode the already-resolved result.
 * The Actor still receives the true d2/d3 total from the original Roll.
 */
async function animateResolvedRoll(roll) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;
	if (!Array.isArray(roll?.dice) || roll.dice.length === 0) return;

	try {
		const visualRoll = await visualRollForUnsupportedSmallDice(roll);
		await dice3d.showForRoll(
			visualRoll ?? roll,
			game.user,
			true,
			[],
			false,
		);
	} catch (error) {
		/* Dice animation is optional presentation and must never block creation. */
		console.error(
			"WFRP1ED | Unable to display Race characteristic dice animation.",
			error,
		);
	}
}

async function visualRollForUnsupportedSmallDice(roll) {
	const dice = Array.isArray(roll?.dice) ? roll.dice : [];
	if (!dice.length) return null;
	if (!dice.every((term) => [2, 3].includes(Number(term?.faces)))) return null;

	const originalResults = dice.flatMap((term) =>
		(term?.results ?? [])
			.filter((result) => result?.active !== false)
			.map((result) => ({
				faces: Number(term.faces),
				value: Number(result.result),
			})),
	);
	if (!originalResults.length) return null;

	const visualRoll = await new Roll(`${originalResults.length}d6`).evaluate({
		allowInteractive: false,
	});
	const visualResults = visualRoll.dice?.[0]?.results ?? [];
	if (visualResults.length < originalResults.length) return null;

	for (let index = 0; index < originalResults.length; index += 1) {
		const original = originalResults[index];
		const visual = visualResults[index];
		if (!visual) continue;

		/* d3 uses the same 1-2/3-4/5-6 convention already used by the system's
		 * Risk consequence animation. d2 uses 1-3/4-6; choose the first face of
		 * each range so the animation deterministically represents the true roll. */
		visual.result = original.faces === 3
			? (original.value * 2) - 1
			: (original.value === 1 ? 1 : 4);
	}

	return visualRoll;
}

function raceFormula(race, id) {
	return String(race?.system?.profile?.[id] ?? "").trim();
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ??
		actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function reportError(error) {
	console.error("WFRP1ED | Race characteristic generation failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
