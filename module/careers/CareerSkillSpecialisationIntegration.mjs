import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const { DialogV2 } = foundry.applications.api;

installCareerSkillSpecialisationAuthoring();

/**
 * Extend the existing Career-entry configuration action without changing the
 * Career data contract. Grant.specialisation already exists in CareerData and
 * is already part of Skill identity during Actor progression.
 *
 * The editor exposes one free-text Specialisation control per Skill grant. This
 * works for ordinary one-Skill entries as well as alternatives and bundles.
 * Duplicate validation is Career-wide and compares Skill + specialisation, so
 * the same Skill may appear repeatedly with different specialisations but the
 * same pair may not be entered twice.
 */
function installCareerSkillSpecialisationAuthoring() {
	if (CareerItemSheet.__wfrpSkillSpecialisationAuthoringInstalled === true) return;

	CareerItemSheet.DEFAULT_OPTIONS.actions ??= {};
	CareerItemSheet.DEFAULT_OPTIONS.actions.configureEntry = configureCareerEntry;

	Object.defineProperty(
		CareerItemSheet,
		"__wfrpSkillSpecialisationAuthoringInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/** @this {CareerItemSheet} */
async function configureCareerEntry(_event, target) {
	if (!this.isEditable) return;

	const collectionName = String(target?.dataset?.careerCollection ?? "");
	const entryId = String(target?.dataset?.careerEntryId ?? "");
	if (!["skills", "trappings"].includes(collectionName) || !entryId) return;

	const entries = cloneArray(this.document.system?.[collectionName]);
	const index = entries.findIndex(
		(entry) => String(entry?.id ?? "") === entryId,
	);
	if (index < 0) return;

	const entry = entries[index];
	const result = await configureEntryDialog(entry, {
		includeSkillSpecialisations: collectionName === "skills",
	});
	if (!result) return;

	const updatedEntry = {
		...entry,
		chance: result.chance,
		mode: result.mode,
		choose: result.choose,
		note: result.note,
		choices: result.choices,
	};

	if (collectionName === "skills") {
		normalizeSkillChoiceLabels(updatedEntry);
		const duplicate = duplicateSkillGrant(entries, index, updatedEntry);
		if (duplicate) {
			ui.notifications.warn(localize(
				`${grantDisplayName(duplicate)} is already listed in this Career with the same specialisation.`,
				`${grantDisplayName(duplicate)} jest już wpisane w tej Profesji z tą samą specjalizacją.`,
			));
			return;
		}
	}

	entries[index] = updatedEntry;
	await this.document.update({ [`system.${collectionName}`]: entries });
}

async function configureEntryDialog(
	entry,
	{ includeSkillSpecialisations = false } = {},
) {
	const mode = String(entry?.mode ?? CAREER_ENTRY_MODE.ALL);
	const choices = cloneArray(entry?.choices);
	const specialisationFields = includeSkillSpecialisations
		? skillSpecialisationFields(choices)
		: [];

	const specialisationHtml = specialisationFields.length
		? `
			<div class="wfrp1ed-career-skill-specialisations">
				<hr>
				<p><strong>${escapeHtml(localize(
					"Skill specialisations",
					"Specjalizacje Umiejętności",
				))}</strong></p>
				${specialisationFields.map((field) => `
					<label>${escapeHtml(field.label)}
						<input
							type="text"
							name="${escapeHtml(field.controlName)}"
							value="${escapeHtml(field.value)}"
							placeholder="${escapeHtml(localize(
								"Optional; enter any specialisation",
								"Opcjonalna; wpisz dowolną specjalizację",
							))}"
						>
					</label>
				`).join("")}
				<p class="hint">${escapeHtml(localize(
					"The same Skill may be listed more than once when its specialisations differ. Free text is always allowed.",
					"Ta sama Umiejętność może występować wielokrotnie, jeśli ma różne specjalizacje. Zawsze można wpisać własną specjalizację.",
				))}</p>
			</div>
		`
		: "";

	const content = `
		<div class="wfrp1ed career-entry-dialog">
			<label>${escapeHtml(localize("Acquisition chance (%)", "Szansa zdobycia (%)"))}
				<input type="number" name="chance" min="0" max="100" step="1" value="${clampPercentage(entry?.chance)}">
			</label>
			<label>${escapeHtml(localize("Alternatives", "Alternatywy"))}
				<select name="mode">
					<option value="all" ${mode === "all" ? "selected" : ""}>${escapeHtml(localize("All are gained", "Zdobywane są wszystkie"))}</option>
					<option value="player-choice" ${mode === "player-choice" ? "selected" : ""}>${escapeHtml(localize("Player chooses", "Gracz wybiera"))}</option>
					<option value="random-choice" ${mode === "random-choice" ? "selected" : ""}>${escapeHtml(localize("Random equal choice", "Losowy wybór z równą szansą"))}</option>
				</select>
			</label>
			<label>${escapeHtml(localize("Number selected", "Liczba wybieranych"))}
				<input type="number" name="choose" min="1" step="1" value="${Math.max(1, nonNegativeInteger(entry?.choose))}">
			</label>
			<label>${escapeHtml(localize("Rule note / condition", "Uwagi / warunek"))}
				<input type="text" name="note" value="${escapeHtml(String(entry?.note ?? ""))}">
			</label>
			${specialisationHtml}
		</div>
	`;

	return DialogV2.wait({
		window: { title: localize("Configure Career entry", "Konfiguruj wpis Profesji") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "save",
			label: localize("Save", "Zapisz"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				const nextChoices = cloneArray(choices);

				for (const field of specialisationFields) {
					const grant = nextChoices?.[field.choiceIndex]
						?.grants?.[field.grantIndex];
					if (!grant) continue;
					grant.specialisation = String(
						data.get(field.controlName) ?? "",
					).trim();
				}

				return {
					chance: clampPercentage(data.get("chance")),
					mode: Object.values(CAREER_ENTRY_MODE).includes(String(data.get("mode")))
						? String(data.get("mode"))
						: CAREER_ENTRY_MODE.ALL,
					choose: Math.max(1, Math.trunc(Number(data.get("choose") ?? 1))),
					note: String(data.get("note") ?? "").trim(),
					choices: nextChoices,
				};
			},
		}],
	});
}

function skillSpecialisationFields(choices) {
	const fields = [];
	for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
		const choice = choices[choiceIndex];
		for (let grantIndex = 0; grantIndex < (choice?.grants ?? []).length; grantIndex += 1) {
			const grant = choice.grants[grantIndex];
			if (String(grant?.documentSubtype ?? "") !== "skill") continue;

			fields.push({
				choiceIndex,
				grantIndex,
				controlName: `skillSpecialisation_${choiceIndex}_${grantIndex}`,
				label: `${localize("Specialisation", "Specjalizacja")} — ${grantBaseName(grant)}`,
				value: String(grant?.specialisation ?? "").trim(),
			});
		}
	}
	return fields;
}

function normalizeSkillChoiceLabels(entry) {
	for (const choice of entry?.choices ?? []) {
		const grants = Array.isArray(choice?.grants) ? choice.grants : [];
		if (!grants.length) continue;
		if (!grants.every((grant) => String(grant?.documentSubtype ?? "") === "skill")) {
			continue;
		}
		choice.label = grants.map(grantDisplayName).filter(Boolean).join(" + ");
	}
}

function duplicateSkillGrant(entries, editedIndex, editedEntry) {
	const seen = new Map();
	for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
		const entry = entryIndex === editedIndex ? editedEntry : entries[entryIndex];
		for (const choice of entry?.choices ?? []) {
			for (const grant of choice?.grants ?? []) {
				if (String(grant?.documentSubtype ?? "") !== "skill") continue;
				const key = skillIdentity(grant);
				if (!key) continue;
				if (seen.has(key)) return grant;
				seen.set(key, grant);
			}
		}
	}
	return null;
}

function skillIdentity(grant) {
	const specialisation = normalizeText(grant?.specialisation);
	const rulesId = String(grant?.rulesId ?? "").trim();
	if (rulesId) return `rules:${rulesId}::${specialisation}`;

	const uuid = String(grant?.uuid ?? "").trim();
	if (uuid) return `uuid:${uuid}::${specialisation}`;

	const name = normalizeText(grant?.name);
	return name ? `name:${name}::${specialisation}` : "";
}

function grantDisplayName(grant) {
	const name = grantBaseName(grant);
	const specialisation = String(grant?.specialisation ?? "").trim();
	return specialisation ? `${name} (${specialisation})` : name;
}

function grantBaseName(grant) {
	const document = resolvedDocument(grant);
	return String(
		document?.name ?? grant?.name ?? grant?.rulesId ?? "",
	).trim();
}

function resolvedDocument(reference) {
	const uuid = String(reference?.uuid ?? "").trim();
	if (!uuid) return null;
	try {
		return foundry.utils.fromUuidSync(uuid);
	} catch (_error) {
		return null;
	}
}

function cloneArray(value) {
	const source = value?.toObject?.() ?? value;
	return Array.isArray(source) ? foundry.utils.deepClone(source) : [];
}

function clampPercentage(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 100;
	return Math.max(0, Math.min(100, Math.trunc(numeric)));
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function normalizeText(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function escapeHtml(value) {
	return foundry.utils.escapeHTML(String(value ?? ""));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
