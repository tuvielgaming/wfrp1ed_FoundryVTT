import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const { DialogV2 } = foundry.applications.api;

installCareerPackageBuilder();

/**
 * Build Career packages from rows which are already attached to the Career.
 *
 * The builder reorganizes existing choices; it never duplicates or recreates
 * their grants. Rows may come from standalone entries or existing packages.
 * Choices left behind in an old package remain valid, and a one-choice remainder
 * is normalized back to an ordinary standalone entry.
 */
function installCareerPackageBuilder() {
	if (CareerItemSheet.__wfrpPackageBuilderInstalled === true) return;

	CareerItemSheet.DEFAULT_OPTIONS.actions ??= {};
	CareerItemSheet.DEFAULT_OPTIONS.actions.buildPackage = buildCareerPackage;

	const originalPrepareContext = CareerItemSheet.prototype._prepareContext;
	CareerItemSheet.prototype._prepareContext = async function packageBuilderContext(options) {
		const context = await originalPrepareContext.call(this, options);
		context.careerCompact ??= {};
		context.careerCompact.packageTitle = localize(
			"Build package from Career rows",
			"Utwórz pakiet z wpisów Profesji",
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
async function buildCareerPackage(_event, target) {
	if (!this.isEditable) return;

	const collectionName = String(target?.dataset?.careerCollection ?? "");
	if (!["skills", "trappings"].includes(collectionName)) return;

	const entries = cloneArray(this.document.system?.[collectionName]);
	const candidates = packageCandidates(entries);
	if (candidates.length < 2) {
		ui.notifications.info(localize(
			"Add at least two rows before creating a package.",
			"Dodaj co najmniej dwa wpisy przed utworzeniem pakietu.",
		));
		return;
	}

	const result = await packageBuilderDialog(candidates, collectionName);
	if (!result) return;

	const selectedKeys = new Set(result.selectedKeys);
	const nextEntries = rebuildEntries(entries, selectedKeys, {
		choose: result.choose,
		chance: result.chance,
	});
	if (!nextEntries) return;

	await this.document.update({ [`system.${collectionName}`]: nextEntries });
}

async function packageBuilderDialog(candidates, collectionName) {
	const kindLabel = collectionName === "skills"
		? localize("Skills", "Umiejętności")
		: localize("Trappings", "Wyposażenie");

	const content = `
		<div class="wfrp1ed career-package-builder">
			<p class="career-package-builder__intro">${escapeHtml(localize(
				`Select at least two ${kindLabel} rows which should form one package.`,
				`Wybierz co najmniej dwa wpisy ${kindLabel}, które mają utworzyć jeden pakiet.`,
			))}</p>
			<div class="career-package-builder__choices">
				${candidates.map((candidate) => `
					<label class="career-package-builder__choice">
						<input type="checkbox" name="packageMember" value="${escapeHtml(candidate.key)}">
						<span>${escapeHtml(candidate.label)}</span>
						${candidate.meta ? `<small>${escapeHtml(candidate.meta)}</small>` : ""}
					</label>
				`).join("")}
			</div>
			<div class="career-package-builder__settings">
				<label>${escapeHtml(localize("Player selects", "Gracz wybiera"))}
					<input type="number" name="choose" min="1" step="1" value="1">
				</label>
				<label>${escapeHtml(localize(
					"Initial Career acquisition chance (%)",
					"Szansa zdobycia w Profesji początkowej (%)",
				))}
					<input type="number" name="chance" min="0" max="100" step="1" value="100">
				</label>
			</div>
		</div>
	`;

	return DialogV2.wait({
		window: {
			title: localize("Build Career package", "Utwórz pakiet Profesji"),
		},
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
				if (chooseInput instanceof HTMLInputElement) {
					chooseInput.max = String(Math.max(1, selectedCount));
					let choose = Math.max(1, Math.trunc(Number(chooseInput.value) || 1));
					if (selectedCount > 0 && choose > selectedCount) choose = selectedCount;
					chooseInput.value = String(choose);
				}
				if (createButton instanceof HTMLButtonElement) {
					const choose = Math.max(1, Math.trunc(Number(chooseInput?.value) || 1));
					createButton.disabled = selectedCount < 2 || choose > selectedCount;
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
				const form = button.form;
				const selectedKeys = [...form.querySelectorAll(
					'input[name="packageMember"]:checked',
				)].map((input) => String(input.value));
				if (selectedKeys.length < 2) return false;

				const data = new FormData(form);
				const choose = Math.max(1, Math.trunc(Number(data.get("choose") ?? 1)));
				if (choose > selectedKeys.length) return false;

				return {
					selectedKeys,
					choose,
					chance: clampPercentage(data.get("chance")),
				};
			},
		}],
	});
}

function packageCandidates(entries) {
	const candidates = [];
	let packageNumber = 0;

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
		const entry = entries[entryIndex];
		const choices = Array.isArray(entry?.choices) ? entry.choices : [];
		const isPackage = choices.length > 1;
		const currentPackageNumber = isPackage ? ++packageNumber : 0;
		const packageMeta = isPackage
			? existingPackageMeta(entry, choices.length, currentPackageNumber)
			: "";

		for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
			candidates.push({
				key: candidateKey(entryIndex, choiceIndex),
				label: choiceLabel(choices[choiceIndex]),
				meta: packageMeta,
			});
		}
	}

	return candidates;
}

function rebuildEntries(entries, selectedKeys, { choose, chance }) {
	const selectedChoices = [];
	const selectedEntryIndexes = new Set();
	let firstSelectedEntryIndex = -1;

	for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
		const choices = Array.isArray(entries[entryIndex]?.choices) ? entries[entryIndex].choices : [];
		for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
			if (!selectedKeys.has(candidateKey(entryIndex, choiceIndex))) continue;
			if (firstSelectedEntryIndex < 0) firstSelectedEntryIndex = entryIndex;
			selectedEntryIndexes.add(entryIndex);
			selectedChoices.push(foundry.utils.deepClone(choices[choiceIndex]));
		}
	}

	if (selectedChoices.length < 2 || firstSelectedEntryIndex < 0) return null;

	const selectedCount = selectedChoices.length;
	const safeChoose = Math.max(1, Math.min(selectedCount, nonNegativeInteger(choose) || 1));
	const packageEntry = {
		id: foundry.utils.randomID(),
		chance: clampPercentage(chance),
		mode: safeChoose < selectedCount ? CAREER_ENTRY_MODE.PLAYER_CHOICE : CAREER_ENTRY_MODE.ALL,
		choose: safeChoose,
		note: sharedSourceNote(entries, selectedEntryIndexes),
		choices: selectedChoices,
	};

	const rebuilt = [];
	for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
		if (entryIndex === firstSelectedEntryIndex) rebuilt.push(packageEntry);

		const entry = entries[entryIndex];
		const choices = Array.isArray(entry?.choices) ? entry.choices : [];
		const keptChoices = choices.filter(
			(_choice, choiceIndex) => !selectedKeys.has(candidateKey(entryIndex, choiceIndex)),
		);
		if (!keptChoices.length) continue;

		const remaining = {
			...foundry.utils.deepClone(entry),
			choices: foundry.utils.deepClone(keptChoices),
		};
		normalizeRemainingEntry(remaining);
		rebuilt.push(remaining);
	}

	return rebuilt;
}

function normalizeRemainingEntry(entry) {
	const count = Array.isArray(entry?.choices) ? entry.choices.length : 0;
	if (count <= 1) {
		entry.mode = CAREER_ENTRY_MODE.ALL;
		entry.choose = 1;
		return;
	}
	if (String(entry.mode) === CAREER_ENTRY_MODE.PLAYER_CHOICE) {
		entry.choose = Math.max(1, Math.min(count, nonNegativeInteger(entry.choose) || 1));
		return;
	}
	if (String(entry.mode) === CAREER_ENTRY_MODE.RANDOM_CHOICE) entry.choose = 1;
}

function sharedSourceNote(entries, selectedEntryIndexes) {
	if (selectedEntryIndexes.size !== 1) return "";
	const [entryIndex] = selectedEntryIndexes;
	return String(entries[entryIndex]?.note ?? "").trim();
}

function existingPackageMeta(entry, choiceCount, packageNumber) {
	const chance = clampPercentage(entry?.chance);
	let text;
	if (String(entry?.mode) === CAREER_ENTRY_MODE.PLAYER_CHOICE) {
		const choose = Math.max(1, Math.min(choiceCount, nonNegativeInteger(entry?.choose) || 1));
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

function candidateKey(entryIndex, choiceIndex) {
	return `${entryIndex}:${choiceIndex}`;
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
