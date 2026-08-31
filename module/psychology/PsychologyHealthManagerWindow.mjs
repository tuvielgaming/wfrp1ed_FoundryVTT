const {
	ApplicationV2,
	DialogV2,
	HandlebarsApplicationMixin,
} = foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const RACE_GRANT_FLAG = "racePsychologyGrant";

/** Large management surface for Character Psychology and Health records. */
export class PsychologyHealthManagerWindow extends HandlebarsApplicationMixin(
	ApplicationV2,
) {
	static #instances = new Map();

	static DEFAULT_OPTIONS = {
		classes: ["wfrp1ed", "psychology-health-manager-window", "wfrp1ed-parchment-window"],
		position: { width: 760, height: 600 },
		window: { icon: "fas fa-brain", resizable: true },
		actions: {
			selectTab: this.#selectTab,
			openItem: this.#openItem,
			removeItem: this.#removeItem,
		},
	};

	static PARTS = {
		body: { template: "systems/wfrp1ed/templates/apps/psychology-health-manager-window.hbs" },
	};

	constructor(actor, options = {}) {
		if (!isCharacter(actor)) throw new Error("Psychology and Health Manager requires a Character Actor.");
		super({ ...options, id: options.id ?? `wfrp1ed-psychology-health-${safeApplicationId(actor.uuid)}` });
		this.actor = actor;
		this.activeTab = validTab(options.tab) ?? "psychology";
	}

	get title() {
		return `${localize("Psychology and Health", "Psychika i Zdrowie")} — ${this.actor.name}`;
	}

	get canEdit() {
		return Boolean(game.user?.isGM || this.actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
	}

	static categories() { return implementedCategories(); }

	static count(actor) {
		if (!isCharacter(actor)) return 0;
		const types = new Set(this.categories().map((category) => category.itemType));
		return [...(actor.items ?? [])].filter((item) => types.has(item.type)).length;
	}

	static async open(actor, { tab = "psychology" } = {}) {
		if (!isCharacter(actor)) throw new Error("Psychology and Health Manager requires a Character Actor.");
		let application = this.#instances.get(actor.uuid);
		if (!application) {
			application = new PsychologyHealthManagerWindow(actor, { tab });
			this.#instances.set(actor.uuid, application);
		} else application.activeTab = validTab(tab) ?? application.activeTab;
		await application.render({ force: true });
		application.bringToFront();
		return application;
	}

	static async refresh(actor) {
		if (!isCharacter(actor)) return;
		const application = this.#instances.get(actor.uuid);
		if (!application?.rendered) return;
		await application.render({ force: true });
	}

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const categories = implementedCategories();
		if (!categories.some((category) => category.id === this.activeTab)) this.activeTab = categories[0]?.id ?? "psychology";
		const active = categories.find((category) => category.id === this.activeTab) ?? categories[0];
		const records = active ? categoryItems(this.actor, active).map(itemPresentation) : [];

		context.actor = { id: this.actor.id, uuid: this.actor.uuid, name: this.actor.name };
		context.editable = this.canEdit;
		context.tabs = categories.map((category) => ({
			id: category.id,
			label: categoryLabel(category),
			icon: category.icon,
			count: categoryItems(this.actor, category).length,
			active: category.id === this.activeTab,
		}));
		context.active = active ? {
			id: active.id,
			label: categoryLabel(active),
			icon: active.icon,
			hint: categoryHint(active),
			itemType: active.itemType,
		} : null;
		context.items = records;
		context.totalCount = this.constructor.count(this.actor);
		context.ui = {
			total: localize("Total", "Łącznie"),
			empty: localize("No entries in this category.", "Brak wpisów w tej kategorii."),
			open: localize("Open entry", "Otwórz wpis"),
			remove: localize("Remove entry", "Usuń wpis"),
			race: localize("Racial", "Rasowy"),
			drop: localize(
				"Drop a matching Item anywhere in this window or on the Character sheet.",
				"Upuść pasujący Przedmiot w dowolnym miejscu tego okna lub karty Postaci.",
			),
		};
		return context;
	}

	_onRender(context, options) {
		super._onRender(context, options);
		const root = asElement(this.element);
		if (!(root instanceof HTMLElement) || !this.canEdit) return;
		installWindowDrop(root, this);
	}

	_onClose(options) {
		super._onClose(options);
		if (PsychologyHealthManagerWindow.#instances.get(this.actor.uuid) === this) {
			PsychologyHealthManagerWindow.#instances.delete(this.actor.uuid);
		}
	}

	static async #selectTab(event, target) {
		event.preventDefault();
		const tab = validTab(target?.dataset?.tab);
		if (!tab || tab === this.activeTab) return;
		this.activeTab = tab;
		await this.render({ force: true });
	}

	static async #openItem(event, target) {
		event.preventDefault();
		const item = itemFromTarget(this.actor, target, this.activeTab);
		await item.sheet?.render?.({ force: true });
	}

	static async #removeItem(event, target) {
		event.preventDefault();
		if (!this.canEdit) return;
		const item = itemFromTarget(this.actor, target, this.activeTab);
		if (isRaceManaged(item)) {
			ui.notifications.warn(localize(
				"This Psychology entry is racial and is managed by the Character's Race, so it cannot be removed here.",
				"Ten wpis Psychologii jest rasowy i jest zarządzany przez Rasę Postaci, dlatego nie można go usunąć tutaj.",
			));
			return;
		}
		const confirmed = await DialogV2.confirm({
			window: { title: localize("Remove entry", "Usuń wpis") },
			content: localize(`Remove '${item.name}' from this character?`, `Usunąć „${item.name}” z tej postaci?`),
			rejectClose: false,
			modal: true,
		});
		if (!confirmed) return;
		await item.delete();
		await this.render({ force: true });
	}
}

const CATEGORY_DEFINITIONS = Object.freeze([
	Object.freeze({
		id: "psychology",
		itemType: "psychology",
		icon: "fas fa-brain",
		en: "Psychology",
		pl: "Psychologia",
		hintEn: "Psychological traits and conditions carried by this character.",
		hintPl: "Cechy i stany psychologiczne tej postaci.",
	}),
	Object.freeze({
		id: "diseases",
		itemType: "disease",
		icon: "fas fa-virus",
		en: "Diseases",
		pl: "Choroby",
		hintEn: "Diseases and infections currently affecting this character.",
		hintPl: "Choroby i zakażenia dotykające obecnie tej postaci.",
	}),
	/* Disorders and occupational magical diseases are added only after their
	 * Core-backed native Item models are implemented. */
]);

function implementedCategories() {
	return CATEGORY_DEFINITIONS.filter((category) => Boolean(CONFIG.Item?.dataModels?.[category.itemType]));
}

function validTab(value) {
	const id = String(value ?? "").trim();
	return implementedCategories().some((category) => category.id === id) ? id : null;
}

function categoryItems(actor, category) {
	return [...(actor.items ?? [])]
		.filter((item) => item?.type === category.itemType)
		.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), game.i18n.lang, { sensitivity: "base" }));
}

function itemPresentation(item) {
	return {
		id: item.id,
		name: String(item.name ?? ""),
		img: item.img || foundry.documents.Item.DEFAULT_ICON,
		description: preview(String(item.system?.description ?? "").trim(), 320),
		raceManaged: isRaceManaged(item),
	};
}

function isRaceManaged(item) {
	return item?.type === "psychology" && Boolean(item.getFlag?.(FLAG_SCOPE, RACE_GRANT_FLAG));
}

function itemFromTarget(actor, target, tab) {
	const category = implementedCategories().find((entry) => entry.id === tab);
	const id = String(target?.closest?.("[data-item-id]")?.dataset?.itemId ?? "");
	const item = actor.items?.get?.(id);
	if (!item || !category || item.type !== category.itemType) throw new Error("Psychology/Health Item could not be resolved.");
	return item;
}

function installWindowDrop(root, application) {
	if (root.dataset.psychologyHealthDropBound === "true") return;
	root.dataset.psychologyHealthDropBound = "true";
	for (const eventName of ["dragenter", "dragover"]) {
		root.addEventListener(eventName, (event) => {
			const item = draggedItemSync(event);
			if (!item || !categoryForItemType(item.type)) return;
			event.preventDefault();
			root.classList.add("is-health-manager-drag-over");
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});
	}
	root.addEventListener("dragleave", (event) => {
		if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
		root.classList.remove("is-health-manager-drag-over");
	});
	root.addEventListener("drop", (event) => {
		const item = draggedItemSync(event);
		const category = categoryForItemType(item?.type);
		if (!item || !category) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		root.classList.remove("is-health-manager-drag-over");
		void embedUnique(application.actor, item).then(async () => {
			application.activeTab = category.id;
			await application.render({ force: true });
		}).catch(reportError);
	}, true);
}

function categoryForItemType(type) {
	return implementedCategories().find((category) => category.itemType === type) ?? null;
}

async function embedUnique(actor, source) {
	if (!(source instanceof foundry.documents.Item)) return;
	if (source.parent === actor) return;
	const identity = canonicalIdentity(source);
	if ([...(actor.items ?? [])].some((item) => item.type === source.type && canonicalIdentity(item) === identity)) {
		ui.notifications.warn(localize(`${source.name} is already on this Character.`, `${source.name} jest już na tej Postaci.`));
		return;
	}
	const data = source.toObject();
	delete data._id;
	delete data.folder;
	delete data.sort;
	delete data.ownership;
	await actor.createEmbeddedDocuments("Item", [data]);
}

function draggedItemSync(event) {
	try {
		const data = foundry.applications.ux.TextEditor.getDragEventData(event) ?? {};
		if (String(data?.type ?? "") !== "Item") return null;
		const resolver = foundry.utils?.fromUuidSync ?? globalThis.fromUuidSync;
		if (typeof resolver !== "function") return null;
		const item = resolver(String(data?.uuid ?? ""));
		return item instanceof foundry.documents.Item ? item : null;
	} catch (_error) { return null; }
}

/* Internal content identity is used for duplicate detection only. It is not
 * presentation data and must not be exposed in the manager UI. */
function canonicalIdentity(item) { return normalize(item?.system?.rulesId) || normalize(item?.name); }
function categoryLabel(category) { return localize(category.en, category.pl); }
function categoryHint(category) { return localize(category.hintEn, category.hintPl); }
function preview(value, limit) { return !value || value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`; }
function safeApplicationId(value) { return String(value ?? "actor").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "actor"; }
function isCharacter(value) { return value?.documentName === "Actor" && value.type === "character"; }
function asElement(value) { return value instanceof HTMLElement ? value : value?.[0] instanceof HTMLElement ? value[0] : null; }
function normalize(value) { return String(value ?? "").trim().toLocaleLowerCase(); }
function localize(english, polish) { return game.i18n.lang === "pl" ? polish : english; }
function reportError(error) {
	console.error("WFRP1ED | Psychology and Health Manager failed.", error);
	ui.notifications.error(error?.message ?? String(error));
}
