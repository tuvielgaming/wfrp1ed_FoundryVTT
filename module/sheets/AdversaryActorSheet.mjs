const { ActorSheetV2 } = foundry.applications.sheets;
const {
	DialogV2,
	HandlebarsApplicationMixin,
} = foundry.applications.api;

const CHARACTERISTIC_IDS = Object.freeze([
	"m",
	"ws",
	"bs",
	"s",
	"t",
	"w",
	"i",
	"a",
	"dex",
	"ld",
	"int",
	"cl",
	"wp",
	"fel",
]);

const TESTABLE_CHARACTERISTICS = new Set([
	"ws",
	"bs",
	"s",
	"t",
	"i",
	"dex",
	"ld",
	"int",
	"cl",
	"wp",
	"fel",
]);

const ITEM_GROUPS = Object.freeze([
	Object.freeze({ type: "skill", en: "Skills", pl: "Umiejętności" }),
	Object.freeze({ type: "weapon", en: "Weapons", pl: "Broń" }),
	Object.freeze({ type: "armour", en: "Armour", pl: "Pancerz" }),
	Object.freeze({ type: "equipment", en: "Equipment", pl: "Ekwipunek" }),
	Object.freeze({ type: "trait", en: "Traits", pl: "Cechy specjalne" }),
	Object.freeze({ type: "spell", en: "Spells", pl: "Czary" }),
]);

const ALLOWED_ITEM_TYPES = new Set(
	ITEM_GROUPS.map((group) => group.type),
);

/**
 * Native system-owned sheet for NPC and Creature Actors.
 *
 * The sheet deliberately exposes the shared WFRP profile/combat domain only.
 * Character-only Career, Experience, Fate-generation, and Character Creation
 * controls do not belong here.
 */
export class AdversaryActorSheet extends HandlebarsApplicationMixin(
	ActorSheetV2,
) {
	static DEFAULT_OPTIONS = {
		classes: [
			"wfrp1ed",
			"wfrp1ed-parchment-window",
			"sheet",
			"actor",
			"adversary-actor-sheet",
		],

		position: {
			width: 820,
			height: 760,
		},

		tag: "form",

		form: {
			submitOnChange: true,
			closeOnSubmit: false,
		},

		actions: {
			rollCharacteristic:
				AdversaryActorSheet.#onCharacteristicRoll,
			createItem:
				AdversaryActorSheet.#onCreateItem,
			openItem:
				AdversaryActorSheet.#onOpenItem,
			deleteItem:
				AdversaryActorSheet.#onDeleteItem,
		},
	};

	static PARTS = {
		form: {
			template:
				"systems/wfrp1ed/templates/actors/adversary/" +
				"adversary-sheet.hbs",
		},
	};

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const actor = this.document;

		context.system = actor.system;
		context.editable = this.isEditable;
		context.actorTypeLabel = actor.type === "creature"
			? localize("Creature", "Stworzenie")
			: localize("NPC", "BN");
		context.characteristics = prepareCharacteristics(actor);
		context.woundsMaximum = finiteNumber(
			actor.woundsMaximum,
			0,
		);
		context.itemGroups = prepareItemGroups(actor);
		context.labels = labels();

		return context;
	}

	static async #onCharacteristicRoll(event, target) {
		event.preventDefault();

		const id = String(
			target.dataset.characteristic ?? "",
		).trim();

		if (!TESTABLE_CHARACTERISTICS.has(id)) return;

		try {
			await this.document.rollCharacteristic(id);
		} catch (error) {
			console.error(
				`WFRP1ED | Unable to roll adversary characteristic '${id}'.`,
				error,
			);
			ui.notifications.error(
				error?.message ??
					localize(
						"Unable to roll the characteristic.",
						"Nie można wykonać testu cechy.",
					),
			);
		}
	}

	static async #onCreateItem(event, target) {
		event.preventDefault();
		if (!this.isEditable) return;

		const type = String(target.dataset.itemType ?? "").trim();
		if (!ALLOWED_ITEM_TYPES.has(type)) return;

		try {
			const [created] = await this.document.createEmbeddedDocuments(
				"Item",
				[{
					name: newItemName(type),
					type,
				}],
			);

			if (created?.sheet) {
				void created.sheet.render(true);
			}
		} catch (error) {
			console.error(
				`WFRP1ED | Unable to create adversary Item '${type}'.`,
				error,
			);
			ui.notifications.error(
				error?.message ??
					localize(
						"Unable to create the Item.",
						"Nie można utworzyć elementu.",
					),
			);
		}
	}

	static async #onOpenItem(event, target) {
		event.preventDefault();
		const item = itemFromTarget(this.document, target);
		if (!item?.sheet) return;
		void item.sheet.render(true);
	}

	static async #onDeleteItem(event, target) {
		event.preventDefault();
		if (!this.isEditable) return;

		const item = itemFromTarget(this.document, target);
		if (!item) return;

		const confirmed = await DialogV2.confirm({
			window: {
				title: localize("Delete Item", "Usuń element"),
			},
			content:
				`<p>${localize(
					"Delete",
					"Usunąć",
				)} <strong>${foundry.utils.escapeHTML(item.name)}</strong>?</p>`,
			modal: true,
		});

		if (!confirmed) return;
		await item.delete();
	}
}

function prepareCharacteristics(actor) {
	const characteristics = actor.system?.characteristics ?? {};

	return CHARACTERISTIC_IDS.map((id) => {
		const characteristic = characteristics[id];
		const localizationId = id === "m" ? "sp" : id;

		return {
			id,
			label: game.i18n.localize(
				characteristic?.label ??
					`WFRP1ed.CHAR.${localizationId}`,
			),
			abbreviation: game.i18n.localize(
				characteristic?.abrev ??
					`WFRP1ed.CHARAbbrev.${localizationId}`,
			),
			value: finiteNumber(
				characteristic?.current ?? characteristic?.initial,
				0,
			),
			initial: finiteNumber(characteristic?.initial, 0),
			rollable: TESTABLE_CHARACTERISTICS.has(id),
		};
	});
}

function prepareItemGroups(actor) {
	const items = Array.from(actor.items ?? []);

	return ITEM_GROUPS.map((group) => ({
		type: group.type,
		label: localize(group.en, group.pl),
		items: items
			.filter((item) => item.type === group.type)
			.map((item) => ({
				id: item.id,
				name: item.name,
				img: item.img,
				type: item.type,
			})),
	}));
}

function itemFromTarget(actor, target) {
	const id = String(
		target.closest?.("[data-item-id]")?.dataset.itemId ??
			target.dataset.itemId ??
			"",
	).trim();

	return id ? actor.items.get(id) : null;
}

function newItemName(type) {
	const names = {
		skill: ["New Skill", "Nowa umiejętność"],
		weapon: ["New Weapon", "Nowa broń"],
		armour: ["New Armour", "Nowy pancerz"],
		equipment: ["New Equipment", "Nowy ekwipunek"],
		trait: ["New Trait", "Nowa cecha specjalna"],
		spell: ["New Spell", "Nowy czar"],
	};

	const [english, polish] = names[type] ?? ["New Item", "Nowy element"];
	return localize(english, polish);
}

function labels() {
	return {
		profile: localize("Profile", "Profil"),
		species: localize("Species / Type", "Gatunek / Typ"),
		wounds: localize("Wounds", "Żywotność"),
		magicPoints: localize("Magic Points", "Punkty Magii"),
		powerLevel: localize("Power Level", "Poziom Mocy"),
		insanity: localize("Insanity Points", "Punkty Obłędu"),
		armourPoints: localize("Armour Points", "Punkty Pancerza"),
		head: localize("Head", "Głowa"),
		rightArm: localize("Right Arm", "Prawa ręka"),
		leftArm: localize("Left Arm", "Lewa ręka"),
		body: localize("Body", "Korpus"),
		rightLeg: localize("Right Leg", "Prawa noga"),
		leftLeg: localize("Left Leg", "Lewa noga"),
		description: localize("Description", "Opis"),
		notes: localize("GM Notes", "Notatki MG"),
		add: localize("Add", "Dodaj"),
		open: localize("Open", "Otwórz"),
		remove: localize("Remove", "Usuń"),
	};
}

function finiteNumber(value, fallback) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : fallback;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
