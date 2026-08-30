import { coreSkillSpecialisationSuggestions } from "../core/CoreSkillSpecialisationCatalog.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const { DialogV2 } = foundry.applications.api;

install();

/**
 * Race mandatory Skills use the same Skill-specialisation authoring contract as
 * Career Skills. Package settings stay package-level; the row gear edits the
 * individual Skill choice only.
 */
function install() {
	if (RaceItemSheet.prototype.__wfrpRaceSkillSpecialisationInstalled === true) return;

	const originalRender = RaceItemSheet.prototype._onRender;
	RaceItemSheet.prototype._onRender = function raceSkillSpecialisationRender(context, options) {
		originalRender.call(this, context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement) || !this.isEditable) return;
		if (root.dataset.wfrpRaceSkillConfigBound === "true") return;
		root.dataset.wfrpRaceSkillConfigBound = "true";

		root.addEventListener("click", (event) => {
			const target = event.target?.closest?.(
				"[data-race-entry-configure], [data-race-skill-configure]",
			);
			if (!(target instanceof HTMLElement)) return;
			if (!target.closest(".race-mandatory-section")) return;

			event.preventDefault();
			event.stopImmediatePropagation();

			const packageNode = target.closest(".race-mandatory-compact-package[data-race-entry-id]");
			const row = target.closest("[data-race-entry-id]");
			const entryId = String(
				target.dataset.raceEntryConfigure ||
				target.dataset.raceEntryId ||
				row?.dataset?.raceEntryId ||
				packageNode?.dataset?.raceEntryId ||
				"",
			);
			const choiceId = String(
				target.dataset.raceChoiceId ||
				row?.dataset?.raceChoiceId ||
				"",
			);
			if (!entryId) return;

			void configureRaceSkill(this, entryId, choiceId).catch(reportError);
		}, true);
	};

	Object.defineProperty(
		RaceItemSheet.prototype,
		"__wfrpRaceSkillSpecialisationInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

export async function configureRaceSkill(sheet, entryId, requestedChoiceId = "") {
	if (!sheet?.isEditable) return;
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const entryIndex = entries.findIndex((entry) => String(entry?.id ?? "") === String(entryId));
	if (entryIndex < 0) return;

	const entry = entries[entryIndex];
	const choices = cloneArray(entry?.choices);
	if (!choices.length) return;
	const choiceId = requestedChoiceId || String(choices[0]?.id ?? "");
	const choiceIndex = choices.findIndex((choice) => String(choice?.id ?? "") === choiceId);
	if (choiceIndex < 0) return;

	const packaged = choices.length > 1;
	const workingChoice = foundry.utils.deepClone(choices[choiceIndex]);
	const fields = specialisationFields([workingChoice]);

	const result = await skillDialog({
		entry,
		choice: workingChoice,
		fields,
		packaged,
	});
	if (!result) return;

	const nextEntry = foundry.utils.deepClone(entry);
	if (!packaged) nextEntry.minInitialSkills = result.minInitialSkills;
	nextEntry.choices[choiceIndex] = result.choice;
	normalizeChoiceLabel(nextEntry.choices[choiceIndex]);

	if (!validateNoDuplicate(entries, entryIndex, choiceIndex, nextEntry)) return;
	entries[entryIndex] = nextEntry;
	await sheet.document.update({ "system.mandatorySkills": entries });
}

async function skillDialog({ entry, choice, fields, packaged }) {
	const title = localize("Configure racial Skill", "Konfiguruj rasową Umiejętność");
	const threshold = packaged ? "" : `
		<label class="wfrp1ed-race-skill-config__threshold">
			<span>${escapeHtml(localize("Applies from initial Skill count", "Obowiązuje od liczby początkowych Umiejętności"))}</span>
			<input type="number" name="minInitialSkills" min="1" step="1" value="${Math.max(1, integer(entry?.minInitialSkills, 1))}">
		</label>`;
	const specialisations = fields.length
		? `
			<div class="wfrp1ed-career-skill-specialisations">
				<hr>
				<p><strong>${escapeHtml(localize("Skill specialisation", "Specjalizacja Umiejętności"))}</strong></p>
				${fields.map(specialisationFieldHtml).join("")}
				<p class="hint">${escapeHtml(packaged
					? localize(
						"Package settings are edited with the package icon. This window changes only this Skill.",
						"Ustawienia pakietu edytuje się ikoną pakietu. To okno zmienia wyłącznie tę Umiejętność.",
					)
					: localize(
						"Core suggestions copy a value into the free-text field. You can replace it with any custom specialisation.",
						"Propozycje z Księgi Głównej kopiują wartość do pola tekstowego. Możesz ją zastąpić dowolną własną specjalizacją.",
					))}</p>
			</div>`
		: `<p class="hint">${escapeHtml(localize(
			"This Skill has no Core specialisation list, but its stored specialisation can still be edited below.",
			"Ta Umiejętność nie ma listy specjalizacji z Księgi Głównej, ale zapisaną specjalizację nadal można edytować poniżej.",
		))}</p>`;

	const fallbackField = fields.length ? "" : specialisationFieldHtml({
		controlName: "skillSpecialisation_0_0",
		label: `${localize("Specialisation", "Specjalizacja")} — ${choiceBaseName(choice)}`,
		value: String(choice?.grants?.[0]?.specialisation ?? "").trim(),
		suggestions: [],
	});

	const content = `
		<div class="wfrp1ed career-entry-dialog wfrp1ed-race-skill-config">
			${threshold}
			${specialisations}
			${fallbackField}
		</div>`;

	return DialogV2.wait({
		window: { title },
		content,
		modal: true,
		rejectClose: false,
		render: (_event, dialog) => wireSuggestionSelectors(dialog, fields),
		buttons: [{
			action: "save",
			label: localize("Save", "Zapisz"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				const nextChoice = foundry.utils.deepClone(choice);
				const effectiveFields = fields.length ? fields : [{
					controlName: "skillSpecialisation_0_0",
					choiceIndex: 0,
					grantIndex: 0,
				}];
				applySpecialisations([nextChoice], effectiveFields, data);
				return {
					minInitialSkills: packaged
						? Math.max(1, integer(entry?.minInitialSkills, 1))
						: Math.max(1, integer(data.get("minInitialSkills"), 1)),
					choice: nextChoice,
				};
			},
		}],
	});
}

function specialisationFields(choices) {
	const fields = [];
	for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
		const choice = choices[choiceIndex];
		for (let grantIndex = 0; grantIndex < (choice?.grants ?? []).length; grantIndex += 1) {
			const grant = choice.grants[grantIndex];
			const rulesId = skillRulesId(grant);
			fields.push({
				choiceIndex,
				grantIndex,
				controlName: `skillSpecialisation_${choiceIndex}_${grantIndex}`,
				label: `${localize("Specialisation", "Specjalizacja")} — ${grantBaseName(grant)}`,
				value: String(grant?.specialisation ?? "").trim(),
				suggestions: coreSkillSpecialisationSuggestions(rulesId, game.i18n.lang),
			});
		}
	}
	return fields;
}

function specialisationFieldHtml(field) {
	const placeholder = localize(
		"Optional; enter any specialisation",
		"Opcjonalna; wpisz dowolną specjalizację",
	);
	const suggestions = field.suggestions?.length
		? `<label>${escapeHtml(localize("Core suggestions", "Propozycje z Księgi Głównej"))}
			<select data-wfrp-specialisation-target="${escapeHtml(field.controlName)}">
				<option value="">${escapeHtml(localize("Choose a Core suggestion…", "Wybierz propozycję z Księgi Głównej…"))}</option>
				${field.suggestions.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}
			</select>
		</label>`
		: "";
	return `<label>${escapeHtml(field.label)}
		<input type="text" name="${escapeHtml(field.controlName)}" value="${escapeHtml(field.value ?? "")}" placeholder="${escapeHtml(placeholder)}" autocomplete="off">
	</label>${suggestions}`;
}

function wireSuggestionSelectors(dialog, fields) {
	for (const field of fields) {
		if (!field.suggestions?.length) continue;
		const selector = dialog.element.querySelector(`select[data-wfrp-specialisation-target="${field.controlName}"]`);
		const input = dialog.element.querySelector(`input[name="${field.controlName}"]`);
		if (!(selector instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) continue;
		selector.addEventListener("change", () => {
			const value = String(selector.value ?? "").trim();
			if (!value) return;
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			selector.value = "";
			input.focus();
		});
	}
}

function applySpecialisations(choices, fields, data) {
	for (const field of fields) {
		const grant = choices?.[field.choiceIndex]?.grants?.[field.grantIndex];
		if (!grant) continue;
		grant.specialisation = String(data.get(field.controlName) ?? "").trim();
	}
}

function validateNoDuplicate(entries, editedEntryIndex, editedChoiceIndex, editedEntry) {
	const candidateChoice = editedEntry?.choices?.[editedChoiceIndex];
	const candidateGrant = candidateChoice?.grants?.[0];
	if (!candidateGrant) return true;

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
		const entry = entryIndex === editedEntryIndex ? editedEntry : entries[entryIndex];
		for (let choiceIndex = 0; choiceIndex < (entry?.choices ?? []).length; choiceIndex += 1) {
			if (entryIndex === editedEntryIndex && choiceIndex === editedChoiceIndex) continue;
			for (const grant of entry.choices[choiceIndex]?.grants ?? []) {
				if (!sameReference(grant, candidateGrant)) continue;
				ui.notifications.warn(localize(
					`${grantDisplayName(candidateGrant)} is already listed in this Race with the same specialisation.`,
					`${grantDisplayName(candidateGrant)} jest już wpisane w tej Rasie z tą samą specjalizacją.`,
				));
				return false;
			}
		}
	}
	return true;
}

function sameReference(left, right) {
	const leftRules = String(left?.rulesId ?? "").trim();
	const rightRules = String(right?.rulesId ?? "").trim();
	const leftSpec = normalize(left?.specialisation);
	const rightSpec = normalize(right?.specialisation);
	if (leftRules && rightRules) return leftRules === rightRules && leftSpec === rightSpec;
	const leftUuid = String(left?.uuid ?? "").trim();
	const rightUuid = String(right?.uuid ?? "").trim();
	if (leftUuid && rightUuid) return leftUuid === rightUuid && leftSpec === rightSpec;
	return normalize(left?.name) === normalize(right?.name) && leftSpec === rightSpec;
}

function skillRulesId(grant) {
	const direct = String(grant?.rulesId ?? "").trim();
	if (direct) return direct;
	const document = resolvedDocument(grant);
	return String(document?.system?.rulesId ?? "").trim();
}

function grantBaseName(grant) {
	const document = resolvedDocument(grant);
	return String(document?.name ?? grant?.name ?? grant?.rulesId ?? "").trim() || "—";
}

function choiceBaseName(choice) {
	return grantBaseName(choice?.grants?.[0] ?? {});
}

function grantDisplayName(grant) {
	const name = grantBaseName(grant);
	const specialisation = String(grant?.specialisation ?? "").trim();
	return specialisation ? `${name} (${specialisation})` : name;
}

function normalizeChoiceLabel(choice) {
	choice.label = (choice?.grants ?? []).map(grantDisplayName).filter(Boolean).join(" + ");
}

function resolvedDocument(reference) {
	const uuid = String(reference?.uuid ?? "").trim();
	if (!uuid) return null;
	try { return foundry.utils.fromUuidSync(uuid); } catch (_error) { return null; }
}

function cloneArray(value) {
	const source = value?.toObject?.() ?? value;
	return Array.isArray(source) ? foundry.utils.deepClone(source) : [];
}

function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function escapeHtml(value) {
	return foundry.utils.escapeHTML(String(value ?? ""));
}

function reportError(error) {
	console.error("WFRP1ED | Race Skill configuration failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
