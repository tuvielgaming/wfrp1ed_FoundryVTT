import { CAREER_ENTRY_MODE } from "../data-models/item/CareerData.mjs";
import { RACE_INITIAL_SKILL_MODE } from "../data-models/item/RaceData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const INTERNAL_MIME = "application/x-wfrp1ed-package-row";
const STYLE_ID = "wfrp1ed-package-row-drag-style";

install();

function install() {
	installStyle();
	wrapSheet(CareerItemSheet, "career");
	wrapSheet(RaceItemSheet, "race");
}

function wrapSheet(SheetClass, kind) {
	const marker = `__wfrpPackageRowDrag_${kind}`;
	if (SheetClass.prototype[marker] === true) return;
	const original = SheetClass.prototype._onRender;
	SheetClass.prototype._onRender = function packageRowDragRender(context, options) {
		original.call(this, context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement) || !this.isEditable) return;
		if (kind === "career") decorateCareer(this, root);
		else decorateRace(this, root);
	};
	Object.defineProperty(SheetClass.prototype, marker, { value: true });
}

function decorateCareer(sheet, root) {
	for (const row of root.querySelectorAll('[data-career-panel="skills"] .career-compact-row[data-career-entry-id]')) {
		row.draggable = true;
		row.classList.add("wfrp1ed-package-draggable");
	}
	for (const packageNode of root.querySelectorAll('[data-career-panel="skills"] .career-compact-package[data-career-entry-id]')) {
		ensurePackageDeleteButton(sheet, packageNode, "career");
	}
	bindRoot(sheet, root, "career");
}

function decorateRace(sheet, root) {
	for (const row of root.querySelectorAll('.race-mandatory-compact-list .career-compact-row[data-race-entry-id], .race-mandatory-compact-package .career-compact-package__member')) {
		row.draggable = true;
		row.classList.add("wfrp1ed-package-draggable");
		if (row.classList.contains("career-compact-package__member")) ensureRaceMemberControls(sheet, row);
	}
	for (const packageNode of root.querySelectorAll('.race-mandatory-compact-package[data-race-entry-id]')) {
		packageNode.querySelector(".race-mandatory-package-actions")?.remove();
		ensurePackageDeleteButton(sheet, packageNode, "race");
	}
	bindRoot(sheet, root, "race");
}

function bindRoot(sheet, root, kind) {
	if (root.dataset.wfrpPackageDragBound === "true") return;
	root.dataset.wfrpPackageDragBound = "true";

	root.addEventListener("dragstart", (event) => {
		if (event.target?.closest?.("button, input, select, textarea")) return;
		const payload = kind === "career" ? careerPayload(event.target) : racePayload(sheet, event.target);
		if (!payload || !event.dataTransfer) return;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(INTERNAL_MIME, JSON.stringify(payload));
		event.dataTransfer.setData("text/plain", JSON.stringify({ type: "WFRP1EDPackageRow", ...payload }));
	});

	root.addEventListener("dragover", (event) => {
		const target = dropTarget(root, event.target, kind);
		if (!target) return;
		event.preventDefault();
		target.element.classList.add("wfrp1ed-package-drop-over");
	});

	root.addEventListener("dragleave", (event) => {
		for (const node of root.querySelectorAll(".wfrp1ed-package-drop-over")) {
			if (!node.contains(event.relatedTarget)) node.classList.remove("wfrp1ed-package-drop-over");
		}
	});

	root.addEventListener("drop", (event) => {
		const target = dropTarget(root, event.target, kind);
		if (!target) return;
		const internal = readInternal(event);
		const externalData = internal ? null : readFoundryDragData(event);
		const canHandleExternal = externalData?.type === "Item" && target.type !== "list";
		if (!internal && !canHandleExternal) return;

		event.preventDefault();
		event.stopPropagation();
		for (const node of root.querySelectorAll(".wfrp1ed-package-drop-over")) node.classList.remove("wfrp1ed-package-drop-over");
		void (async () => {
			if (internal) {
				if (kind === "career") await handleCareerInternal(sheet, internal, target);
				else await handleRaceInternal(sheet, internal, target);
				return;
			}
			const document = await resolveItem(externalData);
			if (!document) return;
			if (kind === "career") await handleCareerExternal(sheet, document, target);
			else await handleRaceExternal(sheet, document, target);
		})().catch(reportError);
	}, true);
}

function careerPayload(target) {
	const row = target?.closest?.('.career-compact-row[data-career-entry-id]');
	if (!(row instanceof HTMLElement)) return null;
	const panel = row.closest('[data-career-panel="skills"]');
	if (!panel) return null;
	return {
		kind: "career",
		collection: "skills",
		entryId: String(row.dataset.careerEntryId ?? ""),
		choiceId: String(row.dataset.careerChoiceId ?? ""),
	};
}

function racePayload(sheet, target) {
	const member = target?.closest?.('.career-compact-package__member[data-race-entry-id]');
	if (member instanceof HTMLElement) {
		return {
			kind: "race",
			entryId: String(member.dataset.raceEntryId ?? ""),
			choiceId: String(member.dataset.raceChoiceId ?? ""),
		};
	}
	const row = target?.closest?.('.race-mandatory-compact-row[data-race-entry-id]');
	if (!(row instanceof HTMLElement)) return null;
	const entryId = String(row.dataset.raceEntryId ?? "");
	const entry = findEntry(sheet.document.system?.mandatorySkills, entryId);
	return { kind: "race", entryId, choiceId: String(cloneArray(entry?.choices)[0]?.id ?? "") };
}

function dropTarget(root, target, kind) {
	if (!(target instanceof Element)) return null;
	if (kind === "career") {
		const packageNode = target.closest('.career-compact-package[data-career-entry-id]');
		if (packageNode && packageNode.closest('[data-career-panel="skills"]')) {
			return { type: "package", entryId: String(packageNode.dataset.careerEntryId ?? ""), element: packageNode };
		}
		const row = target.closest('.career-compact-row[data-career-entry-id]');
		if (row && row.closest('[data-career-panel="skills"]')) {
			return { type: "row", entryId: String(row.dataset.careerEntryId ?? ""), choiceId: String(row.dataset.careerChoiceId ?? ""), element: row };
		}
		const list = target.closest('[data-career-panel="skills"] .career-compact-list');
		return list ? { type: "list", element: list } : null;
	}

	const packageNode = target.closest('.race-mandatory-compact-package[data-race-entry-id]');
	if (packageNode) return { type: "package", entryId: String(packageNode.dataset.raceEntryId ?? ""), element: packageNode };
	const row = target.closest('.race-mandatory-compact-row[data-race-entry-id]');
	if (row) return { type: "row", entryId: String(row.dataset.raceEntryId ?? ""), element: row };
	const list = target.closest('.race-mandatory-compact-list');
	return list ? { type: "list", element: list } : null;
}

async function handleCareerInternal(sheet, source, target) {
	if (source.kind !== "career" || source.collection !== "skills") return;
	const entries = cloneArray(sheet.document.system?.skills);
	const sourceEntry = findEntry(entries, source.entryId);
	if (!sourceEntry) return;
	const sourceChoice = cloneArray(sourceEntry.choices).find((choice) => String(choice?.id ?? "") === source.choiceId);
	if (!sourceChoice) return;

	if (target.type === "list") {
		if (cloneArray(sourceEntry.choices).length <= 1) return;
		await sheet.document.update({ "system.skills": detachChoice(entries, source.entryId, source.choiceId, careerStandalone) });
		return;
	}
	if (target.entryId === source.entryId) return;

	let next = removeChoiceForMove(entries, source.entryId, source.choiceId);
	if (target.type === "package") next = addChoiceToCareerPackage(next, target.entryId, sourceChoice);
	else next = mergeCareerWithFreeTarget(next, target.entryId, sourceChoice);
	await sheet.document.update({ "system.skills": next });
}

async function handleRaceInternal(sheet, source, target) {
	if (source.kind !== "race") return;
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const sourceEntry = findEntry(entries, source.entryId);
	if (!sourceEntry) return;
	const sourceChoice = cloneArray(sourceEntry.choices).find((choice) => String(choice?.id ?? "") === source.choiceId);
	if (!sourceChoice) return;

	if (target.type === "list") {
		if (cloneArray(sourceEntry.choices).length <= 1) return;
		await sheet.document.update({ "system.mandatorySkills": detachChoice(entries, source.entryId, source.choiceId, raceStandalone) });
		return;
	}
	if (target.entryId === source.entryId) return;

	let next = removeChoiceForMove(entries, source.entryId, source.choiceId);
	if (target.type === "package") next = addChoiceToRacePackage(next, target.entryId, sourceChoice);
	else next = mergeRaceWithFreeTarget(next, target.entryId, sourceChoice);
	await sheet.document.update({ "system.mandatorySkills": next });
}

async function handleCareerExternal(sheet, document, target) {
	if (document.type !== "skill") return warn(localize("Only Skills can be added to a Career Skill package.", "Do pakietu Umiejętności Profesji można dodawać tylko Umiejętności."));
	const entries = cloneArray(sheet.document.system?.skills);
	const grant = careerGrant(document);
	if (grantPresent(entries, grant)) return warn(localize("This Skill is already listed in the Career.", "Ta Umiejętność jest już wpisana w Profesji."));
	const choice = careerChoice(grant);
	const next = target.type === "package" ? addChoiceToCareerPackage(entries, target.entryId, choice) : mergeCareerWithFreeTarget(entries, target.entryId, choice);
	await sheet.document.update({ "system.skills": next });
}

async function handleRaceExternal(sheet, document, target) {
	if (document.type !== "skill") return warn(localize("Only Skills can be added to a racial Skill package.", "Do pakietu rasowych Umiejętności można dodawać tylko Umiejętności."));
	const entries = cloneArray(sheet.document.system?.mandatorySkills);
	const grant = raceGrant(document);
	if (grantPresent(entries, grant)) return warn(localize("This Skill is already listed in the Race.", "Ta Umiejętność jest już wpisana w Rasie."));
	const choice = raceChoice(grant);
	const next = target.type === "package" ? addChoiceToRacePackage(entries, target.entryId, choice) : mergeRaceWithFreeTarget(entries, target.entryId, choice);
	await sheet.document.update({ "system.mandatorySkills": next });
}

function detachChoice(entries, entryId, choiceId, standaloneFactory) {
	const next = cloneArray(entries);
	const index = next.findIndex((entry) => String(entry?.id ?? "") === entryId);
	if (index < 0) return next;
	const sourceMeta = foundry.utils.deepClone(next[index]);
	const choices = cloneArray(next[index].choices);
	const detached = choices.find((choice) => String(choice?.id ?? "") === choiceId);
	if (!detached) return next;
	next[index].choices = choices.filter((choice) => String(choice?.id ?? "") !== choiceId);
	normalizeEntryAfterRemoval(next, index);
	const insertion = Math.min(index + 1, next.length);
	next.splice(insertion, 0, standaloneFactory(detached, sourceMeta));
	return next;
}

function removeChoiceForMove(entries, entryId, choiceId) {
	const next = cloneArray(entries);
	const index = next.findIndex((entry) => String(entry?.id ?? "") === entryId);
	if (index < 0) return next;
	const choices = cloneArray(next[index].choices);
	if (choices.length <= 1) {
		next.splice(index, 1);
		return next;
	}
	next[index].choices = choices.filter((choice) => String(choice?.id ?? "") !== choiceId);
	normalizeEntryAfterRemoval(next, index);
	return next;
}

function normalizeEntryAfterRemoval(entries, index) {
	const entry = entries[index];
	if (!entry) return;
	const count = cloneArray(entry.choices).length;
	if (count === 0) entries.splice(index, 1);
	else if (count === 1) {
		entry.mode = entry.minInitialSkills !== undefined ? RACE_INITIAL_SKILL_MODE.ALL : CAREER_ENTRY_MODE.ALL;
		entry.choose = 1;
	}
}

function addChoiceToCareerPackage(entries, targetId, choice) {
	const next = cloneArray(entries);
	const target = findEntryMutable(next, targetId);
	if (!target) return next;
	target.choices = [...cloneArray(target.choices), foundry.utils.deepClone(choice)];
	if (target.choices.length > 1 && String(target.mode) === CAREER_ENTRY_MODE.ALL) {
		target.mode = CAREER_ENTRY_MODE.PLAYER_CHOICE;
		target.choose = 1;
	}
	return next;
}

function addChoiceToRacePackage(entries, targetId, choice) {
	const next = cloneArray(entries);
	const target = findEntryMutable(next, targetId);
	if (!target) return next;
	target.choices = [...cloneArray(target.choices), foundry.utils.deepClone(choice)];
	if (target.choices.length > 1 && String(target.mode) === RACE_INITIAL_SKILL_MODE.ALL) {
		target.mode = RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE;
		target.choose = 1;
	}
	return next;
}

function mergeCareerWithFreeTarget(entries, targetId, choice) {
	const next = cloneArray(entries);
	const target = findEntryMutable(next, targetId);
	if (!target) return next;
	if (cloneArray(target.choices).length > 1) return addChoiceToCareerPackage(next, targetId, choice);
	target.choices = [cloneArray(target.choices)[0], foundry.utils.deepClone(choice)].filter(Boolean);
	target.mode = CAREER_ENTRY_MODE.PLAYER_CHOICE;
	target.choose = 1;
	return next;
}

function mergeRaceWithFreeTarget(entries, targetId, choice) {
	const next = cloneArray(entries);
	const target = findEntryMutable(next, targetId);
	if (!target) return next;
	if (cloneArray(target.choices).length > 1) return addChoiceToRacePackage(next, targetId, choice);
	target.choices = [cloneArray(target.choices)[0], foundry.utils.deepClone(choice)].filter(Boolean);
	target.mode = RACE_INITIAL_SKILL_MODE.RANDOM_CHOICE;
	target.choose = 1;
	return next;
}

function ensurePackageDeleteButton(sheet, packageNode, kind) {
	if (packageNode.querySelector("[data-wfrp-delete-package]")) return;
	const edit = packageNode.querySelector(".career-compact-package__tab");
	if (!(edit instanceof HTMLElement)) return;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "career-compact-package__delete";
	button.dataset.wfrpDeletePackage = kind;
	button.title = localize("Delete whole package", "Usuń cały pakiet");
	button.innerHTML = '<i class="fa-solid fa-trash"></i>';
	edit.after(button);
	button.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();
		const entryId = kind === "career" ? String(packageNode.dataset.careerEntryId ?? "") : String(packageNode.dataset.raceEntryId ?? "");
		if (!entryId) return;
		const path = kind === "career" ? "skills" : "mandatorySkills";
		const entries = cloneArray(sheet.document.system?.[path]).filter((entry) => String(entry?.id ?? "") !== entryId);
		await sheet.document.update({ [`system.${path}`]: entries });
	});
}

function ensureRaceMemberControls(sheet, row) {
	if (row.querySelector(".career-compact-row__controls")) return;
	const packageNode = row.closest('.race-mandatory-compact-package[data-race-entry-id]');
	if (!packageNode) return;
	const entryId = String(packageNode.dataset.raceEntryId ?? "");
	const label = String(row.querySelector('.career-compact-row__name')?.textContent ?? "").trim();
	const entry = findEntry(sheet.document.system?.mandatorySkills, entryId);
	const choice = cloneArray(entry?.choices).find((candidate) => choiceLabel(candidate) === label);
	if (!choice) return;
	row.dataset.raceEntryId = entryId;
	row.dataset.raceChoiceId = String(choice.id ?? "");
	const controls = document.createElement("div");
	controls.className = "career-compact-row__controls";
	controls.innerHTML = `<button type="button" data-race-member-configure title="${escapeHtml(localize("Configure package", "Konfiguruj pakiet"))}"><i class="fa-solid fa-gear"></i></button><button type="button" data-race-member-delete title="${escapeHtml(localize("Delete from Race", "Usuń z Rasy"))}"><i class="fa-solid fa-trash"></i></button>`;
	row.append(controls);
	controls.querySelector("[data-race-member-configure]")?.addEventListener("click", () => packageNode.querySelector(".career-compact-package__tab")?.click());
	controls.querySelector("[data-race-member-delete]")?.addEventListener("click", async () => {
		const entries = cloneArray(sheet.document.system?.mandatorySkills);
		const index = entries.findIndex((candidate) => String(candidate?.id ?? "") === entryId);
		if (index < 0) return;
		entries[index].choices = cloneArray(entries[index].choices).filter((candidate) => String(candidate?.id ?? "") !== String(choice.id ?? ""));
		normalizeEntryAfterRemoval(entries, index);
		await sheet.document.update({ "system.mandatorySkills": entries });
	});
}

function careerStandalone(choice, source) {
	return { id: foundry.utils.randomID(), chance: percentage(source?.chance), mode: CAREER_ENTRY_MODE.ALL, choose: 1, note: String(source?.note ?? ""), choices: [foundry.utils.deepClone(choice)] };
}
function raceStandalone(choice, source) {
	return { id: foundry.utils.randomID(), minInitialSkills: Math.max(1, integer(source?.minInitialSkills, 1)), mode: RACE_INITIAL_SKILL_MODE.ALL, choose: 1, choices: [foundry.utils.deepClone(choice)] };
}
function careerGrant(document) {
	return { uuid: String(document.uuid ?? ""), rulesId: String(document.system?.rulesId ?? ""), name: String(document.name ?? ""), specialisation: String(document.system?.specialisation ?? document.system?.specialization ?? ""), documentType: "Item", documentSubtype: "skill", quantity: 1 };
}
function raceGrant(document) {
	return { uuid: String(document.uuid ?? ""), rulesId: String(document.system?.rulesId ?? ""), name: String(document.name ?? ""), specialisation: String(document.system?.specialisation ?? document.system?.specialization ?? "") };
}
function careerChoice(grant) { return { id: foundry.utils.randomID(), label: grantName(grant), grants: [grant] }; }
function raceChoice(grant) { return { id: foundry.utils.randomID(), label: grantName(grant), grants: [grant] }; }
function grantPresent(entries, grant) { return cloneArray(entries).some((entry) => cloneArray(entry?.choices).some((choice) => cloneArray(choice?.grants).some((candidate) => sameReference(candidate, grant)))); }
function sameReference(a, b) {
	const ar = String(a?.rulesId ?? ""); const br = String(b?.rulesId ?? "");
	const as = String(a?.specialisation ?? ""); const bs = String(b?.specialisation ?? "");
	if (ar && br) return ar === br && as === bs;
	return Boolean(String(a?.uuid ?? "")) && String(a?.uuid ?? "") === String(b?.uuid ?? "") && as === bs;
}
function grantName(grant) { const name = String(grant?.name ?? grant?.rulesId ?? "").trim(); const spec = String(grant?.specialisation ?? "").trim(); return spec ? `${name} (${spec})` : name; }
function choiceLabel(choice) { return String(choice?.label ?? "").trim() || cloneArray(choice?.grants).map(grantName).filter(Boolean).join(" + ") || "—"; }
function findEntry(entries, id) { return cloneArray(entries).find((entry) => String(entry?.id ?? "") === String(id)); }
function findEntryMutable(entries, id) { return entries.find((entry) => String(entry?.id ?? "") === String(id)); }
function cloneArray(value) { const source = value?.toObject?.() ?? value; return Array.isArray(source) ? foundry.utils.deepClone(source) : []; }
function integer(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : fallback; }
function percentage(value) { return Math.max(0, Math.min(100, integer(value, 100))); }
function readInternal(event) { try { const raw = event.dataTransfer?.getData(INTERNAL_MIME); return raw ? JSON.parse(raw) : null; } catch (_error) { return null; } }
function readFoundryDragData(event) { try { return TextEditor.getDragEventData(event); } catch (_error) { return null; } }
async function resolveItem(data) { if (!data?.uuid) return null; const document = await fromUuid(String(data.uuid)); return document instanceof foundry.documents.Item ? document : null; }
function warn(message) { ui.notifications.info(message); }
function reportError(error) { console.error("WFRP1ED | Package row drag/drop failed.", error); ui.notifications.error(error?.message ?? String(error)); }
function escapeHtml(value) { return foundry.utils.escapeHTML(String(value ?? "")); }
function localize(en, pl) { return game.i18n.lang === "pl" ? pl : en; }

function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		.wfrp1ed-package-draggable { cursor: grab; }
		.wfrp1ed-package-draggable:active { cursor: grabbing; }
		.wfrp1ed-package-drop-over { outline: 2px dashed #8d1c24 !important; outline-offset: -2px; background-color: rgb(141 28 36 / 10%) !important; }
		.career-compact-package__delete { position: absolute; top: -17px; right: 34px; width: 27px; height: 27px; padding: 0; z-index: 3; }
		.race-mandatory-compact-package .career-compact-package__delete { right: 36px; }
		.career-compact-package__member .career-compact-row__controls { margin-left: auto; }
	`;
	document.head.append(style);
}
