import { CharacterCreationMode } from "./CharacterCreationModeIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "raceStartingDetails";

installRaceStartingDetailsIntegration();

/**
 * Apply deterministic Race-owned starting details which already have a clear
 * Character storage owner.
 *
 * This integration intentionally handles only Languages and Psychology.
 * Starting Alignment is deferred until its canonical Core vocabulary and
 * localized presentation are audited. Night Vision remains authoritative on
 * the embedded Race Item until the Character senses/vision subsystem exists.
 *
 * Values are copied only while Character Creation Mode is active. A narrow
 * Actor flag records exactly which text entries were injected by the Race so a
 * Race replacement/removal can remove those values without deleting manual
 * Character entries.
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
		void removeTrackedRaceStartingDetails(actor).catch(reportError);
	});

	/* A Race may already be embedded before the GM enables Character Creation
	 * Mode. Apply its deterministic details when the authoritative mode flag is
	 * switched on instead of requiring the Race to be removed/re-added. */
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
	const currentPsychology = textArray(actor.system?.details?.psychology);

	const manualLanguages = removeTrackedValues(currentLanguages, previous.languages);
	const manualPsychology = removeTrackedValues(currentPsychology, previous.psychology);

	const raceLanguages = uniqueText(
		(Array.isArray(race.system?.languages) ? race.system.languages : [])
			.map((entry) => entry?.name),
	);
	const racePsychology = uniqueText(
		(Array.isArray(race.system?.psychology) ? race.system.psychology : [])
			.map((entry) => entry?.name),
	);

	const languages = mergeUniqueText(manualLanguages, raceLanguages);
	const psychology = mergeUniqueText(manualPsychology, racePsychology);

	await actor.update({
		"system.details.languages": languages,
		"system.details.psychology": psychology,
	});

	await actor.setFlag(FLAG_SCOPE, FLAG_KEY, {
		raceItemId: String(race.id ?? ""),
		raceRulesId: String(race.system?.rulesId ?? "").trim(),
		languages: raceLanguages,
		psychology: racePsychology,
	});
}

async function removeTrackedRaceStartingDetails(actor) {
	const previous = trackedState(actor);
	if (!previous.languages.length && !previous.psychology.length) {
		await actor.unsetFlag?.(FLAG_SCOPE, FLAG_KEY);
		return;
	}

	const languages = removeTrackedValues(
		textArray(actor.system?.details?.languages),
		previous.languages,
	);
	const psychology = removeTrackedValues(
		textArray(actor.system?.details?.psychology),
		previous.psychology,
	);

	await actor.update({
		"system.details.languages": languages,
		"system.details.psychology": psychology,
	});
	await actor.unsetFlag?.(FLAG_SCOPE, FLAG_KEY);
}

function trackedState(actor) {
	const raw = actor.getFlag?.(FLAG_SCOPE, FLAG_KEY) ?? {};
	return {
		languages: uniqueText(raw?.languages),
		psychology: uniqueText(raw?.psychology),
	};
}

/**
 * Remove only one matching occurrence per tracked value. This is deliberately
 * narrower than filtering every equal string: if a user intentionally created
 * a duplicate manual entry, Race cleanup must not erase more data than the
 * integration itself can account for.
 */
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
	return foundry.utils.getProperty(changes ?? {}, path) === true ||
		changes?.[path] === true;
}

function normalize(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function reportError(error) {
	console.error("WFRP1ED | Unable to synchronize Race starting details.", error);
	ui.notifications.error(error?.message ?? String(error));
}
