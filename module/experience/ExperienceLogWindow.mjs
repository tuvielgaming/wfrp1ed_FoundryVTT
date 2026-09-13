import { ExperienceTransactionService } from "./ExperienceTransactionService.mjs";

const {
	ApplicationV2,
	HandlebarsApplicationMixin,
} = foundry.applications.api;

const FLAG_SCOPE = "wfrp1ed";
const LEDGER_FLAG = "experienceLedger";

export class ExperienceLogWindow extends HandlebarsApplicationMixin(ApplicationV2) {
	static #instances = new Map();

	static DEFAULT_OPTIONS = {
		classes: ["wfrp1ed", "experience-log-window", "wfrp1ed-parchment-window"],
		position: {
			width: 620,
			height: 520,
		},
		window: {
			icon: "fas fa-book-open",
			resizable: true,
		},
	};

	static PARTS = {
		body: {
			template: "systems/wfrp1ed/templates/apps/experience-log-window.hbs",
		},
	};

	constructor(actor, options = {}) {
		if (!isCharacter(actor)) {
			throw new Error("Experience Log requires a Character Actor.");
		}
		const id = options.id ?? `wfrp1ed-experience-log-${safeApplicationId(actor.uuid)}`;
		super({ ...options, id });
		this.actor = actor;
	}

	get title() {
		return `${localize("Experience Log", "Dziennik PD")} — ${this.actor.name}`;
	}

	static async open(actor) {
		if (!isCharacter(actor)) {
			throw new Error("Experience Log requires a Character Actor.");
		}
		let application = this.#instances.get(actor.uuid);
		if (!application) {
			application = new ExperienceLogWindow(actor);
			this.#instances.set(actor.uuid, application);
		}
		await application.render({ force: true });
		application.bringToFront();
		return application;
	}

	static async refresh(actor) {
		const application = this.#instances.get(actor?.uuid);
		if (!application?.rendered) return;
		await application.render({ force: true });
	}

	async _prepareContext(options) {
		const context = await super._prepareContext(options);
		const totalAwarded = nonNegativeInteger(this.actor.system?.experience?.totalAwarded);
		const spent = nonNegativeInteger(this.actor.system?.experience?.spent);
		const ledger = ExperienceTransactionService.ledger(this.actor);
		const transactions = [...ledger]
			.reverse()
			.map((entry) => transactionPresentation(this.actor, entry));

		context.actor = {
			id: this.actor.id,
			uuid: this.actor.uuid,
			name: this.actor.name,
		};
		context.summary = {
			current: Math.max(0, totalAwarded - spent),
			total: totalAwarded,
			spent,
		};
		context.transactions = transactions;
		context.hasTransactions = transactions.length > 0;
		context.ui = {
			title: localize("Experience Log", "Dziennik PD"),
			current: localize("Current", "Aktualne"),
			total: localize("Total", "Całkowite"),
			spent: localize("Spent", "Wydane"),
			empty: localize(
				"No committed Experience transactions have been recorded yet.",
				"Nie zapisano jeszcze żadnych zatwierdzonych transakcji Punktów Doświadczenia.",
			),
		};
		return context;
	}

	_onClose(options) {
		super._onClose(options);
		if (ExperienceLogWindow.#instances.get(this.actor.uuid) === this) {
			ExperienceLogWindow.#instances.delete(this.actor.uuid);
		}
	}
}

/* Keep an already-open Experience Log synchronized with its Actor. The window
 * is deliberately refreshed only for changes which can alter its visible
 * summary or committed ledger, rather than on every unrelated Actor update. */
Hooks.on("updateActor", (actor, changes) => {
	if (!isCharacter(actor) || !experienceLogAffected(changes)) return;
	void ExperienceLogWindow.refresh(actor).catch((error) => {
		console.error("WFRP1ED | Unable to refresh Experience Log.", error);
	});
});

function experienceLogAffected(changes) {
	if (!changes || typeof changes !== "object") return false;
	if (foundry.utils.getProperty(changes, "system.experience") !== undefined) return true;
	if (Object.hasOwn(changes, "system.experience")) return true;
	if (Object.keys(changes).some((key) => key.startsWith("system.experience."))) return true;

	const ledgerPath = `flags.${FLAG_SCOPE}.${LEDGER_FLAG}`;
	if (foundry.utils.getProperty(changes, ledgerPath) !== undefined) return true;
	if (Object.hasOwn(changes, ledgerPath)) return true;
	return Object.keys(changes).some((key) => key.startsWith(`${ledgerPath}.`));
}

function transactionPresentation(actor, entry) {
	const events = Array.isArray(entry?.events) ? entry.events : [];
	return {
		id: String(entry?.id ?? ""),
		date: formatDate(entry?.committedAt ?? entry?.createdAt),
		events: events.map((event) => eventPresentation(actor, event)),
	};
}

function eventPresentation(actor, event) {
	const cost = nonNegativeInteger(event?.cost);
	return {
		id: String(event?.id ?? ""),
		kind: String(event?.kind ?? ""),
		label: eventLabel(actor, event),
		amount: cost > 0 ? `−${cost}` : "0",
	};
}

function eventLabel(actor, event) {
	switch (String(event?.kind ?? "")) {
		case "characteristic-advance": {
			const key = normalizeCharacteristic(event?.characteristic || event?.storageKey);
			return localize(
				`${characteristicLabel(key, "en")} advance`,
				`Rozwinięcie ${characteristicLabel(key, "pl")}`,
			);
		}
		case "career-skill": {
			const item = actor.items?.get?.(String(event?.skillItemId ?? ""));
			const name = String(item?.name ?? event?.skillIdentity ?? "").trim();
			return name
				? localize(`Career Skill: ${name}`, `Umiejętność Profesji: ${name}`)
				: localize("Career Skill", "Umiejętność Profesji");
		}
		case "career-transfer": {
			const item = actor.items?.get?.(String(event?.toCareerItemId ?? ""));
			const name = String(item?.name ?? event?.targetCareerName ?? "").trim();
			return name
				? localize(`Career change: ${name}`, `Zmiana Profesji: ${name}`)
				: localize("Career change", "Zmiana Profesji");
		}
		default:
			return localize("Experience transaction", "Transakcja PD");
	}
}

function characteristicLabel(key, language) {
	const labels = {
		ws: ["WS", "WW"],
		bs: ["BS", "US"],
		s: ["S", "S"],
		t: ["T", "Wt"],
		w: ["W", "Żyw"],
		i: ["I", "I"],
		a: ["A", "A"],
		dex: ["Dex", "Zr"],
		ld: ["Ld", "CP"],
		int: ["Int", "Int"],
		cl: ["Cl", "Op"],
		wp: ["WP", "SW"],
		fel: ["Fel", "Ogd"],
		m: ["M", "Sz"],
	};
	const pair = labels[key] ?? [key || "?", key || "?"];
	return language === "pl" ? pair[1] : pair[0];
}

function normalizeCharacteristic(value) {
	const key = String(value ?? "").trim().toLowerCase();
	if (key === "sp") return "m";
	const aliases = {
		ww: "ws",
		us: "bs",
		wt: "t",
		zyw: "w",
		żw: "w",
		zr: "dex",
		cp: "ld",
		op: "cl",
		sw: "wp",
		ogd: "fel",
		sz: "m",
	};
	return aliases[key] ?? key;
}

function formatDate(value) {
	const timestamp = Number(value);
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
	return new Intl.DateTimeFormat(game.i18n.lang || "en", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(timestamp));
}

function safeApplicationId(value) {
	return String(value ?? "actor")
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "") || "actor";
}

function nonNegativeInteger(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function isCharacter(document) {
	return Boolean(document?.documentName === "Actor" && document?.type === "character");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
