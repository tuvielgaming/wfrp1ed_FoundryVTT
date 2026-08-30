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
const CAREER_ACQUISITION_FLAG_KEY = "careerAcquisition";
const CAREER_COMPANION_FLAG_KEY = "careerCompanion";
const RACE_INITIAL_SKILL_GRANT_FLAG_KEY = "raceInitialSkillGrant";

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

Hooks.on("preUpdateItem", (item, _changes, _options, userId) => {
	if (item?.type !== "race") return;
	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;
	if (isCharacterCreationMode(actor)) return;
	if (game.user?.id === userId) notifyRaceLocked(actor);
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

Hooks.on("createItem", (item) => {
	if (item?.type !== "race") return;
	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;
	void syncStoredRaceName(actor, item.name).catch(reportRaceError);
	if (actor.sheet?.rendered) void actor.sheet.render({ force: true });
});

Hooks.on("updateItem", (item) => {
	if (item?.type !== "race") return;
	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;
	void syncStoredRaceName(actor, item.name).catch(reportRaceError);
	if (actor.sheet?.rendered) void actor.sheet.render({ force: true });
});

Hooks.on("deleteItem", (item) => {
	if (item?.type !== "race") return;
	const actor = item.parent;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;
	if (!getEmbeddedRace(actor)) void syncStoredRaceName(actor, "").catch(reportRaceError);
	if (actor.sheet?.rendered) void actor.sheet.render({ force: true });
});

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
	if (current?.uuid === race.uuid) {
		await syncStoredRaceName(actor, current.name);
		return current;
	}

	if (current) {
		await resetRaceDependentCreationState(actor);
		await actor.deleteEmbeddedDocuments("Item", [current.id]);
	}

	const data = race.toObject();
	delete data._id;
	delete data.folder;
	delete data.sort;
	delete data.ownership;

	const [created] = await actor.createEmbeddedDocuments("Item", [data]);
	await syncStoredRaceName(actor, created?.name ?? race.name ?? "");
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
			`Remove Race '${current.name}' from ${actor.name}? Race-derived starting Characteristics, Career Class, initial Career and generated initial Skills will be reset.`,
			`Usunąć Rasę „${current.name}” z postaci ${actor.name}? Początkowe Cechy zależne od Rasy, Klasa Zawodowa, Profesja początkowa oraz wygenerowane Umiejętności początkowe zostaną zresetowane.`,
		),
		rejectClose: false,
		modal: true,
	});
	if (!confirmed) return;

	await resetRaceDependentCreationState(actor);
	await actor.deleteEmbeddedDocuments("Item", [current.id]);
	await syncStoredRaceName(actor, "");
}

async function resetRaceDependentCreationState(actor) {
	await removeRaceGeneratedInitialSkills(actor);
	await resetInitialCareer(actor);

	const updates = {
		"system.details.careerClass": "",
		"system.details.currentCareer": "",
		"system.details.careerHistory": [],
		"system.details.careerExits": [],
	};

	for (const id of RACE_CHARACTERISTIC_IDS) {
		updates[`system.characteristics.${id}.initial`] = 0;
		updates[`system.characteristics.${id}.career`] = 0;
	}

	await actor.update(updates);
}

async function removeRaceGeneratedInitialSkills(actor) {
	const ids = [...(actor.items ?? [])]
		.filter((item) => item?.type === "skill" && Boolean(item.getFlag?.(
			CREATION_FLAG_SCOPE,
			RACE_INITIAL_SKILL_GRANT_FLAG_KEY,
		)))
		.map((item) => item.id)
		.filter(Boolean);
	if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
}

async function resetInitialCareer(actor) {
	const careers = [...(actor.items ?? [])].filter((item) => {
		if (item?.type !== "career") return false;
		const acquisition = item.getFlag?.(CREATION_FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY);
		return item.system?.current === true || acquisition?.kind === "initial";
	});

	for (const career of careers) {
		const acquisition = career.getFlag?.(CREATION_FLAG_SCOPE, CAREER_ACQUISITION_FLAG_KEY);
		if (acquisition?.kind === "initial") {
			await rollbackInitialCareerAcquisition(actor, acquisition);
		}
	}

	const careerIds = careers
		.map((career) => career.id)
		.filter((id) => id && actor.items?.has?.(id));
	if (careerIds.length) await actor.deleteEmbeddedDocuments("Item", careerIds);
}

async function rollbackInitialCareerAcquisition(actor, acquisition) {
	const itemIds = Array.isArray(acquisition?.createdItemIds)
		? acquisition.createdItemIds.filter((id) => actor.items?.has?.(id))
		: [];
	if (itemIds.length) await actor.deleteEmbeddedDocuments("Item", itemIds);

	for (const uuid of acquisition?.createdActorUuids ?? []) {
		try {
			const companion = await foundry.utils.fromUuid(String(uuid));
			if (
				companion instanceof foundry.documents.Actor &&
				companion.getFlag?.(CREATION_FLAG_SCOPE, CAREER_COMPANION_FLAG_KEY)?.ownerCharacterUuid === actor.uuid
			) await companion.delete();
		} catch (_error) {
			// Missing/deleted companion is already equivalent to successful rollback.
		}
	}

	const magic = acquisition?.magicPoints;
	if (
		magic &&
		nonNegativeInteger(actor.system?.status?.magicPoints) === nonNegativeInteger(magic.after)
	) {
		await actor.update({
			"system.status.magicPoints": nonNegativeInteger(magic.before),
		});
	}
}

async function syncStoredRaceName(actor, name) {
	const value = String(name ?? "").trim();
	if (String(actor.system?.details?.race ?? "") === value) return;
	await actor.update({ "system.details.race": value });
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
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
