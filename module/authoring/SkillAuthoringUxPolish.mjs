import { configureRaceSkill } from "../races/RaceSkillSpecialisationIntegration.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const STYLE_ID = "wfrp1ed-skill-authoring-ux-polish";

install();

function install() {
	installStyle();
	wrapSheet(CareerItemSheet, "career");
	wrapSheet(RaceItemSheet, "race");
}

function wrapSheet(SheetClass, kind) {
	const marker = `__wfrpSkillAuthoringUxPolish_${kind}`;
	if (SheetClass.prototype[marker] === true) return;

	const originalRender = SheetClass.prototype._onRender;
	SheetClass.prototype._onRender = function skillAuthoringUxPolishRender(context, options) {
		originalRender.call(this, context, options);
		const root = this.element;
		if (!(root instanceof HTMLElement) || !this.isEditable) return;

		if (kind === "race") correctRacePackageMemberActions(this, root);
		bindWorkspaceHighlights(root, kind);
	};

	Object.defineProperty(SheetClass.prototype, marker, {
		value: true,
		configurable: false,
		enumerable: false,
	});
}

/**
 * Race package-member gear must always mean "configure this Skill".
 * Replace any previously injected gear control with a fresh button so no
 * package-level listener attached by an earlier render integration can own it.
 */
function correctRacePackageMemberActions(sheet, root) {
	for (const member of root.querySelectorAll(
		".race-mandatory-compact-package .career-compact-package__member",
	)) {
		if (!(member instanceof HTMLElement)) continue;
		const entryId = String(member.dataset.raceEntryId ?? "");
		const choiceId = String(member.dataset.raceChoiceId ?? "");
		if (!entryId || !choiceId) continue;

		const controls = member.querySelector(".career-compact-row__controls");
		if (!(controls instanceof HTMLElement)) continue;

		const oldGear = controls.querySelector(
			"button[data-race-skill-configure], button[data-race-entry-configure], button[data-race-member-configure]",
		);
		if (!(oldGear instanceof HTMLButtonElement)) continue;

		const gear = document.createElement("button");
		gear.type = "button";
		gear.dataset.wfrpRaceMemberSkillConfigure = "true";
		gear.dataset.raceEntryId = entryId;
		gear.dataset.raceChoiceId = choiceId;
		gear.title = localize("Configure Skill", "Konfiguruj Umiejętność");
		gear.innerHTML = '<i class="fa-solid fa-gear"></i>';
		oldGear.replaceWith(gear);

		gear.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			void configureRaceSkill(sheet, entryId, choiceId).catch(reportError);
		}, true);
	}
}

function bindWorkspaceHighlights(root, kind) {
	const marker = `wfrpSkillWorkspaceHighlightBound${kind}`;
	if (root.dataset[marker] === "true") return;
	root.dataset[marker] = "true";

	const clear = () => {
		root.querySelectorAll(".wfrp1ed-skill-workspace-drop-active").forEach((node) =>
			node.classList.remove("wfrp1ed-skill-workspace-drop-active"),
		);
		root.querySelectorAll(".wfrp1ed-random-skill-table-drop-active").forEach((node) =>
			node.classList.remove("wfrp1ed-random-skill-table-drop-active"),
		);
	};

	root.addEventListener("dragover", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;

		if (kind === "career") {
			const panel = root.querySelector('[data-career-panel="skills"]');
			if (panel instanceof HTMLElement) {
				panel.classList.add("wfrp1ed-skill-workspace-drop-active");
			}
			return;
		}

		const randomTable = target.closest(
			'.race-percentile-table[data-race-drop-zone="skillTable"]',
		);
		root.querySelectorAll(".wfrp1ed-random-skill-table-drop-active").forEach((node) => {
			if (node !== randomTable) node.classList.remove("wfrp1ed-random-skill-table-drop-active");
		});
		if (randomTable instanceof HTMLElement) {
			randomTable.classList.add("wfrp1ed-random-skill-table-drop-active");
			/* Make the table an explicit HTML5 drop target while leaving the native
			 * RaceItemSheet drop handler in control of the actual table update. */
			event.preventDefault();
		}
	}, true);

	root.addEventListener("dragleave", (event) => {
		if (root.contains(event.relatedTarget)) return;
		clear();
	}, true);
	root.addEventListener("dragend", clear, true);
	root.addEventListener("drop", () => queueMicrotask(clear), true);
}

function installStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
		/* Package-level action order: package/config first, trash last. */
		.career-item-sheet .career-compact-package__tab,
		.race-item-sheet .career-compact-package__tab {
			right: 38px !important;
		}

		.career-item-sheet .career-compact-package__delete,
		.race-item-sheet .career-compact-package__delete {
			right: 7px !important;
		}

		/* Career: highlight the complete Skills authoring workspace, including
		 * the instructional hint, rather than only the row under the pointer. */
		.career-item-sheet [data-career-panel="skills"].wfrp1ed-skill-workspace-drop-active {
			outline: 2px dashed #8d1c24;
			outline-offset: -2px;
			background: rgb(141 28 36 / 7%);
		}

		.career-item-sheet [data-career-panel="skills"].wfrp1ed-skill-workspace-drop-active .career-compact-drop-hint {
			border-color: rgb(141 28 36 / 75%);
			background: rgb(141 28 36 / 10%);
			color: #5d1018;
		}

		/* Race random starting-Skill table: unmistakable target indication. */
		.race-item-sheet .race-percentile-table.wfrp1ed-random-skill-table-drop-active {
			outline: 2px dashed #8d1c24 !important;
			outline-offset: -2px;
			background: rgb(141 28 36 / 10%) !important;
			box-shadow: inset 0 0 0 1px rgb(141 28 36 / 18%);
		}
	`;
	document.head.append(style);
}

function reportError(error) {
	console.error("WFRP1ED | Race package-member Skill configuration failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
