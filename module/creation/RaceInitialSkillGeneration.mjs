import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const GRANT_FLAG = "raceInitialSkillGrant";
const BASE_SKILL_COUNT_FORMULA = "1d4";
const MAX_TABLE_ATTEMPTS = 500;

installRaceInitialSkillGeneration();

/**
 * WFRP 1e starting-Skill generation owned by the embedded Race Item.
 *
 * Sequence:
 *  1. roll the core 1d4 number of initial Skills;
 *  2. apply the Race age-band modifier for the Actor's current age;
 *  3. resolve applicable mandatory racial Skill packages;
 *  4. fill remaining slots from the Race's d100 table for the selected
 *     Career Class, rerolling duplicate Skill identities.
 *
 * Generated Skills are ordinary embedded Skill Items. A narrow source flag is
 * used only so this generation action can be safely rerun without deleting
 * manually-added or Career-granted Skills.
 */
function installRaceInitialSkillGeneration() {
	Hooks.on("renderApplicationV2", (application, element) => {
		const actor = application?.document;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!CharacterCreationMode.enabled(actor)) return;

		const root = asElement(element) ?? asElement(application?.element);
		const sheet = classicSheetRoot(root);
		if (!(sheet instanceof HTMLElement)) return;
		installControl(actor, sheet);
	});

	for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (actor?.type !== "character" || !CharacterCreationMode.enabled(actor)) return;
			const sheet = classicSheetRoot(asElement(actor.sheet?.element));
			if (sheet instanceof HTMLElement) installControl(actor, sheet);
		});
	}
}

function installControl(actor, sheet) {
	const section = sheet.querySelector(".skills--primary");
	if (!(section instanceof HTMLElement)) return;
	section.querySelector(".wfrp1ed-race-initial-skills-roll")?.remove?.();

	const race = embeddedRace(actor);
	if (!race) return;

	const button = document.createElement("button");
	button.type = "button";
	button.className = "wfrp1ed-race-initial-skills-roll";
	button.innerHTML = '<i class="fa-solid fa-dice-d20" aria-hidden="true"></i>';
	button.title = localize(
		`Generate initial Skills from Race: ${race.name}`,
		`Wylosuj Umiejętności początkowe według rasy: ${race.name}`,
	);
	button.setAttribute("aria-label", button.title);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void generateInitialSkills(actor, race).catch(reportError);
	});
	section.append(button);
}

async function generateInitialSkills(actor, race) {
	const age = numericAge(actor);
	if (age === null) {
		throw new Error(localize(
			"Enter or roll the character's Age before generating initial Skills.",
			"Wpisz lub wylosuj Wiek postaci przed losowaniem Umiejętności początkowych.",
		));
	}

	const careerClass = canonicalClassId(actor.system?.details?.careerClass);
	if (!careerClass) {
		throw new Error(localize(
			"Select a Career Class before generating initial Skills.",
			"Wybierz Klasę Zawodową przed losowaniem Umiejętności początkowych.",
		));
	}

	const table = Array.isArray(race.system?.skillTables?.[careerClass])
		? race.system.skillTables[careerClass]
		: [];
	if (!table.length) {
		throw new Error(localize(
			`Race ${race.name} has no initial-Skill d100 table for ${careerClass}.`,
			`Rasa ${race.name} nie ma tabeli losowych Umiejętności początkowych dla klasy ${classLabel(careerClass)}.`,
		));
	}

	const previousGenerated = [...(actor.items ?? [])].filter((item) =>
		item?.type === "skill" && Boolean(item.getFlag?.(FLAG_SCOPE, GRANT_FLAG)),
	);
	const ignoredIds = new Set(previousGenerated.map((item) => String(item.id)));
	const usedIdentities = new Set(
		[...(actor.items ?? [])]
			.filter((item) => item?.type === "skill" && !ignoredIds.has(String(item.id)))
			.map(skillIdentityFromItem)
			.filter(Boolean),
	);

	const countRoll = await new Roll(BASE_SKILL_COUNT_FORMULA).evaluate({ allowInteractive: false });
	await showDice(countRoll);
	const baseCount = wholeNumber(countRoll.total, 0);
	const ageModifier = ageSkillModifier(race, age);
	const totalCount = Math.max(0, baseCount + ageModifier);

	const mandatoryResolution = await resolveMandatorySkills(race, totalCount, usedIdentities);
	const planned = [...mandatoryResolution.skills];
	if (planned.length > totalCount) {
		throw new Error(localize(
			`The Race's mandatory Skill rules grant ${planned.length} Skills, but this character has only ${totalCount} initial Skill slots.`,
			`Reguły obowiązkowych Umiejętności rasy przyznają ${planned.length} Umiejętności, ale postać ma tylko ${totalCount} miejsc na Umiejętności początkowe.`,
		));
	}

	const tableRolls = [];
	let attempts = 0;
	while (planned.length < totalCount) {
		attempts += 1;
		if (attempts > MAX_TABLE_ATTEMPTS) {
			throw new Error(localize(
				"Unable to complete initial Skill generation without duplicates. Check that the selected Race/Class table contains enough distinct Skills.",
				"Nie można ukończyć losowania Umiejętności początkowych bez duplikatów. Sprawdź, czy tabela wybranej Rasy/Klasy zawiera wystarczającą liczbę różnych Umiejętności.",
			));
		}

		const roll = await new Roll("1d100").evaluate({ allowInteractive: false });
		await showDice(roll);
		const result = wholeNumber(roll.total, 0);
		const row = table.find((candidate) =>
			result >= wholeNumber(candidate?.min, 1) && result <= wholeNumber(candidate?.max, 100),
		);
		if (!row?.grant) {
			throw new Error(localize(
				`The ${classLabel(careerClass)} initial-Skill table has no result for ${result}.`,
				`Tabela Umiejętności początkowych dla klasy ${classLabel(careerClass)} nie ma wyniku dla ${result}.`,
			));
		}

		const resolved = await resolveSkillReference(row.grant);
		const duplicate = !resolved.identity || usedIdentities.has(resolved.identity);
		tableRolls.push({ result, name: resolved.name, duplicate });
		if (duplicate) continue;

		usedIdentities.add(resolved.identity);
		planned.push({
			...resolved,
			origin: "random-table",
			tableRoll: result,
		});
	}

	const generationId = foundry.utils.randomID();
	const itemSources = planned.map((entry) => skillItemSource(entry, race, generationId));
	let created = [];
	try {
		created = itemSources.length
			? await actor.createEmbeddedDocuments("Item", itemSources)
			: [];
	} catch (error) {
		throw new Error(localize(
			"Foundry could not create the generated initial Skill Items.",
			"Foundry nie mógł utworzyć wylosowanych Umiejętności początkowych.",
		), { cause: error });
	}

	try {
		const oldIds = previousGenerated
			.filter((item) => actor.items?.has?.(item.id))
			.map((item) => item.id);
		if (oldIds.length) await actor.deleteEmbeddedDocuments("Item", oldIds);
	} catch (error) {
		const newIds = created.map((item) => item.id).filter(Boolean);
		if (newIds.length) await actor.deleteEmbeddedDocuments("Item", newIds).catch(() => {});
		throw error;
	}

	await createGenerationChatCard(actor, race, {
		age,
		careerClass,
		baseCount,
		ageModifier,
		totalCount,
		mandatory: mandatoryResolution.summary,
		tableRolls,
		skills: planned,
	});
	void actor.sheet?.render?.();
}

async function resolveMandatorySkills(race, totalCount, usedIdentities) {
	const entries = Array.isArray(race.system?.mandatorySkills) ? race.system.mandatorySkills : [];
	const skills = [];
	const summary = [];

	for (const entry of entries) {
		const minimum = Math.max(1, wholeNumber(entry?.minInitialSkills, 1));
		if (totalCount < minimum) continue;

		const choices = Array.isArray(entry?.choices) ? entry.choices : [];
		if (!choices.length) continue;
		const mode = String(entry?.mode ?? "all");
		const choose = Math.max(1, Math.min(choices.length, wholeNumber(entry?.choose, 1)));
		let selected = [];
		const selectionRolls = [];

		if (mode === "player-choice") {
			selected = await chooseMandatoryChoices(choices, choose);
		} else if (mode === "random-choice") {
			const pool = [...choices];
			for (let index = 0; index < choose && pool.length; index += 1) {
				if (pool.length === 1) {
					selected.push(pool.shift());
					continue;
				}
				const roll = await new Roll(`1d${pool.length}`).evaluate({ allowInteractive: false });
				await showDice(roll);
				const pickedIndex = Math.max(0, Math.min(pool.length - 1, wholeNumber(roll.total, 1) - 1));
				selectionRolls.push(wholeNumber(roll.total, 0));
				selected.push(pool.splice(pickedIndex, 1)[0]);
			}
		} else {
			selected = choices;
		}

		const selectedNames = [];
		for (const choice of selected) {
			for (const grant of choice?.grants ?? []) {
				const resolved = await resolveSkillReference(grant);
				if (!resolved.identity || usedIdentities.has(resolved.identity)) continue;
				usedIdentities.add(resolved.identity);
				skills.push({ ...resolved, origin: "mandatory" });
				selectedNames.push(resolved.name);
			}
		}
		summary.push({ minimum, mode, choose, names: selectedNames, selectionRolls });
	}
	return { skills, summary };
}

async function chooseMandatoryChoices(choices, choose) {
	const DialogV2 = foundry.applications?.api?.DialogV2;
	if (!DialogV2?.wait) throw new Error("Foundry DialogV2 is unavailable.");
	const type = choose === 1 ? "radio" : "checkbox";
	const group = `raceSkillChoice-${foundry.utils.randomID()}`;
	const rows = choices.map((choice, index) => `
		<label class="career-choice-dialog__option">
			<input type="${type}" name="${group}" value="${escapeHtml(String(choice?.id ?? index))}" ${choose === 1 && index === 0 ? "checked" : ""}>
			<span><strong>${escapeHtml(choiceLabel(choice))}</strong></span>
		</label>
	`).join("");
	const result = await DialogV2.wait({
		window: { title: localize("Racial Skill choice", "Wybór rasowych Umiejętności") },
		content: `<div class="wfrp1ed career-choice-dialog"><p>${escapeHtml(localize(
			`Choose exactly ${choose} Skill option${choose === 1 ? "" : "s"}.`,
			`Wybierz dokładnie ${choose} opcję/opcje Umiejętności.`,
		))}</p>${rows}</div>`,
		modal: true,
		rejectClose: false,
		render: (_event, dialog) => {
			const inputs = [...dialog.element.querySelectorAll(`input[name="${group}"]`)];
			const action = dialog.element.querySelector('button[data-action="choose"]');
			const sync = () => {
				const selectedCount = inputs.filter((input) => input.checked).length;
				if (type === "checkbox") {
					for (const input of inputs) input.disabled = selectedCount >= choose && !input.checked;
				}
				if (action instanceof HTMLButtonElement) action.disabled = selectedCount !== choose;
			};
			for (const input of inputs) input.addEventListener("change", sync);
			sync();
		},
		buttons: [{
			action: "choose",
			label: localize("Choose", "Wybierz"),
			default: true,
			callback: (_event, button) => [...button.form.querySelectorAll(`input[name="${group}"]:checked`)]
				.map((input) => String(input.value)),
		}],
	});
	if (!Array.isArray(result) || result.length !== choose) {
		throw new Error(localize("Initial Skill selection was cancelled.", "Anulowano wybór Umiejętności początkowych."));
	}
	return choices.filter((choice, index) => result.includes(String(choice?.id ?? index)));
}

async function resolveSkillReference(reference) {
	const uuid = String(reference?.uuid ?? "").trim();
	let source = null;
	if (uuid) {
		try { source = await foundry.utils.fromUuid(uuid); } catch (_error) { source = null; }
	}
	if (source && (!(source instanceof foundry.documents.Item) || source.type !== "skill")) {
		throw new Error(localize(
			`Referenced document '${reference?.name ?? uuid}' is not a Skill Item.`,
			`Powiązany dokument '${reference?.name ?? uuid}' nie jest Przedmiotem Umiejętności.`,
		));
	}

	const rulesId = String(reference?.rulesId ?? source?.system?.rulesId ?? "").trim();
	const specialisation = String(reference?.specialisation ?? source?.system?.specialisation ?? "").trim();
	const name = String(reference?.name ?? source?.name ?? localize("Initial Skill", "Umiejętność Początkowa")).trim();
	const identity = skillIdentity({ rulesId, specialisation, uuid, name });
	return { reference: foundry.utils.deepClone(reference ?? {}), source, rulesId, specialisation, name, identity };
}

function skillItemSource(entry, race, generationId) {
	let source;
	if (entry.source instanceof foundry.documents.Item && entry.source.type === "skill") {
		source = foundry.utils.deepClone(entry.source.toObject());
		delete source._id;
		delete source.folder;
		delete source.sort;
		delete source.ownership;
		delete source._stats;
	} else {
		source = {
			name: entry.name,
			type: "skill",
			system: { rulesId: "", description: "", specialisation: "" },
		};
	}
	source.name = entry.name || source.name;
	source.system ??= {};
	if (entry.rulesId) source.system.rulesId = entry.rulesId;
	if (entry.specialisation) source.system.specialisation = entry.specialisation;
	source.flags ??= {};
	source.flags[FLAG_SCOPE] ??= {};
	source.flags[FLAG_SCOPE][GRANT_FLAG] = {
		version: 1,
		generationId,
		raceItemId: String(race.id ?? ""),
		raceUuid: String(race.uuid ?? ""),
		origin: entry.origin,
		sourceUuid: String(entry.reference?.uuid ?? ""),
		createdAt: Date.now(),
	};
	return source;
}

function ageSkillModifier(race, age) {
	const bands = Array.isArray(race.system?.age?.skillCountModifiers)
		? race.system.age.skillCountModifiers
		: [];
	const match = bands.find((band) => age >= wholeNumber(band?.minAge, 0) && age <= wholeNumber(band?.maxAge, 0));
	return match ? integer(band.modifier, 0) : 0;
}

function numericAge(actor) {
	const value = Number.parseInt(String(actor.system?.details?.age ?? "").trim(), 10);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

function skillIdentityFromItem(item) {
	return skillIdentity({
		rulesId: item?.system?.rulesId,
		specialisation: item?.system?.specialisation,
		uuid: item?.uuid,
		name: item?.name,
	});
}

function skillIdentity({ rulesId, specialisation, uuid, name }) {
	const spec = normalize(specialisation);
	const rid = normalize(rulesId);
	if (rid) return `rules:${rid}::${spec}`;
	const stableUuid = String(uuid ?? "").trim();
	if (stableUuid) return `uuid:${stableUuid}::${spec}`;
	const normalizedName = normalize(name);
	return normalizedName ? `name:${normalizedName}::${spec}` : "";
}

function choiceLabel(choice) {
	const explicit = String(choice?.label ?? "").trim();
	if (explicit) return explicit;
	return (choice?.grants ?? []).map((grant) => String(grant?.name ?? "").trim()).filter(Boolean).join(" + ") || localize("Skill option", "Opcja Umiejętności");
}

async function showDice(roll) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;
	if (!Array.isArray(roll?.dice) || !roll.dice.length) return;
	try { await dice3d.showForRoll(roll, game.user, true, [], false); }
	catch (error) { console.error("WFRP1ED | Unable to display initial-Skill dice animation.", error); }
}

async function createGenerationChatCard(actor, race, data) {
	const mandatoryNames = data.skills.filter((entry) => entry.origin === "mandatory").map((entry) => entry.name);
	const randomNames = data.skills.filter((entry) => entry.origin === "random-table").map((entry) => entry.name);
	const rolls = data.tableRolls.map((entry) => `
		<li>${escapeHtml(String(entry.result))} → ${escapeHtml(entry.name)}${entry.duplicate ? ` <em>(${escapeHtml(localize("duplicate — reroll", "duplikat — przerzut"))})</em>` : ""}</li>
	`).join("");
	const content = `<section class="wfrp1e-race-generation-card">
		<h3 class="wfrp1e-race-generation-card__title">${escapeHtml(localize("Initial Skill Generation", "Losowanie Umiejętności Początkowych"))}</h3>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Race", "Rasa"))}</span><strong>${escapeHtml(race.name)}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Career Class", "Klasa Zawodowa"))}</span><strong>${escapeHtml(classLabel(data.careerClass))}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Age", "Wiek"))}</span><strong>${escapeHtml(String(data.age))}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Base roll", "Rzut bazowy"))}</span><strong>${escapeHtml(`${BASE_SKILL_COUNT_FORMULA} = ${data.baseCount}`)}</strong></div>
		<div class="wfrp1e-race-generation-card__row"><span>${escapeHtml(localize("Age modifier", "Modyfikator wieku"))}</span><strong>${escapeHtml(signed(data.ageModifier))}</strong></div>
		<div class="wfrp1e-race-generation-card__row wfrp1e-race-generation-card__row--final"><span>${escapeHtml(localize("Initial Skills", "Umiejętności początkowe"))}</span><strong>${escapeHtml(String(data.totalCount))}</strong></div>
		${mandatoryNames.length ? `<details><summary>${escapeHtml(localize("Mandatory racial Skills", "Obowiązkowe Umiejętności rasowe"))}: ${mandatoryNames.length}</summary><div>${mandatoryNames.map((name) => `<div>${escapeHtml(name)}</div>`).join("")}</div></details>` : ""}
		${randomNames.length ? `<details><summary>${escapeHtml(localize("Random initial Skills", "Losowe Umiejętności początkowe"))}: ${randomNames.length}</summary><div>${randomNames.map((name) => `<div>${escapeHtml(name)}</div>`).join("")}</div></details>` : ""}
		${rolls ? `<details><summary>${escapeHtml(localize("d100 roll details", "Szczegóły rzutów k100"))}</summary><ol>${rolls}</ol></details>` : ""}
	</section>`;
	await ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor }),
		content,
		flags: { wfrp1ed: { raceInitialSkillGeneration: { actorUuid: actor.uuid, raceUuid: race.uuid } } },
	});
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ?? actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function canonicalClassId(value) {
	const aliases = {
		warrior: "warrior", wojownik: "warrior",
		ranger: "ranger", "wędrowiec": "ranger", wedrowiec: "ranger",
		rogue: "rogue", "łotr": "rogue", lotr: "rogue", "łotrzyk": "rogue", lotrzyk: "rogue",
		academic: "academic", uczony: "academic",
	};
	return aliases[normalize(value)] ?? "";
}

function classLabel(id) {
	const labels = {
		warrior: ["Warrior", "Wojownik"], ranger: ["Ranger", "Wędrowiec"],
		rogue: ["Rogue", "Łotr"], academic: ["Academic", "Uczony"],
	};
	const pair = labels[id] ?? [id, id];
	return game.i18n.lang === "pl" ? pair[1] : pair[0];
}

function classicSheetRoot(root) {
	if (root?.classList?.contains("wfrp1ed-classic-sheet")) return root;
	return root?.querySelector?.(".wfrp1ed-classic-sheet") ?? null;
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") return value;
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") return value[0];
	return null;
}

function wholeNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}
function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}
function signed(value) { return value > 0 ? `+${value}` : String(value); }
function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }
function reportError(error) {
	console.error("WFRP1ED | Race initial Skill generation failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
