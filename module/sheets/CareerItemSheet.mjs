import {
	CAREER_CLASS,
	CAREER_DOCUMENT_TYPE,
	CAREER_ENTRY_MODE,
	CAREER_TIER,
} from "../data-models/item/CareerData.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const CORE_CATALOG_FLAG_KEY = "coreCatalog";

const CHARACTERISTICS = Object.freeze([
	["m", "Sz", "M"],
	["ws", "WW", "WS"],
	["bs", "US", "BS"],
	["s", "S", "S"],
	["t", "Wt", "T"],
	["w", "Żyw", "W"],
	["i", "I", "I"],
	["a", "A", "A"],
	["dex", "Zr", "Dex"],
	["ld", "CP", "Ld"],
	["int", "Int", "Int"],
	["cl", "Op", "Cl"],
	["wp", "SW", "WP"],
	["fel", "Ogd", "Fel"],
]);

/**
 * Native WFRP 1e Career sheet.
 *
 * The visible hierarchy follows the compact Core Rulebook Career entry:
 * title/description -> Advance Scheme -> Skills -> Trappings -> Magic Points ->
 * Career Exits. Editing controls remain deliberately small so the sheet reads
 * like a Career description rather than a modern configuration dashboard.
 */
export class CareerItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"sheet",
			"item",
			"career-item-sheet",
			"wfrp1ed-parchment-window",
		],
		position: {
			width: 880,
			height: 820,
		},
		tag: "form",
		form: {
			/* Career data contains nested arrays and an Advance Scheme object.
			 * Never let ApplicationV2 submit an expanded whole-form snapshot when a
			 * single control changes; CareerItemAuthoringIntegration owns exact-path
			 * persistence and the dedicated actions own their collections. */
			submitOnChange: false,
			closeOnSubmit: false,
		},
		actions: {
			configureEntry: this.#configureEntry,
			deleteEntry: this.#deleteEntry,
			deleteChoice: this.#deleteChoice,
			addMagicPoints: this.#addMagicPoints,
			editMagicPoints: this.#editMagicPoints,
			deleteMagicPoints: this.#deleteMagicPoints,
			deleteExit: this.#deleteExit,
		},
	};

	static PARTS = {
		form: {
			template: "systems/wfrp1ed/templates/item/career-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const source = this.document.system?.toObject?.() ??
			foundry.utils.deepClone(this.document.system ?? {});

		context.item = this.document;
		context.system = source;
		context.editable = this.isEditable;
		context.careerUi = {
			classOptions: classOptions(source.class),
			tierOptions: tierOptions(source.tier),
			characteristics: CHARACTERISTICS.map(([id, pl, en]) => ({
				id,
				label: game.i18n.lang === "pl" ? pl : en,
				steps: nonNegativeInteger(source.advanceScheme?.[id]),
				display: formatAdvance(id, source.advanceScheme?.[id]),
			})),
			skills: presentEntries(source.skills, "skills"),
			trappings: presentEntries(source.trappings, "trappings"),
			magicPoints: presentMagicPoints(source.magicPoints),
			exits: presentExits(source.exits),
			labels: labels(),
		};
		return context;
	}

	/**
	 * Drop contract:
	 * - section -> a new Career entry;
	 * - existing entry -> a new alternative choice;
	 * - existing choice chip -> another grant in that same choice/bundle.
	 *
	 * The last form is required for Core entries such as
	 * "bow + ammunition OR crossbow + ammunition".
	 */
	async _onDropDocument(event, document) {
		if (!this.isEditable) return null;
		const target = event.target?.closest?.("[data-career-drop-zone]");
		const zone = String(target?.dataset?.careerDropZone ?? "");
		if (!zone) return super._onDropDocument(event, document);

		if (zone === "skills") {
			if (!(document instanceof foundry.documents.Item) || document.type !== "skill") {
				ui.notifications.warn(localize(
					"Drop a Skill Item here.",
					"Upuść tutaj Przedmiot Umiejętności.",
				));
				return null;
			}
			return this.#addGrantDrop("skills", target, document);
		}

		if (zone === "trappings") {
			const isItem = document instanceof foundry.documents.Item &&
				["equipment", "weapon", "armour"].includes(document.type);
			const isCreature = document instanceof foundry.documents.Actor &&
				document.type === "creature";
			if (!isItem && !isCreature) {
				ui.notifications.warn(localize(
					"Drop Equipment, Weapon, Armour, or a Creature Actor here.",
					"Upuść tutaj Ekwipunek, Broń, Pancerz albo Aktora typu Stworzenie.",
				));
				return null;
			}
			return this.#addGrantDrop("trappings", target, document);
		}

		if (zone === "exits") {
			if (!(document instanceof foundry.documents.Item) || document.type !== "career") {
				ui.notifications.warn(localize(
					"Drop a Career Item here.",
					"Upuść tutaj Przedmiot Profesji.",
				));
				return null;
			}
			return this.#addExit(document);
		}

		return super._onDropDocument(event, document);
	}

	async #addGrantDrop(collectionName, target, document) {
		const entries = cloneArray(this.document.system?.[collectionName]);
		const entryId = String(target?.dataset?.careerEntryId ?? "");
		const choiceId = String(target?.dataset?.careerChoiceId ?? "");
		const grant = grantFromDocument(document);

		if (grantAlreadyPresent(entries, grant)) {
			ui.notifications.info(localize(
				`${grantDisplayName(grant)} is already listed in this Career.`,
				`${grantDisplayName(grant)} jest już wpisane w tej Profesji.`,
			));
			return null;
		}

		if (entryId) {
			const entry = entries.find((candidate) => String(candidate?.id ?? "") === entryId);
			if (!entry) return null;
			entry.choices ??= [];

			if (choiceId) {
				const choice = entry.choices.find(
					(candidate) => String(candidate?.id ?? "") === choiceId,
				);
				if (!choice) return null;
				choice.grants ??= [];
				choice.grants.push(grant);
				choice.label = choice.grants.map(grantDisplayName).join(" + ");
			} else {
				entry.choices.push(choiceFromGrant(grant));
				if (entry.choices.length > 1 && entry.mode === CAREER_ENTRY_MODE.ALL) {
					entry.mode = CAREER_ENTRY_MODE.PLAYER_CHOICE;
				}
			}
		} else {
			entries.push(entryFromGrant(grant, collectionName));
		}

		await this.document.update({ [`system.${collectionName}`]: entries });
		return document;
	}

	async #addExit(document) {
		const exits = cloneArray(this.document.system?.exits);
		const rulesId = String(document.system?.rulesId ?? "");
		if (exits.some((entry) => sameReference(entry, {
			uuid: document.uuid,
			rulesId,
			name: document.name,
		}))) {
			ui.notifications.info(localize(
				`${document.name} is already a Career Exit.`,
				`${document.name} jest już Profesją wyjściową.`,
			));
			return null;
		}
		exits.push({
			uuid: String(document.uuid ?? ""),
			rulesId,
			name: String(document.name ?? ""),
			condition: "",
			requiresComplete: false,
			excludedRaces: [],
		});
		await this.document.update({ "system.exits": exits });
		return document;
	}

	/** @this {CareerItemSheet} */
	static async #configureEntry(_event, target) {
		if (!this.isEditable) return;
		const collectionName = String(target?.dataset?.careerCollection ?? "");
		const entryId = String(target?.dataset?.careerEntryId ?? "");
		if (!["skills", "trappings"].includes(collectionName) || !entryId) return;
		const entries = cloneArray(this.document.system?.[collectionName]);
		const index = entries.findIndex((entry) => String(entry?.id ?? "") === entryId);
		if (index < 0) return;
		const entry = entries[index];
		const result = await configureEntryDialog(entry);
		if (!result) return;
		entries[index] = { ...entry, ...result };
		await this.document.update({ [`system.${collectionName}`]: entries });
	}

	/** @this {CareerItemSheet} */
	static async #deleteEntry(_event, target) {
		if (!this.isEditable) return;
		const collectionName = String(target?.dataset?.careerCollection ?? "");
		const entryId = String(target?.dataset?.careerEntryId ?? "");
		if (!["skills", "trappings"].includes(collectionName) || !entryId) return;
		const entries = cloneArray(this.document.system?.[collectionName]);
		const next = entries.filter((entry) => String(entry?.id ?? "") !== entryId);
		await this.document.update({ [`system.${collectionName}`]: next });
	}

	/** @this {CareerItemSheet} */
	static async #deleteChoice(_event, target) {
		if (!this.isEditable) return;
		const collectionName = String(target?.dataset?.careerCollection ?? "");
		const entryId = String(target?.dataset?.careerEntryId ?? "");
		const choiceId = String(target?.dataset?.careerChoiceId ?? "");
		if (!["skills", "trappings"].includes(collectionName) || !entryId || !choiceId) return;
		const entries = cloneArray(this.document.system?.[collectionName]);
		const entry = entries.find((candidate) => String(candidate?.id ?? "") === entryId);
		if (!entry) return;
		entry.choices = (entry.choices ?? []).filter(
			(choice) => String(choice?.id ?? "") !== choiceId,
		);
		if (!entry.choices.length) {
			await this.document.update({
				[`system.${collectionName}`]: entries.filter(
					(candidate) => String(candidate?.id ?? "") !== entryId,
				),
			});
			return;
		}
		if (entry.choices.length === 1) entry.mode = CAREER_ENTRY_MODE.ALL;
		await this.document.update({ [`system.${collectionName}`]: entries });
	}

	/** @this {CareerItemSheet} */
	static async #addMagicPoints() {
		if (!this.isEditable) return;
		const result = await magicPointsDialog();
		if (!result) return;
		const entries = cloneArray(this.document.system?.magicPoints);
		entries.push(result);
		await this.document.update({ "system.magicPoints": entries });
	}

	/** @this {CareerItemSheet} */
	static async #editMagicPoints(_event, target) {
		if (!this.isEditable) return;
		const index = Number(target?.dataset?.careerIndex);
		const entries = cloneArray(this.document.system?.magicPoints);
		if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
		const result = await magicPointsDialog(entries[index]);
		if (!result) return;
		entries[index] = result;
		await this.document.update({ "system.magicPoints": entries });
	}

	/** @this {CareerItemSheet} */
	static async #deleteMagicPoints(_event, target) {
		if (!this.isEditable) return;
		const index = Number(target?.dataset?.careerIndex);
		const entries = cloneArray(this.document.system?.magicPoints);
		if (!Number.isInteger(index) || index < 0 || index >= entries.length) return;
		entries.splice(index, 1);
		await this.document.update({ "system.magicPoints": entries });
	}

	/** @this {CareerItemSheet} */
	static async #deleteExit(_event, target) {
		if (!this.isEditable) return;
		const index = Number(target?.dataset?.careerIndex);
		const exits = cloneArray(this.document.system?.exits);
		if (!Number.isInteger(index) || index < 0 || index >= exits.length) return;
		exits.splice(index, 1);
		await this.document.update({ "system.exits": exits });
	}
}

function presentEntries(source, collectionName) {
	return cloneArray(source).map((entry) => {
		const choices = (entry.choices ?? []).map((choice) => ({
			...choice,
			label: choiceLabel(choice),
		}));
		return {
			...entry,
			collectionName,
			choices,
			chanceLabel: nonNegativeInteger(entry.chance) < 100
				? `${nonNegativeInteger(entry.chance)}%`
				: "",
			modeLabel: entryModeLabel(entry.mode, choices.length),
			display: entryDisplay(entry, choices),
		};
	});
}

function presentMagicPoints(source) {
	return cloneArray(source).map((entry, index) => ({
		...entry,
		index,
		raceLabel: Array.isArray(entry.races) && entry.races.length
			? entry.races.join(", ")
			: localize("All races", "Wszystkie rasy"),
	}));
}

function presentExits(source) {
	return cloneArray(source).map((entry, index) => ({
		...entry,
		index,
		displayName: resolvedName(entry),
	}));
}

function entryDisplay(entry, choices) {
	const labels = choices.map((choice) => choice.label).filter(Boolean);
	if (!labels.length) return localize("Empty entry", "Pusty wpis");
	if (entry.mode === CAREER_ENTRY_MODE.ALL || labels.length === 1) return labels.join(", ");
	return labels.join(localize(" or ", " albo "));
}

function choiceLabel(choice) {
	if (String(choice?.label ?? "").trim()) return String(choice.label).trim();
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

function resolvedName(reference) {
	const document = resolvedDocument(reference);
	return String(document?.name ?? reference?.name ?? reference?.rulesId ?? "").trim();
}

function resolvedDocument(reference) {
	const uuid = String(reference?.uuid ?? "");
	if (!uuid) return null;
	try {
		return foundry.utils.fromUuidSync(uuid);
	} catch (_error) {
		return null;
	}
}

function entryModeLabel(mode, choiceCount) {
	if (choiceCount <= 1) return "";
	switch (mode) {
		case CAREER_ENTRY_MODE.PLAYER_CHOICE:
			return localize("choose", "wybór");
		case CAREER_ENTRY_MODE.RANDOM_CHOICE:
			return localize("random", "losowo");
		default:
			return localize("all", "wszystkie");
	}
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

function entryFromGrant(grant, collectionName) {
	const id = foundry.utils.randomID();
	return {
		id,
		chance: 100,
		mode: CAREER_ENTRY_MODE.ALL,
		choose: 1,
		note: "",
		choices: [{
			id: foundry.utils.randomID(),
			label: grantDisplayName(grant),
			grants: [{ ...grant }],
		}],
		collectionName,
	};
}

function choiceFromGrant(grant) {
	return {
		id: foundry.utils.randomID(),
		label: grantDisplayName(grant),
		grants: [{ ...grant }],
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

function sameReference(left, right) {
	const leftSpecialisation = normalizeName(left?.specialisation);
	const rightSpecialisation = normalizeName(right?.specialisation);
	const leftRules = String(left?.rulesId ?? "");
	const rightRules = String(right?.rulesId ?? "");
	if (leftRules && rightRules) {
		return leftRules === rightRules && leftSpecialisation === rightSpecialisation;
	}
	const leftUuid = String(left?.uuid ?? "");
	const rightUuid = String(right?.uuid ?? "");
	if (leftUuid && rightUuid) {
		return leftUuid === rightUuid && leftSpecialisation === rightSpecialisation;
	}
	return normalizeName(left?.name) === normalizeName(right?.name) &&
		leftSpecialisation === rightSpecialisation;
}

async function configureEntryDialog(entry) {
	const mode = String(entry?.mode ?? CAREER_ENTRY_MODE.ALL);
	const content = `
		<div class="wfrp1ed career-entry-dialog">
			<label>${escapeHtml(localize("Acquisition chance (%)", "Szansa zdobycia (%)"))}
				<input type="number" name="chance" min="0" max="100" step="1" value="${nonNegativeInteger(entry?.chance)}">
			</label>
			<label>${escapeHtml(localize("Alternatives", "Alternatywy"))}
				<select name="mode">
					<option value="all" ${mode === "all" ? "selected" : ""}>${escapeHtml(localize("All are gained", "Zdobywane są wszystkie"))}</option>
					<option value="player-choice" ${mode === "player-choice" ? "selected" : ""}>${escapeHtml(localize("Player chooses", "Gracz wybiera"))}</option>
					<option value="random-choice" ${mode === "random-choice" ? "selected" : ""}>${escapeHtml(localize("Random equal choice", "Losowy wybór z równą szansą"))}</option>
				</select>
			</label>
			<label>${escapeHtml(localize("Number selected", "Liczba wybieranych"))}
				<input type="number" name="choose" min="1" step="1" value="${Math.max(1, nonNegativeInteger(entry?.choose))}">
			</label>
			<label>${escapeHtml(localize("Rule note / condition", "Uwagi / warunek"))}
				<input type="text" name="note" value="${escapeHtml(String(entry?.note ?? ""))}">
			</label>
		</div>
	`;
	return DialogV2.wait({
		window: { title: localize("Configure Career entry", "Konfiguruj wpis Profesji") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "save",
			label: localize("Save", "Zapisz"),
			default: true,
			callback: (_event, button) => {
				const form = button.form;
				const data = new FormData(form);
				return {
					chance: Math.max(0, Math.min(100, Number(data.get("chance") ?? 100))),
					mode: Object.values(CAREER_ENTRY_MODE).includes(String(data.get("mode")))
						? String(data.get("mode"))
						: CAREER_ENTRY_MODE.ALL,
					choose: Math.max(1, Math.trunc(Number(data.get("choose") ?? 1))),
					note: String(data.get("note") ?? "").trim(),
				};
			},
		}],
	});
}

async function magicPointsDialog(existing = {}) {
	const races = Array.isArray(existing?.races) ? existing.races.join(", ") : "";
	const content = `
		<div class="wfrp1ed career-entry-dialog">
			<label>${escapeHtml(localize("Races (comma separated; blank = all)", "Rasy (oddzielone przecinkami; puste = wszystkie)"))}
				<input type="text" name="races" value="${escapeHtml(races)}">
			</label>
			<label>${escapeHtml(localize("Magic Point formula", "Formuła Punktów Magii"))}
				<input type="text" name="formula" value="${escapeHtml(String(existing?.formula ?? ""))}" placeholder="2d4">
			</label>
			<label>${escapeHtml(localize("Rule note", "Uwagi"))}
				<input type="text" name="note" value="${escapeHtml(String(existing?.note ?? ""))}">
			</label>
		</div>
	`;
	return DialogV2.wait({
		window: { title: localize("Magic Points", "Punkty Magii") },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "save",
			label: localize("Save", "Zapisz"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				const formula = String(data.get("formula") ?? "").trim();
				if (!formula) return false;
				return {
					races: String(data.get("races") ?? "")
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean),
					formula,
					note: String(data.get("note") ?? "").trim(),
				};
			},
		}],
	});
}

function classOptions(selected) {
	return [
		[CAREER_CLASS.WARRIOR, localize("Warrior", "Wojownik")],
		[CAREER_CLASS.RANGER, localize("Ranger", "Wędrowiec")],
		[CAREER_CLASS.ROGUE, localize("Rogue", "Łotrzyk")],
		[CAREER_CLASS.ACADEMIC, localize("Academic", "Uczony")],
	].map(([value, label]) => ({ value, label, selected: value === selected }));
}

function tierOptions(selected) {
	return [
		[CAREER_TIER.BASIC, localize("Basic", "Podstawowa")],
		[CAREER_TIER.ADVANCED, localize("Advanced", "Zaawansowana")],
	].map(([value, label]) => ({ value, label, selected: value === selected }));
}

function formatAdvance(id, steps) {
	const amount = nonNegativeInteger(steps);
	if (!amount) return "—";
	const step = ["m", "s", "t", "w", "a"].includes(id) ? 1 : 10;
	return `+${amount * step}`;
}

function labels() {
	return {
		class: localize("Career Class", "Klasa"),
		tier: localize("Career type", "Rodzaj profesji"),
		advanceScheme: localize("Advance Scheme", "Schemat rozwoju"),
		skills: localize("Skills", "Umiejętności"),
		trappings: localize("Trappings", "Wyposażenie"),
		magicPoints: localize("Magic Points", "Punkty Magii"),
		exits: localize("Career Exits", "Profesje wyjściowe"),
		dropSkill: localize("Drop Skill here; drop onto an existing option to build a bundle", "Upuść tutaj Umiejętność; upuść na istniejącą opcję, aby utworzyć pakiet"),
		dropTrapping: localize("Drop Equipment, Weapon, Armour or Creature here; drop onto an option to add to its bundle", "Upuść tutaj Ekwipunek, Broń, Pancerz lub Stworzenie; upuść na opcję, aby dodać do jej pakietu"),
		dropExit: localize("Drop Career here", "Upuść tutaj Profesję"),
	};
}

function cloneArray(value) {
	return Array.isArray(value)
		? foundry.utils.deepClone(value)
		: [];
}

function normalizeName(value) {
	return String(value ?? "").trim().toLocaleLowerCase();
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
