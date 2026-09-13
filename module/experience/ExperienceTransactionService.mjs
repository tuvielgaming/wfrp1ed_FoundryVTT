import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";

const FLAG_SCOPE = "wfrp1ed";
const TRANSACTION_FLAG = "experienceTransaction";
const LEDGER_FLAG = "experienceLedger";
const VERSION = 1;

const sessions = new Map();
const applicationSessions = new WeakMap();

Hooks.on("renderApplicationV2", (application) => {
	if (!(application instanceof ClassicActorSheet)) return;
	const actor = application.document;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;
	if (applicationSessions.has(application)) return;

	const session = {
		id: foundry.utils.randomID(),
		actorUuid: String(actor.uuid ?? ""),
		userId: String(game.user?.id ?? ""),
		openedAt: Date.now(),
	};
	applicationSessions.set(application, session);
	sessions.set(sessionKey(actor, session.userId), session);

	void recoverStaleTransaction(actor, session).catch(reportRecoveryError);
});

Hooks.on("closeApplicationV2", (application) => {
	if (!(application instanceof ClassicActorSheet)) return;
	const actor = application.document;
	if (actor?.documentName !== "Actor" || actor.type !== "character") return;

	const session = applicationSessions.get(application);
	if (!session) return;
	applicationSessions.delete(application);
	if (sessions.get(sessionKey(actor, session.userId))?.id === session.id) {
		sessions.delete(sessionKey(actor, session.userId));
	}
	void ExperienceTransactionService.commit(actor, session.id).catch(reportCommitError);
});

export class ExperienceTransactionService {
	static current(actor) {
		const value = actor?.getFlag?.(FLAG_SCOPE, TRANSACTION_FLAG);
		return isObject(value) ? foundry.utils.deepClone(value) : null;
	}

	static ledger(actor) {
		const value = actor?.getFlag?.(FLAG_SCOPE, LEDGER_FLAG);
		return Array.isArray(value) ? foundry.utils.deepClone(value) : [];
	}

	static activeEvents(actor, kind = "") {
		const transaction = this.current(actor);
		if (transaction?.state !== "open") return [];
		return cloneArray(transaction.events).filter((event) =>
			event?.state === "applied" && (!kind || event.kind === kind),
		);
	}

	static async prepareCharacteristicAdvance(actor, data) {
		assertCharacter(actor);
		const transaction = await ensureOpenTransaction(actor);
		const event = {
			id: foundry.utils.randomID(),
			kind: "characteristic-advance",
			state: "prepared",
			characteristic: String(data.characteristic ?? ""),
			storageKey: String(data.storageKey ?? ""),
			cost: nonNegativeInteger(data.cost),
			purchasedBefore: nonNegativeInteger(data.purchasedBefore),
			purchasedAfter: nonNegativeInteger(data.purchasedAfter),
			spentBefore: nonNegativeInteger(data.spentBefore),
			spentAfter: nonNegativeInteger(data.spentAfter),
			createdAt: Date.now(),
		};
		transaction.events.push(event);
		await actor.update({ [`flags.${FLAG_SCOPE}.${TRANSACTION_FLAG}`]: transaction });
		return foundry.utils.deepClone(event);
	}

	static async markCharacteristicApplied(actor, eventId, legacyTransaction) {
		const transaction = requireOpenTransaction(actor);
		const event = findEvent(transaction, eventId);
		if (!event || event.kind !== "characteristic-advance") return null;
		event.state = "applied";
		event.appliedAt = Date.now();
		if (isObject(legacyTransaction)) {
			event.legacyTransaction = foundry.utils.deepClone(legacyTransaction);
		}
		await actor.update({ [`flags.${FLAG_SCOPE}.${TRANSACTION_FLAG}`]: transaction });
		return foundry.utils.deepClone(event);
	}

	static async cancelPreparedEvent(actor, eventId) {
		const transaction = this.current(actor);
		if (transaction?.state !== "open") return;
		transaction.events = cloneArray(transaction.events).filter((event) => event?.id !== eventId);
		if (!transaction.events.length) {
			await actor.unsetFlag(FLAG_SCOPE, TRANSACTION_FLAG);
			return;
		}
		await actor.update({ [`flags.${FLAG_SCOPE}.${TRANSACTION_FLAG}`]: transaction });
	}

	static async undoCharacteristicAdvance(actor, characteristicId) {
		assertCharacter(actor);
		const transaction = requireOpenTransaction(actor);
		const canonical = String(characteristicId ?? "").trim().toLowerCase() === "sp"
			? "m"
			: String(characteristicId ?? "").trim().toLowerCase();
		const events = cloneArray(transaction.events);
		let eventIndex = -1;
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const candidate = events[index];
			if (
				candidate?.kind === "characteristic-advance" &&
				candidate?.state === "applied" &&
				String(candidate.characteristic ?? "") === canonical
			) {
				eventIndex = index;
				break;
			}
		}
		if (eventIndex < 0) {
			throw new Error(localize(
				"There is no refundable purchase for this characteristic in the current Experience transaction.",
				"W bieżącej transakcji PD nie ma zakupu tej cechy możliwego do cofnięcia.",
			));
		}

		const event = events[eventIndex];
		const storageKey = String(event.storageKey ?? "");
		const characteristic = actor.system?.characteristics?.[storageKey];
		const currentPurchased = nonNegativeInteger(characteristic?.purchased);
		if (currentPurchased <= 0) {
			throw new Error(localize(
				"This characteristic has no purchased advance to refund.",
				"Ta cecha nie ma wykupionego rozwinięcia do zwrotu.",
			));
		}
		const currentSpent = nonNegativeInteger(actor.system?.experience?.spent);
		if (currentSpent < nonNegativeInteger(event.cost)) {
			throw new Error(localize(
				"Experience data no longer permits this refund.",
				"Stan Punktów Doświadczenia nie pozwala już na ten zwrot.",
			));
		}

		events[eventIndex] = {
			...event,
			state: "reverted",
			revertedAt: Date.now(),
			revertedBy: String(game.user?.id ?? ""),
		};
		transaction.events = events;

		const previous = [...events].reverse().find((candidate) =>
			candidate?.kind === "characteristic-advance" && candidate?.state === "applied" && isObject(candidate?.legacyTransaction),
		)?.legacyTransaction ?? null;

		await actor.update({
			[`system.characteristics.${storageKey}.purchased`]: currentPurchased - 1,
			"system.experience.spent": currentSpent - nonNegativeInteger(event.cost),
			[`flags.${FLAG_SCOPE}.${TRANSACTION_FLAG}`]: transaction,
			[`flags.${FLAG_SCOPE}.lastCharacteristicAdvance`]: previous,
		});
		return foundry.utils.deepClone(events[eventIndex]);
	}

	static async commit(actor, sheetSessionId = "") {
		const transaction = this.current(actor);
		if (transaction?.state !== "open") return null;
		if (sheetSessionId && String(transaction.sheetSessionId ?? "") !== String(sheetSessionId)) return null;

		const committedEvents = cloneArray(transaction.events).filter((event) => event?.state === "applied");
		const ledger = this.ledger(actor);
		const alreadyCommitted = ledger.some((entry) => entry?.transactionId === transaction.id);
		if (!alreadyCommitted && committedEvents.length) {
			ledger.push({
				id: foundry.utils.randomID(),
				transactionId: transaction.id,
				kind: "progression-transaction",
				createdAt: transaction.openedAt,
				committedAt: Date.now(),
				userId: transaction.userId,
				events: committedEvents.map((event) => ({ ...event, state: "committed" })),
			});
		}

		await actor.update({
			[`flags.${FLAG_SCOPE}.${LEDGER_FLAG}`]: ledger,
			[`flags.${FLAG_SCOPE}.${TRANSACTION_FLAG}`]: {
				...transaction,
				state: "committed",
				committedAt: Date.now(),
			},
		});
		await actor.unsetFlag(FLAG_SCOPE, TRANSACTION_FLAG);
		return { ...transaction, state: "committed" };
	}

	static async rollbackOpen(actor, transaction = null, reason = "recovery") {
		const current = transaction ?? this.current(actor);
		if (current?.state !== "open") return null;

		const update = {};
		const baselines = new Map();
		for (const event of cloneArray(current.events)) {
			if (event?.kind !== "characteristic-advance") continue;
			const storageKey = String(event.storageKey ?? "");
			if (!storageKey || baselines.has(storageKey)) continue;
			baselines.set(storageKey, nonNegativeInteger(event.purchasedBefore));
		}
		for (const [storageKey, purchased] of baselines) {
			update[`system.characteristics.${storageKey}.purchased`] = purchased;
		}
		update["system.experience.spent"] = nonNegativeInteger(current.spentBefore);
		update[`flags.${FLAG_SCOPE}.${TRANSACTION_FLAG}`] = {
			...current,
			state: "rolled-back",
			rolledBackAt: Date.now(),
			rollbackReason: reason,
		};
		update[`flags.${FLAG_SCOPE}.lastCharacteristicAdvance`] = null;
		await actor.update(update);
		await actor.unsetFlag(FLAG_SCOPE, TRANSACTION_FLAG);
		return { ...current, state: "rolled-back" };
	}
}

async function ensureOpenTransaction(actor) {
	const session = currentSession(actor);
	if (!session) {
		throw new Error(localize(
			"Open the Character Sheet before purchasing advances.",
			"Przed zakupem rozwinięć otwórz Kartę Postaci.",
		));
	}

	let transaction = ExperienceTransactionService.current(actor);
	if (transaction?.state === "open" && String(transaction.sheetSessionId ?? "") !== session.id) {
		await ExperienceTransactionService.rollbackOpen(actor, transaction, "stale-sheet-session");
		transaction = null;
	}
	if (transaction?.state === "open") return transaction;

	return {
		version: VERSION,
		id: foundry.utils.randomID(),
		state: "open",
		actorUuid: String(actor.uuid ?? ""),
		userId: session.userId,
		sheetSessionId: session.id,
		openedAt: Date.now(),
		spentBefore: nonNegativeInteger(actor.system?.experience?.spent),
		events: [],
	};
}

function requireOpenTransaction(actor) {
	const transaction = ExperienceTransactionService.current(actor);
	if (transaction?.state !== "open") {
		throw new Error(localize(
			"There is no open Experience transaction on this Character Sheet.",
			"Na tej Karcie Postaci nie ma otwartej transakcji Punktów Doświadczenia.",
		));
	}
	const session = currentSession(actor);
	if (!session || String(transaction.sheetSessionId ?? "") !== session.id) {
		throw new Error(localize(
			"The Experience transaction belongs to another or previous Character Sheet session.",
			"Transakcja Punktów Doświadczenia należy do innej lub poprzedniej sesji Karty Postaci.",
		));
	}
	return transaction;
}

async function recoverStaleTransaction(actor, session) {
	const transaction = ExperienceTransactionService.current(actor);
	if (transaction?.state !== "open") return;
	if (String(transaction.userId ?? "") !== session.userId) return;
	if (String(transaction.sheetSessionId ?? "") === session.id) return;
	await ExperienceTransactionService.rollbackOpen(actor, transaction, "character-sheet-reopened");
	ui.notifications.warn(localize(
		"An unfinished Experience transaction from the previous Character Sheet session was rolled back to preserve character integrity.",
		"Niedokończona transakcja Punktów Doświadczenia z poprzedniej sesji Karty Postaci została cofnięta, aby zachować spójność postaci.",
	));
}

function currentSession(actor) {
	return sessions.get(sessionKey(actor, String(game.user?.id ?? ""))) ?? null;
}

function findEvent(transaction, eventId) {
	return transaction.events?.find((event) => String(event?.id ?? "") === String(eventId ?? "")) ?? null;
}

function sessionKey(actor, userId) {
	return `${String(actor?.uuid ?? actor?.id ?? "")}:${String(userId ?? "")}`;
}

function assertCharacter(actor) {
	if (actor?.documentName !== "Actor" || actor.type !== "character") {
		throw new Error("Experience transactions require a Character Actor.");
	}
}

function cloneArray(value) {
	return Array.isArray(value) ? foundry.utils.deepClone(value) : [];
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function isObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

function reportRecoveryError(error) {
	console.error("WFRP1ED | Unable to recover stale Experience transaction.", error);
	ui.notifications.error(error?.message ?? String(error));
}

function reportCommitError(error) {
	console.error("WFRP1ED | Unable to commit Experience transaction.", error);
	ui.notifications.error(error?.message ?? String(error));
}
