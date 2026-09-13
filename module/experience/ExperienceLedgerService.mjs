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

		const entry = manualEntry({
			kind: "experience-adjustment",
			amount: signedAmount,
			description: label,
		});
		const ledger = ExperienceTransactionService.ledger(actor);
		ledger.push(entry);

		await actor.update({
			"system.experience.totalAwarded": nextTotal,
			[`flags.${FLAG_SCOPE}.${LEDGER_FLAG}`]: ledger,
		});
		return foundry.utils.deepClone(entry);
	}

	/**
	 * Audit a direct GM edit of the Total field. This is mechanically the same
	 * signed change to totalAwarded as addAdjustment, but the generated label
	 * records that the compact sheet field itself was used as a correction.
	 */
	static async setTotal(actor, nextValue) {
		assertCharacter(actor);
		assertGameMaster();

		const experience = actor.system?.experience ?? {};
		const previous = nonNegativeInteger(experience.totalAwarded);
		const spent = nonNegativeInteger(experience.spent);
		const next = nonNegativeInteger(nextValue);
		if (next < spent) {
			throw new Error(localize(
				`Total Experience cannot be lower than already spent Experience (${spent}).`,
				`Całkowite Punkty Doświadczenia nie mogą być niższe od już wydanych (${spent}).`,
			));
		}
		if (next === previous) return null;

		const delta = next - previous;
		const entry = manualEntry({
			kind: "experience-adjustment",
			amount: delta,
			description: localize(
				`GM Total XP correction: ${previous} → ${next}`,
				`Korekta MG Całkowitych PD: ${previous} → ${next}`,
			),
			source: "sheet-total",
		});
		const ledger = ExperienceTransactionService.ledger(actor);
		ledger.push(entry);

		await actor.update({
			"system.experience.totalAwarded": next,
			[`flags.${FLAG_SCOPE}.${LEDGER_FLAG}`]: ledger,
		});
		return foundry.utils.deepClone(entry);
	}

	/**
	 * Audit a direct GM edit of Current XP without pretending that XP was newly
	 * awarded. Current = Total - Spent, so this changes spent while Total remains
	 * fixed. The signed event amount describes the visible Current-XP delta.
	 */
	static async setCurrent(actor, nextValue) {
		assertCharacter(actor);
		assertGameMaster();

		const experience = actor.system?.experience ?? {};
		const total = nonNegativeInteger(experience.totalAwarded);
		const previousSpent = nonNegativeInteger(experience.spent);
		const previous = Math.max(0, total - previousSpent);
		const next = nonNegativeInteger(nextValue);
		if (next > total) {
			throw new Error(localize(
				"Current Experience cannot exceed Total Experience.",
				"Aktualne Punkty Doświadczenia nie mogą przekraczać Całkowitych Punktów Doświadczenia.",
			));
		}
		if (next === previous) return null;

		const nextSpent = total - next;
		const delta = next - previous;
		const entry = manualEntry({
			kind: "experience-balance-adjustment",
			amount: delta,
			description: localize(
				`GM Current XP correction: ${previous} → ${next}`,
				`Korekta MG Aktualnych PD: ${previous} → ${next}`,
			),
			source: "sheet-current",
		});
		const ledger = ExperienceTransactionService.ledger(actor);
		ledger.push(entry);

		await actor.update({
			"system.experience.spent": nextSpent,
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

function manualEntry({ kind, amount, description, source = "manual-log" }) {
	const now = Date.now();
	const event = {
		id: foundry.utils.randomID(),
		kind,
		state: "committed",
		amount: integer(amount),
		description: String(description ?? "").trim(),
		source,
		createdAt: now,
		userId: String(game.user?.id ?? ""),
	};
	return {
		id: foundry.utils.randomID(),
		kind: "manual-experience",
		createdAt: now,
		committedAt: now,
		userId: String(game.user?.id ?? ""),
		events: [event],
	};
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
