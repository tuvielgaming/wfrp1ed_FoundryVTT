import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "raceStartingDetails";
const RACE_PSYCHOLOGY_GRANT_FLAG = "racePsychologyGrant";

installRaceStartingDetailsIntegration();

/**
 * Apply and invalidate deterministic Race-owned starting details which already
 * have a clear Character storage owner.
 *
 * Languages still use the Character's legacy text-array storage in this slice.
 * Psychology now uses native embedded Psychology Items. The Actor flag records
 * only Psychology Item ids actually created by the Race, so a manually added
 * Psychology Item with the same identity is never claimed/deleted by Race
 * cleanup.
 *
 * Age, Height and Fate are generated from Race formulas elsewhere, but are
 * invalid once the embedded Race changes, so this lifecycle owner clears them
 * when the Race leaves the Character during Character Creation.
 */
function installRaceStartingDetailsIntegration() {
	for (const hookName of ["createItem", "updateItem"]) {
		Hooks.on(hookName, (item) => {
			if (item?.type !== "race") return;
			const actor = item.parent;
			if (!isCreationCharacter(actor)) return;
			void syncRaceStartingDetails(actor, item).catch(reportError);
		});
	}

	Hooks.on("deleteItem", (item) => {
		if (item?.type !== "race") return;
		const actor = item.parent;
		if (!isCreationCharacter(actor)) return;
		void resetRaceStartingDetails(actor).catch(reportError);
	});

	Hooks.on("updateActor", (actor, changes) => {
		if (actor?.documentName !== "Actor" || actor.type !== "character") return;
		if (!creationModeWasEnabled(changes)) return;
		const race = embeddedRace(actor);
		if (!race) return;
		void syncRaceStartingDetails(actor, race).catch(reportError);
	});
}

async function syncRaceStartingDetails(actor, race) {
	const previous = trackedState(actor);
	const currentLanguages = textArray(actor.system?.details?.languages);
	const currentLegacyPsychology = textArray(actor.system?.details?.psychology);

	const manualLanguages = removeTrackedValues(currentLanguages, previous.languages);
	const manualLegacyPsychology = removeTrackedValues(currentLegacyPsychology, previous.psychology);

	await removeTrackedPsychologyItems(actor, previous.psychologyItemIds);

	const raceLanguages = uniqueText(
		(Array.isArray(race.system?.languages) ? race.system.languages : [])
			.map((entry) => entry?.name),
	);
	const languages = mergeUniqueText(manualLanguages, raceLanguages);

	/* Native Psychology Items supersede old Race-generated psychology strings.
	 * Preserve any untracked/manual legacy values until a later explicit data
	 * migration removes that storage contract. */
	await actor.update({
		"system.details.languages": languages,
		"system.details.psychology": manualLegacyPsychology,
	});

	const psychologyItemIds = await grantRacePsychologyItems(actor, race);

	await actor.setFlag(FLAG_SCOPE, FLAG_KEY, {
		raceItemId: String(race.id ?? ""),
		raceRulesId: String(race.system?.rulesId ?? "").trim(),
		languages: raceLanguages,
		psychology: [],
		psychologyItemIds,
	});
}

/**
 * Clear every secondary Character value which is currently produced from the
 * embedded Race. Gender is intentionally retained: it selects the Race Height
 * formula but is a player choice, not a Race-derived value.
 */
async function resetRaceStartingDetails(actor) {
	await removeTrackedRaceStartingDetails(actor);
	await actor.update({
		"system.details.age": "",
		"system.details.height": "",
		"system.status.fate.value": 0,
		"system.status.fate.max": 0,
	});
}

async function removeTrackedRaceStartingDetails(actor) {
	const previous = trackedState(actor);
	const languages = removeTrackedValues(
		textArray(actor.system?.details?.languages),
		previous.languages,
	);
	const legacyPsychology = removeTrackedValues(
		textArray(actor.system?.details?.psychology),
		previous.psychology,
	);

	await removeTrackedPsychologyItems(actor, previous.psychologyItemIds);

	await actor.update({
		"system.details.languages": languages,
		"system.details.psychology": legacyPsychology,
	});
	await actor.unsetFlag?.(FLAG_SCOPE, FLAG_KEY);
}

async function grantRacePsychologyItems(actor, race) {
	const references = Array.isArray(race.system?.psychology)
		? foundry.utils.deepClone(race.system.psychology)
		: [];
	const createdIds = [];

	for (const reference of references) {
		const source = await resolvePsychologyReference(reference);
		if (!source) {
			ui.notifications.warn(localize(
				`Race '${race.name}' references Psychology '${reference?.name || reference?.rulesId || "?"}', but its Psychology Item could not be found.`,
				`Rasa „${race.name}” odwołuje się do Psychologii „${reference?.name || reference?.rulesId || "?"}”, ale nie znaleziono jej Przedmiotu Psychologii.`,
			));
			continue;
		}

		const identity = psychologyIdentity(source);
		const alreadyPresent = [...(actor.items ?? [])].some((item) =>
			item?.type === "psychology" && psychologyIdentity(item) === identity,
		);
		if (alreadyPresent) continue;

		const data = source.toObject();
		delete data._id;
		delete data.folder;
		delete data.sort;
		delete data.ownership;
		data.flags ??= {};
		data.flags[FLAG_SCOPE] ??= {};
		data.flags[FLAG_SCOPE][RACE_PSYCHOLOGY_GRANT_FLAG] = {
			raceItemId: String(race.id ?? ""),
			raceRulesId: String(race.system?.rulesId ?? "").trim(),
			sourceUuid: String(source.uuid ?? ""),
		};

		const [created] = await actor.createEmbeddedDocuments("Item", [data]);
		if (created?.id) createdIds.push(created.id);
	}
	return createdIds;
}

async function removeTrackedPsychologyItems(actor, ids) {
	const trackedIds = uniqueText(ids).filter((id) => {
		const item = actor.items?.get?.(id);
		return item?.type === "psychology" && Boolean(item.getFlag?.(FLAG_SCOPE, RACE_PSYCHOLOGY_GRANT_FLAG));
	});
	if (trackedIds.length) await actor.deleteEmbeddedDocuments("Item", trackedIds);
}

async function resolvePsychologyReference(reference) {
	const uuid = String(reference?.uuid ?? "").trim();
	if (uuid) {
		try {
			const document = await foundry.utils.fromUuid(uuid);
			if (document instanceof foundry.documents.Item && document.type === "psychology") return document;
		} catch (_error) {
			// Fall through to stable Rules ID/name lookup.
		}
	}

	const rulesId = normalize(reference?.rulesId);
	const name = normalize(reference?.name);
	return [...(game.items ?? [])].find((item) =>
		item?.type === "psychology" &&
		((rulesId && normalize(item.system?.rulesId) === rulesId) || (!rulesId && name && normalize(item.name) === name)),
	) ?? null;
}

function psychologyIdentity(item) {
	return normalize(item?.system?.rulesId) || normalize(item?.name);
}

function trackedState(actor) {
	const raw = actor.getFlag?.(FLAG_SCOPE, FLAG_KEY) ?? {};
	return {
		languages: uniqueText(raw?.languages),
		psychology: uniqueText(raw?.psychology),
		psychologyItemIds: uniqueText(raw?.psychologyItemIds),
	};
}

function removeTrackedValues(values, tracked) {
	const result = [...values];
	for (const generated of uniqueText(tracked)) {
		const identity = normalize(generated);
		const index = result.findIndex((value) => normalize(value) === identity);
		if (index >= 0) result.splice(index, 1);
	}
	return result;
}

function mergeUniqueText(existing, additions) {
	const result = [...existing];
	const identities = new Set(result.map(normalize).filter(Boolean));
	for (const value of additions) {
		const identity = normalize(value);
		if (!identity || identities.has(identity)) continue;
		identities.add(identity);
		result.push(value);
	}
	return result;
}

function uniqueText(values) {
	const result = [];
	const identities = new Set();
	for (const value of Array.isArray(values) ? values : []) {
		const text = String(value ?? "").trim();
		const identity = normalize(text);
		if (!identity || identities.has(identity)) continue;
		identities.add(identity);
		result.push(text);
	}
	return result;
}

function textArray(value) {
	return (Array.isArray(value) ? value : [])
		.map((entry) => String(entry ?? "").trim())
		.filter(Boolean);
}

function embeddedRace(actor) {
	return game.WFRP1ED?.race?.getEmbeddedRace?.(actor) ??
		actor?.items?.find?.((item) => item.type === "race") ?? null;
}

function isCreationCharacter(actor) {
	return actor?.documentName === "Actor" &&
		actor.type === "character" &&
		CharacterCreationMode.enabled(actor);
}

function creationModeWasEnabled(changes) {
	const path = "flags.wfrp1ed.characterCreationMode";
	return foundry.utils.getProperty(changes ?? {}, path) === true || changes?.[path] === true;
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to synchronize Race starting details.", error);
	ui.notifications.error(error?.message ?? String(error));
}
