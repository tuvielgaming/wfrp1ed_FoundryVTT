import {
	RACE_CAREER_CLASSES,
	RACE_CAREER_OVERRIDE_MODE,
	RACE_CHARACTERISTIC_IDS,
	RACE_INITIAL_SKILL_MODE,
	RaceData,
} from "../data-models/item/RaceData.mjs";
import { RaceItemSheet } from "../sheets/RaceItemSheet.mjs";

const { DocumentSheetConfig } = foundry.applications.apps;
const { Item } = foundry.documents;

/**
 * Register the native WFRP 1e Race document contract.
 *
 * World and Compendium Race Items are reusable definitions. A Character owns
 * at most one embedded Race Item, which is its authoritative racial identity.
 * Creation rolls are deliberately not executed here; the future creation
 * engine will consume the Race definition and write generated results to the
 * Character.
 */
Hooks.once("init", () => {
	CONFIG.Item.dataModels.race = RaceData;

	DocumentSheetConfig.registerSheet(
		Item,
		game.system.id,
		RaceItemSheet,
		{
			types: ["race"],
			makeDefault: true,
		},
	);

	game.WFRP1ED = Object.freeze({
		...(game.WFRP1ED ?? {}),
		race: Object.freeze({
			...(game.WFRP1ED?.race ?? {}),
			characteristics: RACE_CHARACTERISTIC_IDS,
			careerClasses: RACE_CAREER_CLASSES,
			initialSkillMode: RACE_INITIAL_SKILL_MODE,
			careerOverrideMode: RACE_CAREER_OVERRIDE_MODE,
			getEmbeddedRace,
			assign: assignRace,
		}),
	});
});

/**
 * A Character may contain exactly zero or one Race Item.
 *
 * There is intentionally no migration or guessing from an old free-text race.
 * New creation uses the embedded Item only.
 */
Hooks.on("preCreateItem", (item, _data, _options, userId) => {
	if (item?.type !== "race") return;

	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	const existing = getEmbeddedRace(actor);
	if (!existing) return;

	if (game.user?.id === userId) {
		ui.notifications.warn(localize(
			`${actor.name} already has the Race '${existing.name}'. Replace it through the Race field instead of adding a second Race.`,
			`${actor.name} ma już Rasę „${existing.name}”. Zastąp ją przez pole Rasy zamiast dodawać drugą Rasę.`,
		));
	}

	return false;
});

/**
 * Convert the Classic header's old text input into a managed Race Item field.
 *
 * We deliberately do this at the integration layer in this first slice so the
 * Character sheet immediately stops accepting free text without introducing a
 * fake migration from old strings. The future creation UI can call the same
 * assignRace() API directly.
 */
Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	const root = asElement(element) ?? asElement(application.element);
	if (!root?.classList?.contains("classic-actor-sheet") &&
		!root?.querySelector?.(".classic-actor-sheet")) return;

	const field = root.querySelector(
		'.header-field--race input[name="system.details.race"], .header-field--race input[data-wfrp-race-field="true"]',
	);
	if (!(field instanceof HTMLInputElement)) return;

	const race = getEmbeddedRace(actor);
	field.removeAttribute("name");
	field.readOnly = true;
	field.value = String(race?.name ?? "");
	field.placeholder = localize("Drop Race Item", "Upuść Przedmiot Rasy");
	field.dataset.wfrpRaceField = "true";
	field.dataset.raceItemId = String(race?.id ?? "");
	field.title = race
		? localize(
			"Double-click to open this Race. Drop another Race Item here to replace it. Right-click to remove it.",
			"Kliknij dwukrotnie, aby otworzyć tę Rasę. Upuść tutaj inny Przedmiot Rasy, aby ją zastąpić. Kliknij prawym przyciskiem, aby ją usunąć.",
		)
		: localize(
			"Drop a Race Item here.",
			"Upuść tutaj Przedmiot Rasy.",
		);

	if (field.dataset.wfrpRaceListeners === "true") return;
	field.dataset.wfrpRaceListeners = "true";

	field.addEventListener("dblclick", (event) => {
		event.preventDefault();
		const current = getEmbeddedRace(actor);
		if (current?.sheet) void current.sheet.render({ force: true });
	});

	if (application.isEditable !== true) return;

	field.addEventListener("dragover", (event) => {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	});

	field.addEventListener("drop", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void assignRaceFromDrop(actor, event).catch(reportRaceError);
	});

	field.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		void removeRace(actor).catch(reportRaceError);
	});
});

for (const hookName of ["createItem", "deleteItem", "updateItem"]) {
	Hooks.on(hookName, (item) => {
		if (item?.type !== "race") return;
		const actor = item.parent;
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (actor.sheet?.rendered) void actor.sheet.render({ force: true });
	});
}

export function getEmbeddedRace(actor) {
	if (actor?.documentName !== "Actor" || actor.type !== "character") return null;
	return actor.items?.find?.((candidate) => candidate.type === "race") ?? null;
}

/**
 * Replace the Character's embedded Race with a copy of the supplied Race Item.
 * This changes identity only. The future CharacterCreationEngine will own all
 * profile/age/Fate/skill generation transactions based on that identity.
 */
export async function assignRace(actor, race) {
	if (actor?.documentName !== "Actor" || actor.type !== "character") {
		throw new Error(localize(
			"A Race can only be assigned to a Character Actor.",
			"Rasę można przypisać tylko Aktorowi Postaci.",
		));
	}

	if (!(race instanceof foundry.documents.Item) || race.type !== "race") {
		throw new Error(localize(
			"Select or drop a Race Item.",
			"Wybierz lub upuść Przedmiot Rasy.",
		));
	}

	const current = getEmbeddedRace(actor);
	if (current?.uuid === race.uuid) return current;

	if (current) {
		await actor.deleteEmbeddedDocuments("Item", [current.id]);
	}

	const data = race.toObject();
	delete data._id;
	delete data.folder;
	delete data.sort;
	delete data.ownership;

	const [created] = await actor.createEmbeddedDocuments("Item", [data]);
	return created ?? null;
}

async function assignRaceFromDrop(actor, event) {
	const dragData = foundry.applications.ux.TextEditor.getDragEventData(event);
	if (String(dragData?.type ?? "") !== "Item") return null;

	const uuid = String(dragData?.uuid ?? "").trim();
	if (!uuid) return null;

	const document = await foundry.utils.fromUuid(uuid);
	if (!(document instanceof foundry.documents.Item) || document.type !== "race") {
		ui.notifications.warn(localize(
			"Only a Race Item can be dropped into the Race field.",
			"Do pola Rasy można upuścić tylko Przedmiot Rasy.",
		));
		return null;
	}

	return assignRace(actor, document);
}

async function removeRace(actor) {
	const current = getEmbeddedRace(actor);
	if (!current) return;

	const confirmed = await foundry.applications.api.DialogV2.confirm({
		content: localize(
			`Remove Race '${current.name}' from ${actor.name}?`,
			`Usunąć Rasę „${current.name}” z postaci ${actor.name}?`,
		),
		rejectClose: false,
		modal: true,
	});
	if (!confirmed) return;

	await actor.deleteEmbeddedDocuments("Item", [current.id]);
}

function reportRaceError(error) {
	console.error("WFRP1ED | Race assignment failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function asElement(value) {
	if (value?.nodeType === 1 && typeof value.querySelector === "function") {
		return value;
	}
	if (value?.[0]?.nodeType === 1 && typeof value[0].querySelector === "function") {
		return value[0];
	}
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
