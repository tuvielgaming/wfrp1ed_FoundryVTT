import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { RACE_INITIAL_SKILL_MODE } from "../data-models/item/RaceData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const INTERNAL_MIME = "application/x-wfrp1ed-skill-authoring";
const STYLE_ID = "wfrp1ed-unified-skill-drag-style";

install();

/**
 * Shared Skill authoring gesture language.
 *
 * General drop on either sheet -> standalone Skill list.
 * Free row -> free row           -> package.
 * Free/package member -> package -> move into package.
 * Package member -> general area -> detach to standalone row.
 * Race random Skill table is a more specific external-drop target and is left
 * to RaceItemSheet's existing table authoring handler.
 */
function install() {
	installStyle();
	wrapSheet(CareerItemSheet, "career");
	wrapSheet(RaceItemSheet, "race");
}

function wrapSheet(SheetClass, kind) {
	const marker = `__wfrpUnifiedSkillDrag_${kind}`;
	if (SheetClass.prototype[marker] === true) return;
	const originalRender = SheetClass.prototype._onRender;
	SheetClass.prototype._onRender = function unifiedSkillDragRender(context, options) {
		originalRender.call(this, context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement) || !this.isEditable) return;
		if (kind === "career") decorateCareer(this, root);
		else decorateRace(this, root);
		bindRoot(this, root, kind);
	};
	Object.defineProperty(SheetClass.prototype, marker, { value: true, configurable: false });
}

function decorateCareer(sheet, root) {
	for (const row of root.querySelectorAll('[data-career-panel="skills"] .career-compact-row[data-career-entry-id]')) {
		row.draggable = true;
		row.classList.add("wfrp1ed-skill-draggable");
	}
	for (const packageNode of root.querySelectorAll('[data-career-panel="skills"] .career-compact-package[data-career-entry-id]')) {
		ensurePackageDelete(packageNode, sheet, "career");
	}
}

function decorateRace(sheet, root) {
	for (const row of root.querySelectorAll('.race-mandatory-compact-row[data-race-entry-id]')) {
		const entry = findEntry(sheet.document.system?.mandatorySkills, row.dataset.raceEntryId);
		row.dataset.raceChoiceId = String(entry?.choices?.[0]?.id ?? "");
		row.draggable = true;
		row.classList.add("wfrp1ed-skill-draggable");
	}

	for (const packageNode of root.querySelectorAll('.race-mandatory-compact-package[data-race-entry-id]')) {
		const entry = findEntry(sheet.document.system?.mandatorySkills, packageNode.dataset.raceEntryId);
		const choices = Array.isArray(entry?.choices) ? entry.choices : [];
		const members = [...packageNode.querySelectorAll('.career-compact-package__member')];
		for (let index = 0; index < members.length; index += 1) {
			const member = members[index];
			const choice = choices[index];
			if (!(member instanceof HTMLElement) || !choice) continue;
			member.dataset.raceEntryId = String(entry?.id ?? "");
			member.dataset.raceChoiceId = String(choice?.id ?? "");
			member.draggable = true;
			member.classList.add("wfrp1ed-skill-draggable");
			ensureRaceMemberControls(member, sheet);
		}
		packageNode.querySelector(".race-mandatory-package-actions")?.remove();
		ensurePackageDelete(packageNode, sheet, "race");
	}
}

function bindRoot(sheet, root, kind) {
	if (root.dataset.wfrpUnifiedSkillDragBound === "true") return;
	root.dataset.wfrpUnifiedSkillDragBound = "true";

	root.addEventListener("dragstart", (event) => {
		if (event.target?.closest?.("button, input, select, textarea")) return;
		const payload = internalPayload(event.target, kind);
		if (!payload || !event.dataTransfer) return;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(INTERNAL_MIME, JSON.stringify(payload));
		event.dataTransfer.setData("text/plain", JSON.stringify({ type: "WFRP1EDSkillAuthoring", ...payload }));
	});

	root.addEventListener("dragover", (event) => {
		const internal = readInternal(event);
		const foundryData = internal ? null : readFoundryData(event);
		if (!internal && foundryData?.type !== "Item") return;
		const target = dropTarget(root, event.target, kind, { external: !internal });
		if (!target) return;
		event.preventDefault();
		clearHighlights(root);
		target.highlight?.classList.add("wfrp1ed-skill-drop-over");
	});

	root.addEventListener("dragleave", (event) => {
		if (root.contains(event.relatedTarget)) return;
		clearHighlights(root);
	});

	root.addEventListener("dragend", () => clearHighlights(root));

	root.addEventListener("drop", (event) => {
		const internal = readInternal(event);
		const foundryData = internal ? null : readFoundryData(event);
		const target = dropTarget(root, event.target, kind, { external: !internal });
		clearHighlights(root);
		if (!target) return;

		if (internal) {
			event.preventDefault();
			event.stopImmediatePropagation();
			void handleInternal(sheet, kind, internal, target).catch(reportError);
			return;
		}

		if (foundryData?.type !== "Item") return;
		const document = resolveItemSync(foundryData);
		if (!(document instanceof foundry.documents.Item)) return;

		/* Random initial-Skill tables are owned by RaceItemSheet. Do not consume
		 * this drop; its existing handler appends the row and calculates the next
		 * K100 range. We only provide the shared highlight above. */
		if (kind === "race" && target.type === "random-table" && document.type === "skill") return;
		if (document.type !== "skill") return;

		event.preventDefault();
		event.stopImmediatePropagation();
		void handleExternal(sheet, kind, document, target).catch(reportError);
	}, true);
}

function internalPayload(target, kind) {
	if (!(target instanceof Element)) return null;
	if (kind === "career") {
		const row = target.closest('[data-career-panel="skills"] .career-compact-row[data-career-entry-id]');
		if (!(row instanceof HTMLElement)) return null;
		return {
			kind,
			entryId: String(row.dataset.careerEntryId ?? ""),
			choiceId: String(row.dataset.careerChoiceId ?? ""),
		};
	}
	const row = target.closest('.race-mandatory-section .career-compact-row[data-race-entry-id]');
	if (!(row instanceof HTMLElement)) return null;
	return {
		kind,
		entryId: String(row.dataset.raceEntryId ?? ""),
		choiceId: String(row.dataset.raceChoiceId ?? ""),
	};
}

function dropTarget(root, target, kind, { external }) {
	if (!(target instanceof Element)) return null;
	if (kind === "race" && external) {
		const randomTable = target.closest('[data-race-drop-zone="skillTable"]');
		if (randomTable instanceof HTMLElement) {
			return { type: "random-table", highlight: randomTable };
		}
	}

	if (kind === "career") {
		const packageNode = target.closest('[data-career-panel="skills"] .career-compact-package[data-career-entry-id]');
		if (packageNode instanceof HTMLElement) {
			return { type: "package", entryId: String(packageNode.dataset.careerEntryId ?? ""), highlight: packageNode };
		}
		const row = target.closest('[data-career-panel="skills"] .career-compact-row[data-career-entry-id]');
		if (row instanceof HTMLElement && !row.closest(".career-compact-package")) {
			return { type: "row", entryId: String(row.dataset.careerEntryId ?? ""), highlight: row };
		}
		const panel = root.querySelector('[data-career-panel="skills"]');
		const hint = panel?.querySelector?.(".career-compact-drop-hint");
		return { type: "list", highlight: hint instanceof HTMLElement ? hint : panel };
	}

	const packageNode = target.closest('.race-mandatory-compact-package[data-race-entry-id]');
	if (packageNode instanceof HTMLElement) {
		return { type: "package", entryId: String(packageNode.dataset.raceEntryId ?? ""), highlight: packageNode };
	}
	const row = target.closest('.race-mandatory-compact-row[data-race-entry-id]');
	if (row instanceof HTMLElement) {
		return { type: "row", entryId: String(row.dataset.raceEntryId ?? ""), highlight: row };
	}
	const section = root.querySelector(".race-mandatory-section");
	return { type: "list", highlight: section };
}

async function handleExternal(sheet, kind, document, target) {
	if (kind === "career") {
		const entries = cloneArray(sheet.document.system?.skills);
		const grant = careerGrant(document);
		if (grantPresent(entries, grant)) return notifyDuplicate(kind, grantName(grant));
		const choice = choiceFromGrant(grant);
		const next = target.type === "package"
			? addChoiceToPackage(entries, target.entryId, choice, "career")
			: target.type === "row"
				? mergeWithFreeTarget(entries, target.entryId, choice, "career")
				: [...entries, careerStandalone(choice, null)];
		await sheet.document.update({ "system.skills": next });
		return;
	}

	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const grant = raceGrant(document);
	if (grantPresent(entries, grant)) return notifyDuplicate(kind, grantName(grant));
	const choice = choiceFromGrant(grant);
	const next = target.type === "package"
		? addChoiceToPackage(entries, target.entryId, choice, "race")
		: target.type === "row"
			? mergeWithFreeTarget(entries, target.entryId, choice, "race")
			: [...entries, raceStandalone(choice, null)];
	await sheet.document.update({ "system.mandatorySkills": next });
}

async function handleInternal(sheet, kind, source, target) {
	if (source.kind !== kind) return;
	const path = kind === "career" ? "skills" : "mandatorySkills";
	const entries = cloneArray(sheet.document.system?.[path]);
	const sourceEntry = findEntry(entries, source.entryId);
	const sourceChoice = findChoice(sourceEntry, source.choiceId);
	if (!sourceEntry || !sourceChoice) return;

	if (target.type === "list" || target.type === "random-table") {
		if ((sourceEntry.choices ?? []).length <= 1) return;
		const next = detachChoice(entries, source.entryId, source.choiceId, kind);
		await sheet.document.update({ [`system.${path}`]: next });
		return;
	}
	if (String(target.entryId ?? "") === String(source.entryId ?? "")) return;

	let next = removeChoiceForMove(entries, source.entryId, source.choiceId, kind);
	next = target.type === "package"
		? addChoiceToPackage(next, target.entryId, sourceChoice, kind)
		: mergeWithFreeTarget(next, target.entryId, sourceChoice, kind);
	await sheet.document.update({ [`system.${path}`]: next });
}

function detachChoice(entries, entryId, choiceId, kind) {
	const next = cloneArray(entries);
	const index = next.findIndex((entry) => String(entry?.id ?? "") === String(entryId));
	if (index < 0) return next;
	const source = next[index];
	const choices = cloneArray(source?.choices);
	const detached = choices.find((choice) => String(choice?.id ?? "") === String(choiceId));
	if (!detached) return next;
	source.choices = choices.filter((choice) => String(choice?.id ?? "") !== String(choiceId));
	normalizeAfterRemoval(next, index, kind);
	const standalone = kind === "career" ? careerStandalone(detached, source) : raceStandalone(detached, source);
	next.splice(Math.min(index + 1, next.length), 0, standalone);
	return next;
}

function removeChoiceForMove(entries, entryId, choiceId, kind) {
	const next = cloneArray(entries);
	const index = next.findIndex((entry) => String(entry?.id ?? "") === String(entryId));
	if (index < 0) return next;
	const source = next[index];
	const choices = cloneArray(source?.choices);
	if (choices.length <= 1) {
		next.splice(index, 1);
		return next;
	}
	source.choices = choices.filter((choice) => String(choice?.id ?? "") !== String(choiceId));
	normalizeAfterRemoval(next, index, kind);
	return next;
}

function normalizeAfterRemoval(entries, index, kind) {
	const entry = entries[index];
	if (!entry) return;
	const count = Array.isArray(entry.choices) ? entry.choices.length : 0;
	if (!count) {
		entries.splice(index, 1);
		return;
	}
	if (count === 1) {
		entry.mode = kind === "career" ? CAREER_ENTRY_MODE.ALL : RACE_INITIAL_SKILL_MODE.ALL;
		entry.choose = 1;
	}
}

function addChoiceToPackage(entries, targetId, choice, kind) {
	const next = cloneArray(entries);
	const target = findEntryMutable(next, targetId);
	if (!target) return next;
	target.choices = [...cloneArray(target.choices), foundry.utils.deepClone(choice)];
	if (target.choices.length > 1 && String(target.mode) === "all") {
		target.mode = kind === "career" ? CAREER_ENTRY_MODE.PLAYER_CHOICE : RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE;
		target.choose = 1;
	}
	return next;
}

function mergeWithFreeTarget(entries, targetId, choice, kind) {
	const next = cloneArray(entries);
	const target = findEntryMutable(next, targetId);
	if (!target) return next;
	if ((target.choices ?? []).length > 1) return addChoiceToPackage(next, targetId, choice, kind);
	target.choices = [target.choices?.[0], foundry.utils.deepClone(choice)].filter(Boolean);
	target.mode = kind === "career" ? CAREER_ENTRY_MODE.PLAYER_CHOICE : RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE;
	target.choose = 1;
	return next;
}

function ensureRaceMemberControls(member, sheet) {
	if (member.querySelector(".career-compact-row__controls")) return;
	const controls = document.createElement("div");
	controls.className = "career-compact-row__controls";
	controls.innerHTML = `
		<button type="button" data-race-skill-configure data-race-entry-id="${escapeHtml(member.dataset.raceEntryId)}" data-race-choice-id="${escapeHtml(member.dataset.raceChoiceId)}" title="${escapeHtml(localize("Configure Skill", "Konfiguruj Umiejętność"))}"><i class="fa-solid fa-gear"></i></button>
		<button type="button" data-race-member-delete title="${escapeHtml(localize("Delete from Race", "Usuń z Rasy"))}"><i class="fa-solid fa-trash"></i></button>`;
	member.append(controls);
	controls.querySelector("[data-race-member-delete]")?.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		const entries = cloneArray(sheet.document.system?.mandatorySkills);
		const index = entries.findIndex((entry) => String(entry?.id ?? "") === String(member.dataset.raceEntryId ?? ""));
		if (index < 0) return;
		entries[index].choices = cloneArray(entries[index].choices).filter(
			(choice) => String(choice?.id ?? "") !== String(member.dataset.raceChoiceId ?? ""),
		);
		normalizeAfterRemoval(entries, index, "race");
		await sheet.document.update({ "system.mandatorySkills": entries });
	});
}

function ensurePackageDelete(packageNode, sheet, kind) {
	if (packageNode.querySelector("[data-wfrp-delete-package]")) return;
	const packageButton = packageNode.querySelector(".career-compact-package__tab");
	if (!(packageButton instanceof HTMLElement)) return;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "career-compact-package__delete";
	button.dataset.wfrpDeletePackage = kind;
	button.title = localize("Delete whole package", "Usuń cały pakiet");
	button.innerHTML = '<i class="fa-solid fa-trash"></i>';
	packageButton.before(button);
	button.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		const entryId = String(kind === "career" ? packageNode.dataset.careerEntryId : packageNode.dataset.raceEntryId);
		const path = kind === "career" ? "skills" : "mandatorySkills";
		const entries = cloneArray(sheet.document.system?.[path]).filter(
			(entry) => String(entry?.id ?? "") !== entryId,
		);
		await sheet.document.update({ [`system.${path}`]: entries });
	});
}

function careerStandalone(choice, source) {
	return {
		id: foundry.utils.randomID(),
		chance: clampPercentage(source?.chance ?? 100),
		mode: CAREER_ENTRY_MODE.ALL,
		choose: 1,
		note: String(source?.note ?? ""),
		choices: [foundry.utils.deepClone(choice)],
	};
}

function raceStandalone(choice, source) {
	return {
		id: foundry.utils.randomID(),
		minInitialSkills: Math.max(1, integer(source?.minInitialSkills, 1)),
		mode: RACE_INITIAL_SKILL_MODE.ALL,
		choose: 1,
		choices: [foundry.utils.deepClone(choice)],
	};
}

function careerGrant(document) {
	return {
		uuid: String(document.uuid ?? ""),
		rulesId: String(document.system?.rulesId ?? ""),
		name: String(document.name ?? ""),
		specialisation: String(document.system?.specialisation ?? document.system?.specialization ?? ""),
		documentType: "Item",
		documentSubtype: "skill",
		quantity: 1,
	};
}

function raceGrant(document) {
	return {
		uuid: String(document.uuid ?? ""),
		rulesId: String(document.system?.rulesId ?? ""),
		name: String(document.name ?? ""),
		specialisation: String(document.system?.specialisation ?? document.system?.specialization ?? ""),
	};
}

function choiceFromGrant(grant) {
	return { id: foundry.utils.randomID(), label: grantName(grant), grants: [grant] };
}

function grantPresent(entries, grant) {
	return cloneArray(entries).some((entry) => (entry?.choices ?? []).some(
		(choice) => (choice?.grants ?? []).some((candidate) => sameReference(candidate, grant)),
	));
}

function sameReference(left, right) {
	const leftRules = String(left?.rulesId ?? "");
	const rightRules = String(right?.rulesId ?? "");
	const leftSpec = String(left?.specialisation ?? "");
	const rightSpec = String(right?.specialisation ?? "");
	if (leftRules && rightRules) return leftRules === rightRules && leftSpec === rightSpec;
	return Boolean(String(left?.uuid ?? "")) && String(left?.uuid ?? "") === String(right?.uuid ?? "") && leftSpec === rightSpec;
}

function grantName(grant) {
	const name = String(grant?.name ?? grant?.rulesId ?? "").trim() || "—";
	const spec = String(grant?.specialisation ?? "").trim();
	return spec ? `${name} (${spec})` : name;
}

function findEntry(entries, id) {
	const source = entries?.toObject?.() ?? entries;
	return Array.isArray(source) ? source.find((entry) => String(entry?.id ?? "") === String(id ?? "")) : null;
}

function findEntryMutable(entries, id) {
	return Array.isArray(entries) ? entries.find((entry) => String(entry?.id ?? "") === String(id ?? "")) : null;
}

function findChoice(entry, id) {
	return Array.isArray(entry?.choices)
		? entry.choices.find((choice) => String(choice?.id ?? "") === String(id ?? ""))
		: null;
}

function notifyDuplicate(kind, name) {
	ui.notifications.info(kind === "career"
		? localize(`${name} is already listed in this Career.`, `${name} jest już wpisane w tej Profesji.`)
		: localize(`${name} is already listed in this Race.`, `${name} jest już wpisane w tej Rasie.`));
}

function readInternal(event) {
	try {
		const raw = event.dataTransfer?.getData(INTERNAL_MIME);
		return raw ? JSON.parse(raw) : null;
	} catch (_error) { return null; }
}

function readFoundryData(event) {
	try { return TextEditor.getDragEventData(event); } catch (_error) { return null; }
}

function resolveItemSync(data) {
	const uuid = String(data?.uuid ?? "");
	if (!uuid) return null;
	try { return foundry.utils.fromUuidSync(uuid); } catch (_error) { return null; }
}

function clearHighlights(root) {
	for (const node of root.querySelectorAll(".wfrp1ed-skill-drop-over")) node.classList.remove("wfrp1ed-skill-drop-over");
}

function cloneArray(value) {
	const source = value?.toObject?.() ?? value;
	return Array.isArray(source) ? foundry.utils.deepClone(source) : [];
}

function integer(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function clampPercentage(value) {
	return Math.max(0, Math.min(100, integer(value, 100)));
}

function escapeHtml(value) {
	return foundry.utils.escapeHTML(String(value ?? ""));
}

function reportError(error) {
	console.error("WFRP1ED | Unified Skill drag/drop failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.wfrp1ed-skill-draggable { cursor: grab; }
		.wfrp1ed-skill-draggable:active { cursor: grabbing; }
		.wfrp1ed-skill-drop-over {
			outline: 2px dashed #8d1c24 !important;
			outline-offset: -2px;
			background-color: rgb(141 28 36 / 11%) !important;
		}
		.race-percentile-table.wfrp1ed-skill-drop-over {
			box-shadow: inset 0 0 0 2px rgb(141 28 36 / 42%);
		}
		.career-compact-package__delete {
			position: absolute;
			top: -15px;
			right: 40px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 28px;
			height: 25px;
			min-height: 25px;
			padding: 0;
			z-index: 3;
		}
		.race-mandatory-compact-package .career-compact-package__delete { right: 42px; }
		.race-mandatory-compact-package .career-compact-package__member .career-compact-row__controls { margin-left: auto; }
	`;
	document.head.append(style);
}
