import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const { DialogV2 } = foundry.applications.api;

installCareerPackageBuilder();

/**
 * Packages are authored from standalone Career rows only.
 *
 * - Every free Skill/Trapping row may start a package.
 * - Existing package members are never candidates for another package.
 * - A package is edited as one group: members can be detached back to free
 *   rows, free rows can be added, and choose/chance remain package-level data.
 * - Grant data is moved, never copied, so package editing cannot duplicate a
 *   Skill or Trapping.
 */
function installCareerPackageBuilder() {
	if (CareerItemSheet.__wfrpPackageBuilderInstalled === true) return;

	CareerItemSheet.DEFAULT_OPTIONS.actions ??= {};
	delete CareerItemSheet.DEFAULT_OPTIONS.actions.buildPackage;
	CareerItemSheet.DEFAULT_OPTIONS.actions.createPackage = createCareerPackage;
	CareerItemSheet.DEFAULT_OPTIONS.actions.editPackage = editCareerPackage;

	const originalPrepareContext = CareerItemSheet.prototype._prepareContext;
	CareerItemSheet.prototype._prepareContext = async function packageBuilderContext(options) {
		const context = await originalPrepareContext.call(this, options);
		context.careerCompact ??= {};
		context.careerCompact.skills = presentCareerGroups(
			this.document.system?.skills,
			"skills",
		);
		context.careerCompact.trappings = presentCareerGroups(
			this.document.system?.trappings,
			"trappings",
		);
		context.careerCompact.createPackageTitle = localize(
			"Create package from this row",
			"Utwórz pakiet z tego wpisu",
		);
		context.careerCompact.editPackageTitle = localize(
			"Edit package",
			"Edytuj pakiet",
		);
		return context;
	};

	Object.defineProperty(
		CareerItemSheet,
		"__wfrpPackageBuilderInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

/** @this {CareerItemSheet} */
async function createCareerPackage(_event, target) {
	if (!this.isEditable) return;

	const collectionName = String(target?.dataset?.careerCollection ?? "");
	const seedEntryId = String(target?.dataset?.careerEntryId ?? "");
	if (!["skills", "trappings"].includes(collectionName) || !seedEntryId) return;

	const entries = cloneArray(this.document.system?.[collectionName]);
	const freeRows = freeCandidates(entries);
	const seed = freeRows.find((candidate) => candidate.entryId === seedEntryId);
	if (!seed) return;

	if (freeRows.length < 2) {
		ui.notifications.info(localize(
			"At least two free rows are required to create a package.",
			"Do utworzenia pakietu potrzebne są co najmniej dwa wolne wpisy.",
		));
		return;
	}

	const result = await createPackageDialog(freeRows, seed, collectionName);
	if (!result) return;

	const nextEntries = buildNewPackage(entries, result.selectedEntryIds, {
		choose: result.choose,
		chance: result.chance,
	});
	if (!nextEntries) return;

	await this.document.update({ [`system.${collectionName}`]: nextEntries });
}

/** @this {CareerItemSheet} */
async function editCareerPackage(_event, target) {
	if (!this.isEditable) return;

	const collectionName = String(target?.dataset?.careerCollection ?? "");
	const packageEntryId = String(target?.dataset?.careerEntryId ?? "");
	if (!["skills", "trappings"].includes(collectionName) || !packageEntryId) return;

	const entries = cloneArray(this.document.system?.[collectionName]);
	const packageEntry = entries.find(
		(entry) => String(entry?.id ?? "") === packageEntryId,
	);
	if (!packageEntry || !Array.isArray(packageEntry.choices) || packageEntry.choices.length < 2) {
		return;
	}

	const freeRows = freeCandidates(entries);
	const result = await editPackageDialog(packageEntry, freeRows, collectionName);
	if (!result) return;

	const nextEntries = applyPackageEdit(entries, packageEntryId, result);
	if (!nextEntries) return;

	await this.document.update({ [`system.${collectionName}`]: nextEntries });
}

async function createPackageDialog(freeRows, seed, collectionName) {
	const kindLabel = collectionName === "skills"
		? localize("Skills", "Umiejętności")
		: localize("Trappings", "Wyposażenie");
	const defaultChance = clampPercentage(seed.chance);

	const content = `
		<div class="wfrp1ed career-package-builder">
			<p class="career-package-builder__intro">${escapeHtml(localize(
				`Select free ${kindLabel} rows to join this row in one package.`,
				`Wybierz wolne wpisy ${kindLabel}, które mają razem z tym wpisem utworzyć jeden pakiet.`,
			))}</p>
			<div class="career-package-builder__choices">
				${freeRows.map((candidate) => {
					const isSeed = candidate.entryId === seed.entryId;
					return `
						<label class="career-package-builder__choice ${isSeed ? "career-package-builder__choice--seed" : ""}">
							<input type="checkbox" name="packageMember" value="${escapeHtml(candidate.entryId)}" ${isSeed ? "checked disabled" : ""}>
							<span>${escapeHtml(candidate.label)}</span>
							${isSeed ? `<small>${escapeHtml(localize("Starting row", "Wpis początkowy"))}</small>` : ""}
						</label>
					`;
				}).join("")}
			</div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Player selects", "Gracz wybiera"))}
					<input type="number" name="choose" min="1" step="1" value="1">
				</label>
				<label>${escapeHtml(localize(
					"Initial Career acquisition chance (%)",
					"Szansa zdobycia w Profesji początkowej (%)",
				))}
					<input type="number" name="chance" min="0" max="100" step="1" value="${defaultChance}">
				</label>
			</div>
		</div>
	`;

	return DialogV2.wait({
		window: { title: localize("Create Career package", "Utwórz pakiet Profesji") },
		content,
		modal: true,
		rejectClose: false,
		render: (_event, dialog) => {
			const checkboxes = [...dialog.element.querySelectorAll(
				'input[type="checkbox"][name="packageMember"]',
			)];
			const chooseInput = dialog.element.querySelector('input[name="choose"]');
			const createButton = dialog.element.querySelector('button[data-action="createPackage"]');

			const sync = () => {
				const selectedCount = checkboxes.filter((input) => input.checked).length;
				syncChooseInput(chooseInput, selectedCount);
				if (createButton instanceof HTMLButtonElement) {
					createButton.disabled = selectedCount < 2;
				}
			};

			for (const checkbox of checkboxes) checkbox.addEventListener("change", sync);
			chooseInput?.addEventListener("input", sync);
			sync();
		},
		buttons: [{
			action: "createPackage",
			label: localize("Create package", "Utwórz pakiet"),
			default: true,
			callback: (_event, button) => {
				const selectedEntryIds = [...button.form.querySelectorAll(
					'input[name="packageMember"]:checked',
				)].map((input) => String(input.value));
				if (selectedEntryIds.length < 2) return false;

				const data = new FormData(button.form);
				return {
					selectedEntryIds,
					choose: clampChoose(data.get("choose"), selectedEntryIds.length),
					chance: clampPercentage(data.get("chance")),
				};
			},
		}],
	});
}

async function editPackageDialog(packageEntry, freeRows, collectionName) {
	const state = {
		members: (packageEntry.choices ?? []).map((choice) => ({
			key: `package:${String(choice?.id ?? foundry.utils.randomID())}`,
			origin: "package",
			choiceId: String(choice?.id ?? ""),
			label: choiceLabel(choice),
		})),
	};
	const freeById = new Map(freeRows.map((row) => [row.entryId, row]));
	const initialChoose = clampChoose(packageEntry.choose, state.members.length);

	const content = `
		<div class="wfrp1ed career-package-editor">
			<div class="career-package-editor__heading">
				<strong>${escapeHtml(localize("Package members", "Elementy pakietu"))}</strong>
				<button type="button" class="career-package-editor__add" data-package-add title="${escapeHtml(localize("Add free rows", "Dodaj wolne wpisy"))}">
					<i class="fa-solid fa-plus"></i>
				</button>
			</div>
			<div class="career-package-editor__members"></div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Player selects", "Gracz wybiera"))}
					<input type="number" name="choose" min="1" step="1" value="${initialChoose}">
				</label>
				<label>${escapeHtml(localize(
					"Initial Career acquisition chance (%)",
					"Szansa zdobycia w Profesji początkowej (%)",
				))}
					<input type="number" name="chance" min="0" max="100" step="1" value="${clampPercentage(packageEntry.chance)}">
				</label>
			</div>
			<p class="hint">${escapeHtml(localize(
				"Removing a member here returns it to the free Career list; it does not delete the Skill or Equipment from the Career.",
				"Usunięcie elementu tutaj przenosi go z powrotem na listę wolnych wpisów Profesji; nie usuwa Umiejętności ani Wyposażenia z Profesji.",
			))}</p>
		</div>
	`;

	return DialogV2.wait({
		window: { title: localize("Edit Career package", "Edytuj pakiet Profesji") },
		content,
		modal: true,
		rejectClose: false,
		render: (_event, dialog) => {
			const memberList = dialog.element.querySelector(".career-package-editor__members");
			const addButton = dialog.element.querySelector("[data-package-add]");
			const chooseInput = dialog.element.querySelector('input[name="choose"]');

			const availableFreeRows = () => {
				const alreadyAdded = new Set(
					state.members
						.filter((member) => member.origin === "free")
						.map((member) => member.entryId),
				);
				return freeRows.filter((row) => !alreadyAdded.has(row.entryId));
			};

			const sync = () => {
				syncChooseInput(chooseInput, state.members.length);
				if (addButton instanceof HTMLButtonElement) {
					addButton.disabled = availableFreeRows().length === 0;
				}
			};

			const renderMembers = () => {
				if (!(memberList instanceof HTMLElement)) return;
				memberList.innerHTML = state.members.length
					? state.members.map((member) => packageMemberHtml(member)).join("")
					: `<p class="career-package-editor__empty">${escapeHtml(localize("No members. Saving will dissolve the package.", "Brak elementów. Zapisanie rozwiąże pakiet."))}</p>`;
				sync();
			};

			memberList?.addEventListener("click", (event) => {
				const removeButton = event.target?.closest?.("[data-package-remove]");
				if (!removeButton) return;
				const key = String(removeButton.dataset.packageRemove ?? "");
				state.members = state.members.filter((member) => member.key !== key);
				renderMembers();
			});

			addButton?.addEventListener("click", async () => {
				const available = availableFreeRows();
				if (!available.length) return;
				const selectedIds = await selectFreeRowsDialog(available, collectionName);
				if (!Array.isArray(selectedIds) || !selectedIds.length) return;

				for (const entryId of selectedIds) {
					const row = freeById.get(entryId);
					if (!row) continue;
					state.members.push({
						key: `free:${entryId}`,
						origin: "free",
						entryId,
						label: row.label,
					});
				}
				renderMembers();
			});

			chooseInput?.addEventListener("input", sync);
			renderMembers();
		},
		buttons: [{
			action: "savePackage",
			label: localize("Save package", "Zapisz pakiet"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				return {
					members: state.members.map((member) => ({
						origin: member.origin,
						choiceId: member.choiceId ?? "",
						entryId: member.entryId ?? "",
					})),
					choose: clampChoose(data.get("choose"), Math.max(1, state.members.length)),
					chance: clampPercentage(data.get("chance")),
				};
			},
		}],
	});
}

async function selectFreeRowsDialog(freeRows, collectionName) {
	const kindLabel = collectionName === "skills"
		? localize("Skills", "Umiejętności")
		: localize("Trappings", "Wyposażenie");
	const content = `
		<div class="wfrp1ed career-package-add-dialog">
			<p>${escapeHtml(localize(
				`Select free ${kindLabel} rows to add to this package.`,
				`Wybierz wolne wpisy ${kindLabel}, które chcesz dodać do tego pakietu.`,
			))}</p>
			<div class="career-package-builder__choices">
				${freeRows.map((row) => `
					<label class="career-package-builder__choice">
						<input type="checkbox" name="freePackageMember" value="${escapeHtml(row.entryId)}">
						<span>${escapeHtml(row.label)}</span>
					</label>
				`).join("")}
			</div>
		</div>
	`;

	return DialogV2.wait({
		window: { title: localize("Add package members", "Dodaj elementy pakietu") },
		content,
		modal: true,
		rejectClose: false,
		render: (_event, dialog) => {
			const checkboxes = [...dialog.element.querySelectorAll(
				'input[name="freePackageMember"]',
			)];
			const addButton = dialog.element.querySelector('button[data-action="addRows"]');
			const sync = () => {
				if (addButton instanceof HTMLButtonElement) {
					addButton.disabled = !checkboxes.some((checkbox) => checkbox.checked);
				}
			};
			for (const checkbox of checkboxes) checkbox.addEventListener("change", sync);
			sync();
		},
		buttons: [{
			action: "addRows",
			label: localize("Add selected", "Dodaj wybrane"),
			default: true,
			callback: (_event, button) => [...button.form.querySelectorAll(
				'input[name="freePackageMember"]:checked',
			)].map((input) => String(input.value)),
		}],
	});
}

function buildNewPackage(entries, selectedEntryIds, { choose, chance }) {
	const selected = new Set(selectedEntryIds.map(String));
	const selectedEntries = entries.filter(
		(entry) => selected.has(String(entry?.id ?? "")) && isFreeEntry(entry),
	);
	if (selectedEntries.length < 2) return null;

	const firstSelectedIndex = entries.findIndex(
		(entry) => selected.has(String(entry?.id ?? "")) && isFreeEntry(entry),
	);
	if (firstSelectedIndex < 0) return null;

	const choices = selectedEntries.map((entry) => foundry.utils.deepClone(entry.choices[0]));
	const safeChoose = clampChoose(choose, choices.length);
	const packageEntry = {
		id: foundry.utils.randomID(),
		chance: clampPercentage(chance),
		mode: safeChoose < choices.length ? CAREER_ENTRY_MODE.PLAYER_CHOICE : CAREER_ENTRY_MODE.ALL,
		choose: safeChoose,
		note: sharedFreeNote(selectedEntries),
		choices,
	};

	const rebuilt = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (index === firstSelectedIndex) rebuilt.push(packageEntry);
		if (selected.has(String(entry?.id ?? "")) && isFreeEntry(entry)) continue;
		rebuilt.push(foundry.utils.deepClone(entry));
	}
	return rebuilt;
}

function applyPackageEdit(entries, packageEntryId, result) {
	const packageIndex = entries.findIndex(
		(entry) => String(entry?.id ?? "") === String(packageEntryId),
	);
	if (packageIndex < 0) return null;

	const originalPackage = entries[packageIndex];
	const originalChoices = Array.isArray(originalPackage?.choices)
		? originalPackage.choices
		: [];
	const originalById = new Map(
		originalChoices.map((choice) => [String(choice?.id ?? ""), choice]),
	);
	const freeById = new Map(
		entries
			.filter(isFreeEntry)
			.map((entry) => [String(entry?.id ?? ""), entry]),
	);

	const memberChoices = [];
	const retainedOriginalIds = new Set();
	const absorbedFreeIds = new Set();

	for (const member of result.members ?? []) {
		if (member.origin === "package") {
			const choice = originalById.get(String(member.choiceId ?? ""));
			if (!choice) continue;
			retainedOriginalIds.add(String(member.choiceId ?? ""));
			memberChoices.push(foundry.utils.deepClone(choice));
			continue;
		}
		if (member.origin === "free") {
			const entry = freeById.get(String(member.entryId ?? ""));
			if (!entry) continue;
			absorbedFreeIds.add(String(member.entryId ?? ""));
			memberChoices.push(foundry.utils.deepClone(entry.choices[0]));
		}
	}

	/* A package with fewer than two members no longer has package semantics.
	 * Dissolve the original package completely; any free rows tentatively added
	 * during this edit stay where they already were. */
	if (memberChoices.length < 2) {
		const rebuilt = [];
		for (let index = 0; index < entries.length; index += 1) {
			if (index !== packageIndex) {
				rebuilt.push(foundry.utils.deepClone(entries[index]));
				continue;
			}
			for (const choice of originalChoices) {
				rebuilt.push(standaloneEntryFromChoice(choice, originalPackage));
			}
		}
		return rebuilt;
	}

	const detachedChoices = originalChoices.filter(
		(choice) => !retainedOriginalIds.has(String(choice?.id ?? "")),
	);
	const safeChoose = clampChoose(result.choose, memberChoices.length);
	const updatedPackage = {
		...foundry.utils.deepClone(originalPackage),
		chance: clampPercentage(result.chance),
		mode: safeChoose < memberChoices.length ? CAREER_ENTRY_MODE.PLAYER_CHOICE : CAREER_ENTRY_MODE.ALL,
		choose: safeChoose,
		choices: memberChoices,
	};

	const rebuilt = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const entryId = String(entry?.id ?? "");
		if (index === packageIndex) {
			rebuilt.push(updatedPackage);
			for (const choice of detachedChoices) {
				rebuilt.push(standaloneEntryFromChoice(choice, originalPackage));
			}
			continue;
		}
		if (absorbedFreeIds.has(entryId) && isFreeEntry(entry)) continue;
		rebuilt.push(foundry.utils.deepClone(entry));
	}
	return rebuilt;
}

function presentCareerGroups(source, collectionName) {
	const groups = [];
	let packageNumber = 0;

	for (const entry of cloneArray(source)) {
		const choices = Array.isArray(entry?.choices) ? entry.choices : [];
		if (!choices.length) continue;

		if (choices.length === 1) {
			groups.push({
				isPackage: false,
				collectionName,
				entryId: String(entry?.id ?? ""),
				choiceId: String(choices[0]?.id ?? ""),
				label: choiceLabel(choices[0]),
				note: String(entry?.note ?? "").trim(),
				metaLabel: clampPercentage(entry?.chance) < 100
					? `${clampPercentage(entry.chance)}%`
					: "",
			});
			continue;
		}

		packageNumber += 1;
		groups.push({
			isPackage: true,
			collectionName,
			entryId: String(entry?.id ?? ""),
			metaLabel: existingPackageMeta(entry, choices.length, packageNumber),
			note: String(entry?.note ?? "").trim(),
			members: choices.map((choice) => ({
				choiceId: String(choice?.id ?? ""),
				label: choiceLabel(choice),
			})),
		});
	}

	return groups;
}

function freeCandidates(entries) {
	return entries
		.filter(isFreeEntry)
		.map((entry) => ({
			entryId: String(entry?.id ?? ""),
			label: choiceLabel(entry.choices[0]),
			chance: clampPercentage(entry?.chance),
		}));
}

function isFreeEntry(entry) {
	return Array.isArray(entry?.choices) && entry.choices.length === 1;
}

function standaloneEntryFromChoice(choice, sourceEntry) {
	return {
		id: foundry.utils.randomID(),
		chance: clampPercentage(sourceEntry?.chance),
		mode: CAREER_ENTRY_MODE.ALL,
		choose: 1,
		note: String(sourceEntry?.note ?? "").trim(),
		choices: [foundry.utils.deepClone(choice)],
	};
}

function sharedFreeNote(entries) {
	const notes = entries.map((entry) => String(entry?.note ?? "").trim());
	if (!notes.length) return "";
	return notes.every((note) => note === notes[0]) ? notes[0] : "";
}

function packageMemberHtml(member) {
	return `
		<div class="career-package-editor__member">
			<span>${escapeHtml(member.label)}</span>
			<button type="button" data-package-remove="${escapeHtml(member.key)}" title="${escapeHtml(localize("Remove from package", "Usuń z pakietu"))}">
				<i class="fa-solid fa-minus"></i>
			</button>
		</div>
	`;
}

function existingPackageMeta(entry, choiceCount, packageNumber) {
	const chance = clampPercentage(entry?.chance);
	let text;
	if (String(entry?.mode) === CAREER_ENTRY_MODE.PLAYER_CHOICE) {
		const choose = clampChoose(entry?.choose, choiceCount);
		text = localize(
			`Package ${packageNumber}: choose ${choose} of ${choiceCount}`,
			`Pakiet ${packageNumber}: wybierz ${choose} z ${choiceCount}`,
		);
	} else if (String(entry?.mode) === CAREER_ENTRY_MODE.RANDOM_CHOICE) {
		text = localize(
			`Package ${packageNumber}: random 1 of ${choiceCount}`,
			`Pakiet ${packageNumber}: losowo 1 z ${choiceCount}`,
		);
	} else {
		text = localize(
			`Package ${packageNumber}: all ${choiceCount}`,
			`Pakiet ${packageNumber}: wszystkie ${choiceCount}`,
		);
	}
	return chance < 100 ? `${text} • ${chance}%` : text;
}

function choiceLabel(choice) {
	const explicit = String(choice?.label ?? "").trim();
	if (explicit) return explicit;
	return (choice?.grants ?? [])
		.map(grantDisplayName)
		.filter(Boolean)
		.join(" + ");
}

function grantDisplayName(grant) {
	const document = resolvedDocument(grant);
	const name = String(document?.name ?? grant?.name ?? grant?.rulesId ?? "").trim();
	const specialisation = String(
		grant?.specialisation || document?.system?.specialisation || document?.system?.specialization || "",
	).trim();
	return specialisation ? `${name} (${specialisation})` : name;
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

function syncChooseInput(input, memberCount) {
	if (!(input instanceof HTMLInputElement)) return;
	if (memberCount <= 0) {
		input.disabled = true;
		input.max = "1";
		input.value = "1";
		return;
	}
	input.disabled = false;
	input.max = String(memberCount);
	input.value = String(clampChoose(input.value, memberCount));
}

function clampChoose(value, count) {
	const maximum = Math.max(1, nonNegativeInteger(count) || 1);
	const numeric = Math.max(1, nonNegativeInteger(value) || 1);
	return Math.min(maximum, numeric);
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

function escapeHtml(value) {
	return foundry.utils.escapeHTML(String(value ?? ""));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
