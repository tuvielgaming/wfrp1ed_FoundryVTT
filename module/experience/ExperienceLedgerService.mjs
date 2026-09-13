import { ExperienceTransactionService } from "./ExperienceTransactionService.mjs";

const FLAG_SCOPE = "wfrp1ed";
const LEDGER_FLAG = "experienceLedger";

/**
 * Manual Experience accounting which is deliberately separate from progression
 * transactions. Progression purchases stay mechanically derived/protected;
 * GM awards and corrections are explicit signed ledger entries.
 */
export class ExperienceLedgerService {
	static async addAdjustment(actor, { amount, description } = {}) {
		assertCharacter(actor);
		assertGameMaster();

		const signedAmount = integer(amount);
		if (signedAmount === 0) {
			throw new Error(localize(
				"Experience adjustment must be non-zero.",
				"Korekta Punktów Doświadczenia musi być różna od zera.",
			));
		}

		const label = String(description ?? "").trim();
		if (!label) {
			throw new Error(localize(
				"Enter a description for this Experience entry.",
				"Wpisz opis tego wpisu Punktów Doświadczenia.",
			));
		}

		const experience = actor.system?.experience ?? {};
		const currentTotal = nonNegativeInteger(experience.totalAwarded);
		const spent = nonNegativeInteger(experience.spent);
		const nextTotal = currentTotal + signedAmount;
		if (nextTotal < 0 || nextTotal < spent) {
			throw new Error(localize(
				`This correction would reduce Total Experience below already spent Experience (${spent}).`,
				`Ta korekta obniżyłaby Całkowite Punkty Doświadczenia poniżej już wydanych (${spent}).`,
			));
		}

		const now = Date.now();
		const ledger = ExperienceTransactionService.ledger(actor);
		const event = {
			id: foundry.utils.randomID(),
			kind: "experience-adjustment",
			state: "committed",
			amount: signedAmount,
			description: label,
			createdAt: now,
			userId: String(game.user?.id ?? ""),
		};
		const entry = {
			id: foundry.utils.randomID(),
			kind: "manual-experience",
			createdAt: now,
			committedAt: now,
			userId: String(game.user?.id ?? ""),
			events: [event],
		};
		ledger.push(entry);

		await actor.update({
			"system.experience.totalAwarded": nextTotal,
			[`flags.${FLAG_SCOPE}.${LEDGER_FLAG}`]: ledger,
		});
		return foundry.utils.deepClone(entry);
	}

	static async editAdjustmentDescription(actor, eventId, description) {
		assertCharacter(actor);
		assertGameMaster();

		const label = String(description ?? "").trim();
		if (!label) {
			throw new Error(localize(
				"Experience entry description cannot be empty.",
				"Opis wpisu Punktów Doświadczenia nie może być pusty.",
			));
		}

		const ledger = ExperienceTransactionService.ledger(actor);
		let found = false;
		for (const entry of ledger) {
			if (entry?.kind !== "manual-experience" || !Array.isArray(entry.events)) continue;
			for (const event of entry.events) {
				if (
					event?.kind !== "experience-adjustment" ||
					String(event?.id ?? "") !== String(eventId ?? "")
				) continue;
				event.description = label;
				event.editedAt = Date.now();
				event.editedBy = String(game.user?.id ?? "");
				found = true;
				break;
			}
			if (found) break;
		}
		if (!found) {
			throw new Error(localize(
				"This editable Experience entry no longer exists.",
				"Ten edytowalny wpis Punktów Doświadczenia już nie istnieje.",
			));
		}

		await actor.update({ [`flags.${FLAG_SCOPE}.${LEDGER_FLAG}`]: ledger });
	}
}

function assertGameMaster() {
	if (game.user?.isGM === true) return;
	throw new Error(localize(
		"Only the GM can add or edit manual Experience entries.",
		"Tylko MG może dodawać lub edytować ręczne wpisy Punktów Doświadczenia.",
	));
}

function assertCharacter(actor) {
	if (actor?.documentName === "Actor" && actor.type === "character") return;
	throw new Error("Experience ledger operations require a Character Actor.");
}

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	return Math.max(0, integer(value));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
