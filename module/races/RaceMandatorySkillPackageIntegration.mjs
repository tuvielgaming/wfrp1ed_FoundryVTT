import {
	RACE_INITIAL_SKILL_MODE,
} from "../data-models/item/RaceData.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const { DialogV2 } = foundry.applications.api;

installRaceMandatorySkillPackages();

/**
 * Give Race mandatory-Skill authoring the same interaction language as Career:
 *
 * - dropping a Skill into the mandatory-Skill section always creates one free
 *   standalone entry;
 * - grouping is an explicit package action from a free row;
 * - a package dialog selects other free rows and owns mode/choose;
 * - package members can be detached back to free rows without deleting them;
 * - the Race-only `minInitialSkills` condition remains entry/package metadata.
 *
 * Career's acquisition `chance` is deliberately NOT copied here. RAW racial
 * mandatory Skills are conditional on initial-Skill count, not percentile
 * acquisition chance.
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
			void createPackage(sheet, String(button.dataset.racePackageCreate ?? ""))
				.catch(reportError);
		});
	}
	for (const button of dropZone.querySelectorAll("[data-race-package-edit]")) {
		button.addEventListener("click", () => {
			void editPackage(sheet, String(button.dataset.racePackageEdit ?? ""))
				.catch(reportError);
		});
	}
	for (const button of dropZone.querySelectorAll("[data-race-entry-configure]")) {
		button.addEventListener("click", () => {
			void configureEntry(sheet, String(button.dataset.raceEntryConfigure ?? ""))
				.catch(reportError);
		});
	}
	for (const button of dropZone.querySelectorAll("[data-race-entry-delete]")) {
		button.addEventListener("click", () => {
			void deleteEntry(sheet, String(button.dataset.raceEntryDelete ?? ""))
				.catch(reportError);
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
	if (freeRows.length < 2) {
		ui.notifications.info(localize(
			"At least two free Skills are required to create a package.",
			"Do utworzenia pakietu potrzebne są co najmniej dwie wolne Umiejętności.",
		));
		return;
	}

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
	if (selectedEntries.length < 2) return;

	const choices = selectedEntries.flatMap((entry) => cloneArray(entry.choices));
	const firstIndex = entries.findIndex((entry) => selected.has(String(entry?.id ?? "")));
	const next = entries.filter((entry) => !selected.has(String(entry?.id ?? "")));
	const packageEntry = {
		id: foundry.utils.randomID(),
		minInitialSkills: result.minInitialSkills,
		mode: result.mode,
		choose: clampChoose(result.choose, choices.length),
		choices,
	};
	next.splice(Math.max(0, firstIndex), 0, packageEntry);
	await sheet.document.update({ "system.mandatorySkills": next });
}

async function editPackage(sheet, entryId) {
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const packageIndex = entries.findIndex((entry) => String(entry?.id ?? "") === entryId);
	const packageEntry = entries[packageIndex];
	if (!packageEntry || cloneArray(packageEntry.choices).length < 2) return;

	const freeRows = freeCandidates(entries);
	const currentMembers = cloneArray(packageEntry.choices).map((choice) => ({
		key: `package:${String(choice?.id ?? foundry.utils.randomID())}`,
		origin: "package",
		choiceId: String(choice?.id ?? ""),
		label: choiceLabel(choice),
	}));
	const freeById = new Map(freeRows.map((row) => [row.entryId, row]));

	const result = await editPackageDialog(packageEntry, currentMembers, freeRows);
	if (!result) return;

	const originalChoices = new Map(cloneArray(packageEntry.choices).map((choice) => [String(choice?.id ?? ""), choice]));
	const newChoices = [];
	const consumedFreeIds = new Set();
	for (const member of result.members) {
		if (member.origin === "package") {
			const choice = originalChoices.get(member.choiceId);
			if (choice) newChoices.push(choice);
		} else {
			const row = freeById.get(member.entryId);
			if (!row) continue;
			consumedFreeIds.add(member.entryId);
			newChoices.push(...cloneArray(row.entry?.choices));
		}
	}

	const detachedChoices = cloneArray(packageEntry.choices).filter((choice) =>
		!result.members.some((member) => member.origin === "package" && member.choiceId === String(choice?.id ?? "")),
	);

	let next = entries.filter((entry) => !consumedFreeIds.has(String(entry?.id ?? "")));
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
	const content = `
		<div class="wfrp1ed career-package-builder">
			<p class="career-package-builder__intro">${escapeHtml(localize(
				"Select free Skills to join this Skill in one package.",
				"Wybierz wolne Umiejętności, które razem z tą Umiejętnością utworzą jeden pakiet.",
			))}</p>
			<div class="career-package-builder__choices">
				${rows.map((row) => {
					const seed = row.entryId === seedEntryId;
					return `<label class="career-package-builder__choice ${seed ? "career-package-builder__choice--seed" : ""}">
						<input type="checkbox" name="packageMember" value="${escapeHtml(row.entryId)}" ${seed ? "checked disabled" : ""}>
						<span>${escapeHtml(row.label)}</span>
						${seed ? `<small>${escapeHtml(localize("Starting row", "Wpis początkowy"))}</small>` : ""}
					</label>`;
				}).join("")}
			</div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Applies from initial Skill count", "Obowiązuje od liczby początkowych Umiejętności"))}<input type="number" name="minInitialSkills" min="1" step="1" value="${Math.max(1, integer(minInitialSkills, 1))}"></label>
				${modeControls(mode, choose, rows.length)}
			</div>
		</div>`;

	return DialogV2.wait({
		window: { title }, content, modal: true, rejectClose: false,
		render: (_event, dialog) => {
			const sync = () => {
				const selected = dialog.element.querySelectorAll('input[name="packageMember"]:checked').length;
				const chooseInput = dialog.element.querySelector('input[name="choose"]');
				if (chooseInput instanceof HTMLInputElement) {
					chooseInput.max = String(Math.max(1, selected));
					chooseInput.value = String(clampChoose(chooseInput.value, Math.max(1, selected)));
				}
				const button = dialog.element.querySelector('button[data-action="create"]');
				if (button instanceof HTMLButtonElement) button.disabled = selected < 2;
			};
			for (const checkbox of dialog.element.querySelectorAll('input[name="packageMember"]')) checkbox.addEventListener("change", sync);
			sync();
		},
		buttons: [{
			action: "create", label: localize("Create package", "Utwórz pakiet"), default: true,
			callback: (_event, button) => {
				const selectedEntryIds = [...button.form.querySelectorAll('input[name="packageMember"]:checked')].map((input) => String(input.value));
				if (selectedEntryIds.length < 2) return false;
				const data = new FormData(button.form);
				return {
					selectedEntryIds,
					minInitialSkills: Math.max(1, integer(data.get("minInitialSkills"), 1)),
					mode: normalizeMode(data.get("mode")),
					choose: clampChoose(data.get("choose"), selectedEntryIds.length),
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
			<div class="career-package-editor__members"></div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Applies from initial Skill count", "Obowiązuje od liczby początkowych Umiejętności"))}<input type="number" name="minInitialSkills" min="1" step="1" value="${Math.max(1, integer(packageEntry.minInitialSkills, 1))}"></label>
				${modeControls(packageEntry.mode, packageEntry.choose, Math.max(1, initialMembers.length))}
			</div>
			<p class="hint">${escapeHtml(localize("Removing a member returns it to the free racial Skill list; it does not delete the Skill.", "Usunięcie elementu przenosi go z powrotem na listę wolnych rasowych Umiejętności; nie usuwa Umiejętności."))}</p>
		</div>`;

	return DialogV2.wait({
		window: { title: localize("Edit racial Skill package", "Edytuj pakiet rasowych Umiejętności") }, content, modal: true, rejectClose: false,
		render: (_event, dialog) => {
			const list = dialog.element.querySelector(".career-package-editor__members");
			const add = dialog.element.querySelector("[data-package-add]");
			const render = () => {
				if (list instanceof HTMLElement) list.innerHTML = state.members.map((member) => `<div class="career-package-editor__member"><span>${escapeHtml(member.label)}</span><button type="button" data-remove="${escapeHtml(member.key)}"><i class="fa-solid fa-xmark"></i></button></div>`).join("");
				for (const button of list?.querySelectorAll?.("[data-remove]") ?? []) button.addEventListener("click", () => { state.members = state.members.filter((member) => member.key !== String(button.dataset.remove)); render(); });
				if (add instanceof HTMLButtonElement) add.disabled = freeRows.every((row) => state.members.some((member) => member.entryId === row.entryId));
			};
			add?.addEventListener("click", async () => {
				const available = freeRows.filter((row) => !state.members.some((member) => member.entryId === row.entryId));
				if (!available.length) return;
				const selected = await selectFreeRows(available);
				for (const id of selected ?? []) {
					const row = freeById.get(id);
					if (row) state.members.push({ key: `free:${id}`, origin: "free", entryId: id, label: row.label });
				}
				render();
			});
			render();
		},
		buttons: [{
			action: "save", label: localize("Save package", "Zapisz pakiet"), default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				return {
					members: state.members.map((member) => ({ origin: member.origin, choiceId: member.choiceId ?? "", entryId: member.entryId ?? "" })),
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
	return cloneArray(choice?.grants).map((grant) => {
		const name = String(grant?.name ?? grant?.rulesId ?? "").trim();
		const spec = String(grant?.specialisation ?? "").trim();
		return spec ? `${name} (${spec})` : name;
	}).filter(Boolean).join(" + ") || "—";
}

function normalizeMode(value) {
	const candidate = String(value ?? "");
	return Object.values(RACE_INITIAL_SKILL_MODE).includes(candidate)
		? candidate
		: RACE_INITIAL_SKILL_MODE.ALL;
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
