import { ExperienceLedgerService } from "./ExperienceLedgerService.mjs";
import { ExperienceTransactionService } from "./ExperienceTransactionService.mjs";

const {
	ApplicationV2,
	DialogV2,
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
		actions: {
			addAdjustment: this.#addAdjustment,
			editAdjustment: this.#editAdjustment,
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

	get canEdit() {
		return game.user?.isGM === true;
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
			.map((entry) => transactionPresentation(this.actor, entry, this.canEdit));

		context.actor = {
			id: this.actor.id,
			uuid: this.actor.uuid,
			name: this.actor.name,
		};
		context.canEdit = this.canEdit;
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
			add: localize("Add XP entry", "Dodaj wpis PD"),
			edit: localize("Edit description", "Edytuj opis"),
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

	/** @this {ExperienceLogWindow} */
	static async #addAdjustment(event) {
		event.preventDefault();
		if (!this.canEdit) return;

		const result = await adjustmentDialog({
			title: localize("Add Experience entry", "Dodaj wpis Punktów Doświadczenia"),
			amount: 0,
			description: "",
			allowAmount: true,
		});
		if (!result) return;

		try {
			await ExperienceLedgerService.addAdjustment(this.actor, result);
		} catch (error) {
			console.error("WFRP1ED | Unable to add Experience ledger entry.", error);
			ui.notifications.error(error?.message ?? String(error));
		}
	}

	/** @this {ExperienceLogWindow} */
	static async #editAdjustment(event, target) {
		event.preventDefault();
		if (!this.canEdit) return;

		const eventId = String(target?.dataset?.eventId ?? "").trim();
		const source = manualEvent(this.actor, eventId);
		if (!source) {
			ui.notifications.error(localize(
				"This editable Experience entry no longer exists.",
				"Ten edytowalny wpis Punktów Doświadczenia już nie istnieje.",
			));
			return;
		}

		const result = await adjustmentDialog({
			title: localize("Edit Experience entry", "Edytuj wpis Punktów Doświadczenia"),
			amount: integer(source.amount),
			description: String(source.description ?? ""),
			allowAmount: false,
		});
		if (!result) return;

		try {
			await ExperienceLedgerService.editAdjustmentDescription(
				this.actor,
				eventId,
				result.description,
			);
		} catch (error) {
			console.error("WFRP1ED | Unable to edit Experience ledger entry.", error);
			ui.notifications.error(error?.message ?? String(error));
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

async function adjustmentDialog({ title, amount, description, allowAmount }) {
	const amountControl = allowAmount
		? `<input type="number" name="amount" step="1" value="${integer(amount)}" required>`
		: `<input type="number" value="${integer(amount)}" disabled>`;
	const content = `
		<div class="experience-ledger-dialog">
			<label>${escapeHtml(localize("Amount", "Wartość"))}
				${amountControl}
			</label>
			<p class="hint">${escapeHtml(localize(
				"Use a positive value for an award and a negative value for a correction. Historical purchase costs cannot be edited here.",
				"Wpisz wartość dodatnią dla nagrody albo ujemną dla korekty. Kosztów historycznych zakupów nie można tutaj edytować.",
			))}</p>
			<label>${escapeHtml(localize("Description", "Opis"))}
				<input type="text" name="description" value="${escapeHtml(description)}" autocomplete="off" required>
			</label>
		</div>
	`;

	return DialogV2.wait({
		window: { title },
		content,
		modal: true,
		rejectClose: false,
		buttons: [{
			action: "save",
			label: localize("Save", "Zapisz"),
			default: true,
			callback: (_event, button) => {
				const data = new FormData(button.form);
				return {
					amount: allowAmount ? integer(data.get("amount")) : integer(amount),
					description: String(data.get("description") ?? "").trim(),
				};
			},
		}],
	});
}

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

function transactionPresentation(actor, entry, canEdit) {
	const events = Array.isArray(entry?.events) ? entry.events : [];
	return {
		id: String(entry?.id ?? ""),
		kind: String(entry?.kind ?? ""),
		date: formatDate(entry?.committedAt ?? entry?.createdAt),
		events: events.map((event) => eventPresentation(actor, entry, event, canEdit)),
	};
}

function eventPresentation(actor, entry, event, canEdit) {
	const kind = String(event?.kind ?? "");
	const manual = entry?.kind === "manual-experience" && kind === "experience-adjustment";
	const signedAmount = manual ? integer(event?.amount) : -nonNegativeInteger(event?.cost);
	return {
		id: String(event?.id ?? ""),
		kind,
		label: manual ? String(event?.description ?? "").trim() : eventLabel(actor, event),
		amount: signedAmount > 0 ? `+${signedAmount}` : String(signedAmount),
		positive: signedAmount > 0,
		negative: signedAmount < 0,
		editable: canEdit && manual,
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

function manualEvent(actor, eventId) {
	for (const entry of ExperienceTransactionService.ledger(actor)) {
		if (entry?.kind !== "manual-experience") continue;
		for (const event of entry?.events ?? []) {
			if (
				event?.kind === "experience-adjustment" &&
				String(event?.id ?? "") === String(eventId ?? "")
			) return event;
		}
	}
	return null;
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

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function integer(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function nonNegativeInteger(value) {
	return Math.max(0, integer(value));
}

function isCharacter(document) {
	return Boolean(document?.documentName === "Actor" && document?.type === "character");
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
