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
const CREATION_FLAG_SCOPE = "wfrp1ed";
const CREATION_FLAG_KEY = "characterCreationMode";

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

Hooks.on("preCreateItem", (item, _data, _options, userId) => {
	if (item?.type !== "race") return;

	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	if (!isCharacterCreationMode(actor)) {
		if (game.user?.id === userId) notifyRaceLocked(actor);
		return false;
	}

	const existing = getEmbeddedRace(actor);
	if (!existing) return;

	if (game.user?.id === userId) {
		ui.notifications.warn(localize(
			`${actor.name} already has the Race '${existing.name}'. Replace it through the Character sheet instead of adding a second Race.`,
			`${actor.name} ma już Rasę „${existing.name}”. Zastąp ją przez kartę Postaci zamiast dodawać drugą Rasę.`,
		));
	}

	return false;
});

Hooks.on("preDeleteItem", (item, _options, userId) => {
	if (item?.type !== "race") return;
	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;
	if (isCharacterCreationMode(actor)) return;
	if (game.user?.id === userId) notifyRaceLocked(actor);
	return false;
});

Hooks.on("renderApplicationV2", (application, element) => {
	const actor = application?.document;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	const root = asElement(element) ?? asElement(application.element);
	const sheet = root?.classList?.contains("wfrp1ed-classic-sheet")
		? root
		: root?.querySelector?.(".wfrp1ed-classic-sheet");
	if (!(sheet instanceof HTMLElement)) return;

	const field = sheet.querySelector(
		'.header-field--race input[name="system.details.race"], .header-field--race input[data-wfrp-race-field="true"]',
	);
	if (!(field instanceof HTMLInputElement)) return;

	const race = getEmbeddedRace(actor);
	const creationMode = isCharacterCreationMode(actor);
	field.removeAttribute("name");
	field.readOnly = true;
	field.value = String(race?.name ?? "");
	field.placeholder = creationMode
		? localize("Drop Race Item", "Upuść Przedmiot Rasy")
		: localize("Race locked", "Rasa zablokowana");
	field.dataset.wfrpRaceField = "true";
	field.dataset.raceItemId = String(race?.id ?? "");
	field.title = creationMode
		? (race
			? localize(
				"Double-click to open this Race. Drop another Race Item anywhere on the character sheet to replace it. Right-click to remove it.",
				"Kliknij dwukrotnie, aby otworzyć tę Rasę. Upuść inny Przedmiot Rasy w dowolnym miejscu karty postaci, aby ją zastąpić. Kliknij prawym przyciskiem, aby ją usunąć.",
			)
			: localize(
				"Drop a Race Item anywhere on the character sheet.",
				"Upuść Przedmiot Rasy w dowolnym miejscu karty postaci.",
			))
		: localize(
			"Race can only be changed while Character Creation Mode is enabled.",
			"Rasę można zmienić tylko przy włączonym Trybie tworzenia postaci.",
		);

	if (field.dataset.wfrpRaceListeners !== "true") {
		field.dataset.wfrpRaceListeners = "true";
		field.addEventListener("dblclick", (event) => {
			event.preventDefault();
			const current = getEmbeddedRace(actor);
			if (current?.sheet) void current.sheet.render({ force: true });
		});

		if (application.isEditable === true) {
			field.addEventListener("contextmenu", (event) => {
				event.preventDefault();
			if (!isCharacterCreationMode(actor)) {
				notifyRaceLocked(actor);
				return;
			}
			void removeRace(actor).catch(reportRaceError);
			});
		}
	}

	if (application.isEditable === true) {
		installWholeSheetRaceDrop(sheet, actor);
	}
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

export async function assignRace(actor, race) {
	if (actor?.documentName !== "Actor" || actor.type !== "character") {
		throw new Error(localize(
			"A Race can only be assigned to a Character Actor.",
			"Rasę można przypisać tylko Aktorowi Postaci.",
		));
	}

	if (!isCharacterCreationMode(actor)) {
		throw new Error(localize(
			"Race can only be assigned or changed while Character Creation Mode is enabled.",
			"Rasę można przypisać lub zmienić tylko przy włączonym Trybie tworzenia postaci.",
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
		await resetInitialCharacteristics(actor);
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

function installWholeSheetRaceDrop(sheet, actor) {
	if (sheet.dataset.wfrpRaceSheetDrop === "true") return;
	sheet.dataset.wfrpRaceSheetDrop = "true";

	sheet.addEventListener("dragover", (event) => {
		const race = raceFromDragEventSync(event);
		if (!race || !isCharacterCreationMode(actor)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	});

	sheet.addEventListener("drop", (event) => {
		const race = raceFromDragEventSync(event);
		if (!race) return;

		if (!isCharacterCreationMode(actor)) {
			event.preventDefault();
			event.stopImmediatePropagation();
			notifyRaceLocked(actor);
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();
		void assignRace(actor, race).catch(reportRaceError);
	}, true);
}

function raceFromDragEventSync(event) {
	const dragData = foundry.applications.ux.TextEditor.getDragEventData(event);
	if (String(dragData?.type ?? "") !== "Item") return null;

	const uuid = String(dragData?.uuid ?? "").trim();
	if (!uuid) return null;

	const resolver = foundry.utils?.fromUuidSync ?? globalThis.fromUuidSync;
	if (typeof resolver !== "function") return null;

	try {
		const document = resolver(uuid);
		return document instanceof foundry.documents.Item && document.type === "race"
			? document
			: null;
	} catch (_error) {
		return null;
	}
}

async function removeRace(actor) {
	if (!isCharacterCreationMode(actor)) {
		throw new Error(localize(
			"Race can only be removed while Character Creation Mode is enabled.",
			"Rasę można usunąć tylko przy włączonym Trybie tworzenia postaci.",
		));
	}

	const current = getEmbeddedRace(actor);
	if (!current) return;

	const confirmed = await foundry.applications.api.DialogV2.confirm({
		content: localize(
			`Remove Race '${current.name}' from ${actor.name}? Starting Characteristics will be reset.`,
			`Usunąć Rasę „${current.name}” z postaci ${actor.name}? Charakterystyki Początkowe zostaną wyzerowane.`,
		),
		rejectClose: false,
		modal: true,
	});
	if (!confirmed) return;

	await resetInitialCharacteristics(actor);
	await actor.deleteEmbeddedDocuments("Item", [current.id]);
}

async function resetInitialCharacteristics(actor) {
	const updates = Object.fromEntries(
		RACE_CHARACTERISTIC_IDS.map((id) => [
			`system.characteristics.${id}.initial`,
			0,
		]),
	);
	await actor.update(updates);
}

function isCharacterCreationMode(actor) {
	return actor?.getFlag?.(CREATION_FLAG_SCOPE, CREATION_FLAG_KEY) === true;
}

function notifyRaceLocked(actor) {
	ui.notifications.warn(localize(
		`Race is locked for ${actor?.name ?? "this Character"}. Enable Character Creation Mode to change it.`,
		`Rasa postaci ${actor?.name ?? ""} jest zablokowana. Włącz Tryb tworzenia postaci, aby ją zmienić.`,
	));
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
