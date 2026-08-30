import {
	RACE_INITIAL_SKILL_MODE,
} from "../data-models/item/RaceData.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const { DialogV2 } = foundry.applications.api;

installRaceMandatorySkillPackages();

/**
 * Race mandatory-Skill authoring intentionally mirrors Career package UX:
 * free rows are created by normal sheet drops, grouping is explicit, and
 * package dialogs can additionally accept Skill Items dragged straight from
 * the sidebar. Existing free rows are moved into packages; external Skill
 * drops become package choices only when the Skill is not already represented.
 */
function installRaceMandatorySkillPackages() {
	if (RaceItemSheet.prototype.__wfrpRaceMandatoryPackagesInstalled === true) return;

	const originalRender = RaceItemSheet.prototype._onRender;
	RaceItemSheet.prototype._onRender = function racePackageRender(context, options) {
		originalRender.call(this, context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement)) return;
		renderMandatorySkillWorkspace(this, root);
	};

	Object.defineProperty(
		RaceItemSheet.prototype,
		"__wfrpRaceMandatoryPackagesInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function renderMandatorySkillWorkspace(sheet, root) {
	const dropZone = root.querySelector('[data-race-drop-zone="mandatorySkillsNew"]');
	if (!(dropZone instanceof HTMLElement)) return;

	const section = dropZone.closest(".race-mandatory-section");
	const hint = section?.querySelector?.(".race-sheet-hint");
	if (hint instanceof HTMLElement) {
		hint.textContent = localize(
			"Drop a Skill in this section to add it as a free row. Use the package button on a Skill row to group it with other free Skills.",
			"Upuść Umiejętność w tej sekcji, aby dodać ją jako wolny wpis. Użyj przycisku pakietu przy wpisie Umiejętności, aby połączyć ją z innymi wolnymi Umiejętnościami.",
		);
	}

	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const groups = presentGroups(entries);

	dropZone.classList.add("career-compact-list", "race-mandatory-compact-list");
	dropZone.innerHTML = groups.length
		? groups.map((group) => group.isPackage
			? packageHtml(group, sheet.isEditable)
			: freeRowHtml(group, sheet.isEditable)).join("")
		: `<p class="career-empty">—</p>`;

	if (!sheet.isEditable) return;

	for (const button of dropZone.querySelectorAll("[data-race-package-create]")) {
		button.addEventListener("click", () => {
			void createPackage(sheet, String(button.dataset.racePackageCreate ?? "")).catch(reportError);
		});
	}
	for (const button of dropZone.querySelectorAll("[data-race-package-edit]")) {
		button.addEventListener("click", () => {
			void editPackage(sheet, String(button.dataset.racePackageEdit ?? "")).catch(reportError);
		});
	}
	for (const button of dropZone.querySelectorAll("[data-race-entry-configure]")) {
		button.addEventListener("click", () => {
			void configureEntry(sheet, String(button.dataset.raceEntryConfigure ?? "")).catch(reportError);
		});
	}
	for (const button of dropZone.querySelectorAll("[data-race-entry-delete]")) {
		button.addEventListener("click", () => {
			void deleteEntry(sheet, String(button.dataset.raceEntryDelete ?? "")).catch(reportError);
		});
	}
}

function presentGroups(entries) {
	let packageNumber = 0;
	return entries.map((entry) => {
		const choices = cloneArray(entry?.choices);
		const isPackage = choices.length > 1;
		const currentPackage = isPackage ? ++packageNumber : 0;
		return {
			entryId: String(entry?.id ?? ""),
			isPackage,
			metaLabel: metaLabel(entry, choices.length, currentPackage),
			label: choiceLabel(choices[0]),
			members: choices.map((choice) => ({
				choiceId: String(choice?.id ?? ""),
				label: choiceLabel(choice),
			})),
		};
	});
}

function freeRowHtml(group, editable) {
	return `
		<div class="career-compact-row race-mandatory-compact-row" data-race-entry-id="${escapeHtml(group.entryId)}">
			<div class="career-compact-row__content">
				<span class="career-compact-row__name">${escapeHtml(group.label)}</span>
			</div>
			${group.metaLabel ? `<span class="career-compact-row__meta">${escapeHtml(group.metaLabel)}</span>` : ""}
			${editable ? `
				<div class="career-compact-row__controls">
					<button type="button" class="career-compact-row__package" data-race-package-create="${escapeHtml(group.entryId)}" title="${escapeHtml(localize("Create package from this Skill", "Utwórz pakiet z tej Umiejętności"))}"><i class="fa-solid fa-boxes-stacked"></i></button>
					<button type="button" data-race-entry-configure="${escapeHtml(group.entryId)}" title="${escapeHtml(localize("Configure", "Konfiguruj"))}"><i class="fa-solid fa-gear"></i></button>
					<button type="button" data-race-entry-delete="${escapeHtml(group.entryId)}" title="${escapeHtml(localize("Delete", "Usuń"))}"><i class="fa-solid fa-trash"></i></button>
				</div>
			` : ""}
		</div>
	`;
}

function packageHtml(group, editable) {
	return `
		<section class="career-compact-package race-mandatory-compact-package" data-race-entry-id="${escapeHtml(group.entryId)}">
			<span class="career-compact-package__meta">${escapeHtml(group.metaLabel)}</span>
			${editable ? `<button type="button" class="career-compact-package__tab" data-race-package-edit="${escapeHtml(group.entryId)}" title="${escapeHtml(localize("Edit package", "Edytuj pakiet"))}"><i class="fa-solid fa-boxes-stacked"></i></button>` : ""}
			<div class="career-compact-package__members">
				${group.members.map((member) => `
					<div class="career-compact-row career-compact-package__member">
						<div class="career-compact-row__content"><span class="career-compact-row__name">${escapeHtml(member.label)}</span></div>
					</div>
				`).join("")}
			</div>
			${editable ? `
				<div class="race-mandatory-package-actions">
					<button type="button" data-race-entry-configure="${escapeHtml(group.entryId)}" title="${escapeHtml(localize("Configure", "Konfiguruj"))}"><i class="fa-solid fa-gear"></i></button>
					<button type="button" data-race-entry-delete="${escapeHtml(group.entryId)}" title="${escapeHtml(localize("Delete package", "Usuń pakiet"))}"><i class="fa-solid fa-trash"></i></button>
				</div>
			` : ""}
		</section>
	`;
}

async function createPackage(sheet, seedEntryId) {
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const freeRows = freeCandidates(entries);
	const seed = freeRows.find((row) => row.entryId === seedEntryId);
	if (!seed) return;

	const result = await packageDialog({
		title: localize("Create racial Skill package", "Utwórz pakiet rasowych Umiejętności"),
		rows: freeRows,
		seedEntryId,
		minInitialSkills: seed.minInitialSkills,
		mode: RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE,
		choose: 1,
	});
	if (!result) return;

	const selected = new Set(result.selectedEntryIds);
	const selectedEntries = entries.filter((entry) => selected.has(String(entry?.id ?? "")));
	const choices = [
		...selectedEntries.flatMap((entry) => cloneArray(entry.choices)),
		...cloneArray(result.externalChoices),
	];
	if (choices.length < 2) return;

	const firstIndex = Math.max(0, entries.findIndex((entry) => selected.has(String(entry?.id ?? ""))));
	const next = entries.filter((entry) => !selected.has(String(entry?.id ?? "")));
	const packageEntry = {
		id: foundry.utils.randomID(),
		minInitialSkills: result.minInitialSkills,
		mode: result.mode,
		choose: clampChoose(result.choose, choices.length),
		choices,
	};
	next.splice(Math.min(firstIndex, next.length), 0, packageEntry);
	await sheet.document.update({ "system.mandatorySkills": next });
}

async function editPackage(sheet, entryId) {
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const packageIndex = entries.findIndex((entry) => String(entry?.id ?? "") === entryId);
	const packageEntry = entries[packageIndex];
	if (!packageEntry || cloneArray(packageEntry.choices).length < 2) return;

	const originalChoices = new Map(cloneArray(packageEntry.choices).map((choice) => [String(choice?.id ?? ""), choice]));
	const freeRows = freeCandidates(entries);
	const freeById = new Map(freeRows.map((row) => [row.entryId, row]));
	const currentMembers = cloneArray(packageEntry.choices).map((choice) => ({
		key: `package:${String(choice?.id ?? foundry.utils.randomID())}`,
		origin: "package",
		choiceId: String(choice?.id ?? ""),
		label: choiceLabel(choice),
		choice,
	}));

	const result = await editPackageDialog(packageEntry, currentMembers, freeRows);
	if (!result) return;

	const newChoices = [];
	const consumedFreeIds = new Set();
	for (const member of result.members) {
		if (member.origin === "package") {
			const choice = originalChoices.get(member.choiceId);
			if (choice) newChoices.push(choice);
			continue;
		}
		if (member.origin === "free") {
			const row = freeById.get(member.entryId);
			if (!row) continue;
			consumedFreeIds.add(member.entryId);
			newChoices.push(...cloneArray(row.entry?.choices));
			continue;
		}
		if (member.origin === "external" && member.choice) {
			newChoices.push(foundry.utils.deepClone(member.choice));
		}
	}

	const detachedChoices = cloneArray(packageEntry.choices).filter((choice) =>
		!result.members.some((member) => member.origin === "package" && member.choiceId === String(choice?.id ?? "")),
	);

	const next = entries.filter((entry) => !consumedFreeIds.has(String(entry?.id ?? "")));
	const currentIndex = next.findIndex((entry) => String(entry?.id ?? "") === entryId);
	if (currentIndex < 0) return;

	if (newChoices.length >= 2) {
		next[currentIndex] = {
			...next[currentIndex],
			minInitialSkills: result.minInitialSkills,
			mode: result.mode,
			choose: clampChoose(result.choose, newChoices.length),
			choices: newChoices,
		};
	} else if (newChoices.length === 1) {
		next[currentIndex] = standaloneFromChoice(newChoices[0], result.minInitialSkills);
	} else {
		next.splice(currentIndex, 1);
	}

	const insertion = Math.min(currentIndex + 1, next.length);
	next.splice(insertion, 0, ...detachedChoices.map((choice) => standaloneFromChoice(choice, packageEntry.minInitialSkills)));
	await sheet.document.update({ "system.mandatorySkills": next });
}

async function configureEntry(sheet, entryId) {
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const index = entries.findIndex((entry) => String(entry?.id ?? "") === entryId);
	const entry = entries[index];
	if (!entry) return;
	const choiceCount = cloneArray(entry.choices).length;

	const content = `
		<div class="wfrp1ed career-package-builder">
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Applies from initial Skill count", "Obowiązuje od liczby początkowych Umiejętności"))}
					<input type="number" name="minInitialSkills" min="1" step="1" value="${Math.max(1, integer(entry.minInitialSkills, 1))}">
				</label>
				${choiceCount > 1 ? modeControls(entry.mode, entry.choose, choiceCount) : ""}
			</div>
		</div>
	`;

	const result = await DialogV2.wait({
		window: { title: localize("Configure racial Skill", "Konfiguruj rasową Umiejętność") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "save",
			label: localize("Save", "Zapisz"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				return {
					minInitialSkills: Math.max(1, integer(data.get("minInitialSkills"), 1)),
					mode: choiceCount > 1 ? normalizeMode(data.get("mode")) : RACE_INITIAL_SKILL_MODE.ALL,
					choose: choiceCount > 1 ? clampChoose(data.get("choose"), choiceCount) : 1,
				};
			},
		}],
	});
	if (!result) return;

	entries[index] = { ...entry, ...result };
	await sheet.document.update({ "system.mandatorySkills": entries });
}

async function deleteEntry(sheet, entryId) {
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const index = entries.findIndex((entry) => String(entry?.id ?? "") === entryId);
	if (index < 0) return;
	entries.splice(index, 1);
	await sheet.document.update({ "system.mandatorySkills": entries });
}

async function packageDialog({ title, rows, seedEntryId, minInitialSkills, mode, choose }) {
	const externalChoices = new Map();
	const content = `
		<div class="wfrp1ed career-package-builder">
			<p class="career-package-builder__intro">${escapeHtml(localize(
				"Select free Skills below, or drag a Skill directly from the sidebar into this list.",
				"Wybierz wolne Umiejętności poniżej albo przeciągnij Umiejętność bezpośrednio z panelu bocznego na tę listę.",
			))}</p>
			<div class="career-package-builder__choices" data-race-package-drop-target>
				${rows.map((row) => candidateHtml(row, row.entryId === seedEntryId)).join("")}
			</div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Applies from initial Skill count", "Obowiązuje od liczby początkowych Umiejętności"))}<input type="number" name="minInitialSkills" min="1" step="1" value="${Math.max(1, integer(minInitialSkills, 1))}"></label>
				${modeControls(mode, choose, rows.length)}
			</div>
		</div>`;

	return DialogV2.wait({
		window: { title }, content, modal: true, rejectClose: false,
		render: (_event, dialog) => {
			const list = dialog.element.querySelector("[data-race-package-drop-target]");
			const chooseInput = dialog.element.querySelector('input[name="choose"]');
			const sync = () => {
				const selected = dialog.element.querySelectorAll('input[name="packageMember"]:checked').length;
				if (chooseInput instanceof HTMLInputElement) {
					chooseInput.max = String(Math.max(1, selected));
					chooseInput.value = String(clampChoose(chooseInput.value, Math.max(1, selected)));
				}
				const button = dialog.element.querySelector('button[data-action="create"]');
				if (button instanceof HTMLButtonElement) button.disabled = selected < 2;
			};

			list?.addEventListener("change", sync);
			installSkillDropTarget(list, async (skill) => {
				const existing = rows.find((row) => choiceMatchesSkill(row.entry?.choices?.[0], skill));
				if (existing) {
					const checkbox = dialog.element.querySelector(`input[name="packageMember"][value="${cssEscape(existing.entryId)}"]`);
					if (checkbox instanceof HTMLInputElement) checkbox.checked = true;
					sync();
					return;
				}
				if ([...externalChoices.values()].some((choice) => choiceMatchesSkill(choice, skill))) {
					ui.notifications.info(localize("This Skill is already selected for the package.", "Ta Umiejętność jest już wybrana do pakietu."));
					return;
				}
				const choice = choiceFromSkill(skill);
				const key = `external:${choice.id}`;
				externalChoices.set(key, choice);
				list?.insertAdjacentHTML("beforeend", externalCandidateHtml(key, choice));
				sync();
			});
			sync();
		},
		buttons: [{
			action: "create", label: localize("Create package", "Utwórz pakiet"), default: true,
			callback: (_event, button) => {
				const checked = [...button.form.querySelectorAll('input[name="packageMember"]:checked')].map((input) => String(input.value));
				if (checked.length < 2) return false;
				const selectedEntryIds = checked.filter((id) => !id.startsWith("external:"));
				const selectedExternal = checked.map((id) => externalChoices.get(id)).filter(Boolean);
				const data = new FormData(button.form);
				return {
					selectedEntryIds,
					externalChoices: selectedExternal,
					minInitialSkills: Math.max(1, integer(data.get("minInitialSkills"), 1)),
					mode: normalizeMode(data.get("mode")),
					choose: clampChoose(data.get("choose"), checked.length),
				};
			},
		}],
	});
}

async function editPackageDialog(packageEntry, initialMembers, freeRows) {
	const state = { members: [...initialMembers] };
	const freeById = new Map(freeRows.map((row) => [row.entryId, row]));
	const content = `
		<div class="wfrp1ed career-package-editor">
			<div class="career-package-editor__heading"><strong>${escapeHtml(localize("Package members", "Elementy pakietu"))}</strong><button type="button" data-package-add title="${escapeHtml(localize("Add free Skills", "Dodaj wolne Umiejętności"))}"><i class="fa-solid fa-plus"></i></button></div>
			<p class="career-package-builder__intro">${escapeHtml(localize("You can also drag a Skill directly from the sidebar into the member list.", "Możesz również przeciągnąć Umiejętność bezpośrednio z panelu bocznego na listę elementów."))}</p>
			<div class="career-package-editor__members" data-race-package-drop-target></div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Applies from initial Skill count", "Obowiązuje od liczby początkowych Umiejętności"))}<input type="number" name="minInitialSkills" min="1" step="1" value="${Math.max(1, integer(packageEntry.minInitialSkills, 1))}"></label>
				${modeControls(packageEntry.mode, packageEntry.choose, Math.max(1, initialMembers.length))}
			</div>
			<p class="hint">${escapeHtml(localize("Removing a member returns existing Race entries to the free racial Skill list; it does not delete the Skill.", "Usunięcie elementu przenosi istniejące wpisy Rasy z powrotem na listę wolnych rasowych Umiejętności; nie usuwa Umiejętności."))}</p>
		</div>`;

	return DialogV2.wait({
		window: { title: localize("Edit racial Skill package", "Edytuj pakiet rasowych Umiejętności") }, content, modal: true, rejectClose: false,
		render: (_event, dialog) => {
			const list = dialog.element.querySelector(".career-package-editor__members");
			const add = dialog.element.querySelector("[data-package-add]");
			const chooseInput = dialog.element.querySelector('input[name="choose"]');

			const render = () => {
				if (list instanceof HTMLElement) {
					list.innerHTML = state.members.length
						? state.members.map((member) => `<div class="career-package-editor__member"><span>${escapeHtml(member.label)}</span><button type="button" data-remove="${escapeHtml(member.key)}"><i class="fa-solid fa-xmark"></i></button></div>`).join("")
						: `<p class="career-package-editor__empty">${escapeHtml(localize("Drop a Skill here or use + to add an existing free entry.", "Upuść tutaj Umiejętność albo użyj +, aby dodać istniejący wolny wpis."))}</p>`;
				}
				for (const button of list?.querySelectorAll?.("[data-remove]") ?? []) button.addEventListener("click", () => { state.members = state.members.filter((member) => member.key !== String(button.dataset.remove)); render(); });
				if (add instanceof HTMLButtonElement) add.disabled = freeRows.every((row) => state.members.some((member) => member.entryId === row.entryId));
				if (chooseInput instanceof HTMLInputElement) {
					chooseInput.max = String(Math.max(1, state.members.length));
					chooseInput.value = String(clampChoose(chooseInput.value, Math.max(1, state.members.length)));
				}
			};

			add?.addEventListener("click", async () => {
				const available = freeRows.filter((row) => !state.members.some((member) => member.entryId === row.entryId));
				if (!available.length) return;
				const selected = await selectFreeRows(available);
				for (const id of selected ?? []) {
					const row = freeById.get(id);
					if (row) state.members.push({ key: `free:${id}`, origin: "free", entryId: id, label: row.label, choice: cloneArray(row.entry?.choices)[0] });
				}
				render();
			});

			installSkillDropTarget(list, async (skill) => {
				if (state.members.some((member) => memberChoiceMatchesSkill(member, freeById, skill))) {
					ui.notifications.info(localize("This Skill is already in the package.", "Ta Umiejętność już znajduje się w pakiecie."));
					return;
				}
				const free = freeRows.find((row) => choiceMatchesSkill(row.entry?.choices?.[0], skill));
				if (free) {
					state.members.push({ key: `free:${free.entryId}`, origin: "free", entryId: free.entryId, label: free.label, choice: cloneArray(free.entry?.choices)[0] });
				} else {
					const choice = choiceFromSkill(skill);
					state.members.push({ key: `external:${choice.id}`, origin: "external", label: choiceLabel(choice), choice });
				}
				render();
			});

			chooseInput?.addEventListener("input", render);
			render();
		},
		buttons: [{
			action: "save", label: localize("Save package", "Zapisz pakiet"), default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				return {
					members: state.members.map((member) => ({ origin: member.origin, choiceId: member.choiceId ?? "", entryId: member.entryId ?? "", choice: member.origin === "external" ? foundry.utils.deepClone(member.choice) : null })),
					minInitialSkills: Math.max(1, integer(data.get("minInitialSkills"), 1)),
					mode: normalizeMode(data.get("mode")),
					choose: clampChoose(data.get("choose"), Math.max(1, state.members.length)),
				};
			},
		}],
	});
}

async function selectFreeRows(rows) {
	return DialogV2.wait({
		window: { title: localize("Add Skills", "Dodaj Umiejętności") }, modal: true, rejectClose: false,
		content: `<div class="wfrp1ed career-package-builder__choices">${rows.map((row) => `<label class="career-package-builder__choice"><input type="checkbox" name="freeRow" value="${escapeHtml(row.entryId)}"><span>${escapeHtml(row.label)}</span></label>`).join("")}</div>`,
		buttons: [{ action: "add", label: localize("Add", "Dodaj"), default: true, callback: (_event, button) => [...button.form.querySelectorAll('input[name="freeRow"]:checked')].map((input) => String(input.value)) }],
	});
}

function candidateHtml(row, seed) {
	return `<label class="career-package-builder__choice ${seed ? "career-package-builder__choice--seed" : ""}"><input type="checkbox" name="packageMember" value="${escapeHtml(row.entryId)}" ${seed ? "checked disabled" : ""}><span>${escapeHtml(row.label)}</span>${seed ? `<small>${escapeHtml(localize("Starting row", "Wpis początkowy"))}</small>` : ""}</label>`;
}

function externalCandidateHtml(key, choice) {
	return `<label class="career-package-builder__choice"><input type="checkbox" name="packageMember" value="${escapeHtml(key)}" checked><span>${escapeHtml(choiceLabel(choice))}</span><small>${escapeHtml(localize("Dropped from sidebar", "Upuszczono z panelu bocznego"))}</small></label>`;
}

function modeControls(mode, choose, maxChoose) {
	const normalized = normalizeMode(mode);
	return `<label>${escapeHtml(localize("Mode", "Tryb"))}<select name="mode">
		<option value="${RACE_INITIAL_SKILL_MODE.ALL}" ${normalized === RACE_INITIAL_SKILL_MODE.ALL ? "selected" : ""}>${escapeHtml(localize("All listed", "Wszystkie wymienione"))}</option>
		<option value="${RACE_INITIAL_SKILL_MODE.PLAYER_CHOICE}" ${normalized === RACE_INITIAL_SKILL_MODE.PLAYER_CHOICE ? "selected" : ""}>${escapeHtml(localize("Player choice", "Wybór gracza"))}</option>
		<option value="${RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE}" ${normalized === RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE ? "selected" : ""}>${escapeHtml(localize("Random choice", "Losowy wybór"))}</option>
	</select></label><label>${escapeHtml(localize("Choose", "Wybierz"))}<input type="number" name="choose" min="1" max="${Math.max(1, maxChoose)}" step="1" value="${clampChoose(choose, Math.max(1, maxChoose))}"></label>`;
}

function freeCandidates(entries) {
	return entries
		.filter((entry) => cloneArray(entry?.choices).length === 1)
		.map((entry) => ({
			entryId: String(entry?.id ?? ""),
			label: choiceLabel(entry.choices[0]),
			minInitialSkills: Math.max(1, integer(entry.minInitialSkills, 1)),
			entry,
		}));
}

function standaloneFromChoice(choice, minInitialSkills) {
	return {
		id: foundry.utils.randomID(),
		minInitialSkills: Math.max(1, integer(minInitialSkills, 1)),
		mode: RACE_INITIAL_SKILL_MODE.ALL,
		choose: 1,
		choices: [foundry.utils.deepClone(choice)],
	};
}

async function installSkillDropTarget(element, onSkill) {
	if (!(element instanceof HTMLElement)) return;
	element.addEventListener("dragover", (event) => {
		event.preventDefault();
		element.classList.add("is-drag-over");
	});
	element.addEventListener("dragleave", (event) => {
		if (!element.contains(event.relatedTarget)) element.classList.remove("is-drag-over");
	});
	element.addEventListener("drop", (event) => {
		event.preventDefault();
		event.stopPropagation();
		element.classList.remove("is-drag-over");
		void resolveDroppedSkill(event).then((skill) => {
			if (skill) return onSkill(skill);
			return null;
		}).catch(reportError);
	});
}

async function resolveDroppedSkill(event) {
	let data;
	try {
		data = TextEditor.getDragEventData(event);
	} catch (_error) {
		return null;
	}
	if (!data || data.type !== "Item") return null;
	const uuid = String(data.uuid ?? "");
	if (!uuid) return null;
	const document = await fromUuid(uuid);
	if (!(document instanceof foundry.documents.Item)) return null;
	if (document.type !== "skill") {
		ui.notifications.warn(localize("Only Skill Items can be dropped into a racial Skill package.", "Do pakietu rasowych Umiejętności można upuszczać wyłącznie Przedmioty typu Umiejętność."));
		return null;
	}
	return document;
}

function choiceFromSkill(document) {
	const grant = skillReference(document);
	return {
		id: foundry.utils.randomID(),
		label: grantDisplayName(grant),
		grants: [grant],
	};
}

function skillReference(document) {
	return {
		uuid: String(document.uuid ?? ""),
		rulesId: String(document.system?.rulesId ?? ""),
		name: String(document.name ?? ""),
		specialisation: String(document.system?.specialisation ?? ""),
	};
}

function choiceMatchesSkill(choice, skill) {
	const reference = cloneArray(choice?.grants)[0];
	return sameReference(reference, skillReference(skill));
}

function memberChoiceMatchesSkill(member, freeById, skill) {
	if (member?.choice && choiceMatchesSkill(member.choice, skill)) return true;
	if (member?.origin === "free") {
		const row = freeById.get(member.entryId);
		return choiceMatchesSkill(row?.entry?.choices?.[0], skill);
	}
	return false;
}

function sameReference(a, b) {
	const aRules = String(a?.rulesId ?? "");
	const bRules = String(b?.rulesId ?? "");
	if (aRules && bRules) return aRules === bRules && String(a?.specialisation ?? "") === String(b?.specialisation ?? "");
	return Boolean(String(a?.uuid ?? "")) && String(a?.uuid ?? "") === String(b?.uuid ?? "");
}

function grantDisplayName(grant) {
	const name = String(grant?.name ?? grant?.rulesId ?? "").trim() || "—";
	const specialisation = String(grant?.specialisation ?? "").trim();
	return specialisation ? `${name} (${specialisation})` : name;
}

function metaLabel(entry, choiceCount, packageNumber) {
	const threshold = Math.max(1, integer(entry?.minInitialSkills, 1));
	const thresholdText = localize(`from ${threshold} Skills`, `od ${threshold} Umiejętności`);
	if (choiceCount <= 1) return threshold > 1 ? thresholdText : "";
	let packageText;
	switch (normalizeMode(entry?.mode)) {
		case RACE_INITIAL_SKILL_MODE.PLAYER_CHOICE:
			packageText = localize(`Package ${packageNumber}: choose ${clampChoose(entry?.choose, choiceCount)} of ${choiceCount}`, `Pakiet ${packageNumber}: wybierz ${clampChoose(entry?.choose, choiceCount)} z ${choiceCount}`);
			break;
		case RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE:
			packageText = localize(`Package ${packageNumber}: random ${clampChoose(entry?.choose, choiceCount)} of ${choiceCount}`, `Pakiet ${packageNumber}: losowo ${clampChoose(entry?.choose, choiceCount)} z ${choiceCount}`);
			break;
		default:
			packageText = localize(`Package ${packageNumber}: all ${choiceCount}`, `Pakiet ${packageNumber}: wszystkie ${choiceCount}`);
	}
	return `${packageText} • ${thresholdText}`;
}

function choiceLabel(choice) {
	const explicit = String(choice?.label ?? "").trim();
	if (explicit) return explicit;
	return cloneArray(choice?.grants).map((grant) => grantDisplayName(grant)).filter(Boolean).join(" + ") || "—";
}

function normalizeMode(value) {
	const candidate = String(value ?? "");
	return Object.values(RACE_INITIAL_SKILL_MODE).includes(candidate) ? candidate : RACE_INITIAL_SKILL_MODE.ALL;
}

function clampChoose(value, maximum) {
	return Math.min(Math.max(1, maximum), Math.max(1, integer(value, 1)));
}

function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function cloneArray(value) {
	const source = value?.toObject?.() ?? value;
	return Array.isArray(source) ? foundry.utils.deepClone(source) : [];
}

function cssEscape(value) {
	return globalThis.CSS?.escape?.(String(value ?? "")) ?? String(value ?? "").replaceAll('"', '\\"');
}

function escapeHtml(value) {
	const div = document.createElement("div");
	div.textContent = String(value ?? "");
	return div.innerHTML;
}

function reportError(error) {
	console.error("WFRP1ED | Race mandatory Skill package authoring failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
