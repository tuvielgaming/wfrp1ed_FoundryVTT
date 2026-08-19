import {
	CAREER_DOCUMENT_TYPE,
	CAREER_ENTRY_MODE,
} from "../data-models/item/CareerData.mjs";
import { CareerItemSheet } from "../sheets/CareerItemSheet.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CORE_CATALOG_FLAG_KEY = "coreCatalog";

installCompactCareerAuthoring();

/**
 * Career authoring is item-first rather than package-first:
 * - recognized documents dropped anywhere on the Career sheet are routed by
 *   document type to Skills, Trappings, or Career Exits;
 * - every Skill/Trapping drop creates one standalone entry;
 * - dropping on an existing row never mutates that row into a package.
 *
 * The underlying CareerData entry/choice/grant model is deliberately preserved.
 * Existing packages therefore remain mechanically valid while the authoring
 * surface can present their choices as compact list rows.
 */
function installCompactCareerAuthoring() {
	if (CareerItemSheet.prototype.__wfrpCompactCareerAuthoringInstalled === true) return;

	const originalDrop = CareerItemSheet.prototype._onDropDocument;
	CareerItemSheet.prototype._onDropDocument = async function compactCareerDrop(event, document) {
		if (!this.isEditable) return null;

		const destination = destinationForDocument(document);
		if (destination === "skills" || destination === "trappings") {
			return addStandaloneGrant(this, destination, document);
		}
		if (destination === "exits") {
			return addCareerExit(this, document);
		}

		return originalDrop.call(this, event, document);
	};

	const originalPrepareContext = CareerItemSheet.prototype._prepareContext;
	CareerItemSheet.prototype._prepareContext = async function compactCareerContext(options) {
		const context = await originalPrepareContext.call(this, options);
		context.careerCompact = {
			skills: compactRows(this.document.system?.skills, "skills"),
			trappings: compactRows(this.document.system?.trappings, "trappings"),
			exits: Array.isArray(context?.careerUi?.exits) ? context.careerUi.exits : [],
			hints: {
				skills: localize(
					"Drop a Skill anywhere on this Career sheet to add it here.",
					"Upuść Umiejętność w dowolnym miejscu tej karty Profesji, aby dodać ją tutaj.",
				),
				trappings: localize(
					"Drop Equipment, Weapon, Armour, or a Creature anywhere on this Career sheet to add it here.",
					"Upuść Ekwipunek, Broń, Pancerz lub Stworzenie w dowolnym miejscu tej karty Profesji, aby dodać je tutaj.",
				),
				exits: localize(
					"Drop a Career anywhere on this Career sheet to add it as a Career Exit.",
					"Upuść Profesję w dowolnym miejscu tej karty Profesji, aby dodać ją jako Profesję wyjściową.",
				),
			},
		};
		return context;
	};

	Object.defineProperty(
		CareerItemSheet.prototype,
		"__wfrpCompactCareerAuthoringInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function destinationForDocument(document) {
	if (document instanceof foundry.documents.Item) {
		if (document.type === "skill") return "skills";
		if (["equipment", "weapon", "armour"].includes(document.type)) return "trappings";
		if (document.type === "career") return "exits";
	}
	if (document instanceof foundry.documents.Actor && document.type === "creature") {
		return "trappings";
	}
	return "";
}

async function addStandaloneGrant(sheet, collectionName, document) {
	const entries = cloneArray(sheet.document.system?.[collectionName]);
	const grant = grantFromDocument(document);

	if (grantAlreadyPresent(entries, grant)) {
		ui.notifications.info(localize(
			`${grantDisplayName(grant)} is already listed in this Career.`,
			`${grantDisplayName(grant)} jest już wpisane w tej Profesji.`,
		));
		return null;
	}

	entries.push(entryFromGrant(grant));
	await sheet.document.update({ [`system.${collectionName}`]: entries });
	return document;
}

async function addCareerExit(sheet, document) {
	const exits = cloneArray(sheet.document.system?.exits);
	const reference = {
		uuid: String(document.uuid ?? ""),
		rulesId: String(document.system?.rulesId ?? ""),
		name: String(document.name ?? ""),
	};

	if (exits.some((entry) => sameReference(entry, reference))) {
		ui.notifications.info(localize(
			`${document.name} is already a Career Exit.`,
			`${document.name} jest już Profesją wyjściową.`,
		));
		return null;
	}

	exits.push({
		...reference,
		condition: "",
		requiresComplete: false,
		excludedRaces: [],
	});
	await sheet.document.update({ "system.exits": exits });
	return document;
}

function compactRows(source, collectionName) {
	const rows = [];
	let packageNumber = 0;

	for (const entry of cloneArray(source)) {
		const choices = Array.isArray(entry?.choices) ? entry.choices : [];
		if (!choices.length) continue;

		const isPackage = choices.length > 1;
		const currentPackageNumber = isPackage ? ++packageNumber : 0;
		const metaLabel = entryMetaLabel(entry, choices.length, currentPackageNumber);

		for (const choice of choices) {
			rows.push({
				collectionName,
				entryId: String(entry?.id ?? ""),
				choiceId: String(choice?.id ?? ""),
				label: choiceLabel(choice),
				note: String(entry?.note ?? "").trim(),
				metaLabel,
				isPackage,
				packageNumber: currentPackageNumber,
			});
		}
	}

	return rows;
}

function entryMetaLabel(entry, choiceCount, packageNumber) {
	const chance = clampPercentage(entry?.chance);
	if (choiceCount <= 1) return chance < 100 ? `${chance}%` : "";

	let packageText;
	switch (String(entry?.mode ?? CAREER_ENTRY_MODE.ALL)) {
		case CAREER_ENTRY_MODE.PLAYER_CHOICE:
			packageText = localize(
				`Package ${packageNumber}: choose ${Math.min(choiceCount, Math.max(1, nonNegativeInteger(entry?.choose)))} of ${choiceCount}`,
				`Pakiet ${packageNumber}: wybierz ${Math.min(choiceCount, Math.max(1, nonNegativeInteger(entry?.choose)))} z ${choiceCount}`,
			);
			break;
		case CAREER_ENTRY_MODE.RANDOM_CHOICE:
			packageText = localize(
				`Package ${packageNumber}: random 1 of ${choiceCount}`,
				`Pakiet ${packageNumber}: losowo 1 z ${choiceCount}`,
			);
			break;
		default:
			packageText = localize(
				`Package ${packageNumber}: all ${choiceCount}`,
				`Pakiet ${packageNumber}: wszystkie ${choiceCount}`,
			);
	}
	return chance < 100 ? `${packageText} • ${chance}%` : packageText;
}

function choiceLabel(choice) {
	const explicit = String(choice?.label ?? "").trim();
	if (explicit) return explicit;
	return (choice?.grants ?? [])
		.map(grantDisplayName)
		.filter(Boolean)
		.join(" + ");
}

function grantFromDocument(document) {
	const isItem = document instanceof foundry.documents.Item;
	const catalogue = isItem ? document.getFlag?.(FLAG_SCOPE, CORE_CATALOG_FLAG_KEY) : null;
	const rulesId = isItem
		? String(
			document.system?.rulesId ||
			catalogue?.canonicalRulesId ||
			catalogue?.catalogId ||
			"",
		).trim()
		: "";

	return {
		uuid: String(document.uuid ?? ""),
		rulesId,
		name: String(document.name ?? ""),
		specialisation: isItem && document.type === "skill"
			? String(document.system?.specialisation ?? document.system?.specialization ?? "").trim()
			: "",
		documentType: isItem ? CAREER_DOCUMENT_TYPE.ITEM : CAREER_DOCUMENT_TYPE.ACTOR,
		documentSubtype: String(document.type ?? ""),
		quantity: 1,
	};
}

function entryFromGrant(grant) {
	return {
		id: foundry.utils.randomID(),
		chance: 100,
		mode: CAREER_ENTRY_MODE.ALL,
		choose: 1,
		note: "",
		choices: [{
			id: foundry.utils.randomID(),
			label: grantDisplayName(grant),
			grants: [{ ...grant }],
		}],
	};
}

function grantAlreadyPresent(entries, grant) {
	for (const entry of entries) {
		for (const choice of entry?.choices ?? []) {
			for (const existing of choice?.grants ?? []) {
				if (sameReference(existing, grant)) return true;
			}
		}
	}
	return false;
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

function sameReference(left, right) {
	const leftSpecialisation = normalizeName(left?.specialisation);
	const rightSpecialisation = normalizeName(right?.specialisation);
	const leftRules = String(left?.rulesId ?? "").trim();
	const rightRules = String(right?.rulesId ?? "").trim();
	if (leftRules && rightRules) {
		return leftRules === rightRules && leftSpecialisation === rightSpecialisation;
	}

	const leftUuid = String(left?.uuid ?? "").trim();
	const rightUuid = String(right?.uuid ?? "").trim();
	if (leftUuid && rightUuid) {
		return leftUuid === rightUuid && leftSpecialisation === rightSpecialisation;
	}

	return normalizeName(left?.name) === normalizeName(right?.name) &&
		leftSpecialisation === rightSpecialisation;
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

function normalizeName(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
