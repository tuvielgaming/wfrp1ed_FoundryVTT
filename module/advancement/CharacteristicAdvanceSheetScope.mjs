import { ClassicActorSheet } from "../sheets/ClassicActorSheet.mjs";
import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FLAG_KEY = "lastCharacteristicAdvance";
const TRANSACTION_KIND = "characteristicAdvance";
const APPLIED_STATE = "applied";
const COMMITTED_STATE = "committed";

/*
 * Advancement refund scope
 * ------------------------
 * Characteristic purchases made while one Character Sheet instance is open
 * form a LIFO undo stack. The most recent purchase can be refunded first; once
 * it is undone, the previous purchase from the same open-sheet session becomes
 * the next eligible refund target. Closing the sheet commits the remaining
 * purchases and discards the in-memory undo stack.
 */
const sessions = new Map();
const initializedApplications = new WeakSet();

const originalPurchase = Wfrp1edActor.prototype.purchaseCharacteristicAdvance;
const originalUndo = Wfrp1edActor.prototype.undoLastCharacteristicAdvance;

Wfrp1edActor.prototype.purchaseCharacteristicAdvance = async function sheetScopedPurchase(
	characteristicId,
) {
	const transaction = await originalPurchase.call(this, characteristicId);
	const session = currentSession(this);

	if (session && transactionBelongsToSession(transaction, session)) {
		session.transactions.push(transaction);
	}

	return transaction;
};

Wfrp1edActor.prototype.undoLastCharacteristicAdvance = async function sheetScopedUndo(
	characteristicId,
) {
	const session = currentSession(this);
	const transaction = session?.transactions?.at(-1) ?? null;

	if (!session || !transaction) {
		throw new Error(localize(
			"There is no refundable advancement purchase in the current Character Sheet session.",
			"W bieżącej sesji Karty Postaci nie ma zakupu rozwinięcia możliwego do zwrotu.",
		));
	}

	if (!transactionBelongsToSession(transaction, session)) {
		throw new Error(localize(
			"The refundable advancement transaction belongs to a previous Character Sheet session.",
			"Transakcja zwrotu rozwinięcia należy do poprzedniej sesji Karty Postaci.",
		));
	}

	/* The Actor undo API validates the transaction stored in the persistent
	 * lastCharacteristicAdvance flag. After a previous refund that flag points
	 * at the undone transaction, so restore the current stack top first. */
	const stored = this.getFlag(FLAG_SCOPE, FLAG_KEY);
	if (stored?.id !== transaction.id || stored?.state !== APPLIED_STATE) {
		await this.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: transaction,
		});
	}

	const undone = await originalUndo.call(this, characteristicId);
	session.transactions.pop();

	/* Re-arm the previous purchase as the next LIFO refund target. The Actor's
	 * current purchased count and spent XP now exactly match that transaction's
	 * post-purchase snapshot, so the existing validation remains authoritative. */
	const previous = session.transactions.at(-1) ?? null;
	if (previous) {
		await this.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: previous,
		});
	}

	return undone;
};

Hooks.on("renderApplicationV2", (application) => {
	if (!(application instanceof ClassicActorSheet)) return;
	if (application.document?.type !== "character") return;
	if (initializedApplications.has(application)) return;

	initializedApplications.add(application);
	const actor = application.document;
	const session = {
		id: foundry.utils.randomID(),
		actorUuid: String(actor.uuid ?? ""),
		userId: String(game.user?.id ?? ""),
		openedAt: Date.now(),
		transactions: [],
	};

	sessions.set(sessionKey(actor, session.userId), session);
});

Hooks.on("closeApplicationV2", (application) => {
	if (!(application instanceof ClassicActorSheet)) return;
	if (application.document?.type !== "character") return;

	const actor = application.document;
	const userId = String(game.user?.id ?? "");
	const key = sessionKey(actor, userId);
	const session = sessions.get(key);
	if (!session) return;

	sessions.delete(key);
	initializedApplications.delete(application);
	void commitOpenTransaction(actor, session);
});

function currentSession(actor) {
	return sessions.get(sessionKey(actor, String(game.user?.id ?? ""))) ?? null;
}

function transactionBelongsToSession(transaction, session) {
	if (!transaction || typeof transaction !== "object") return false;
	if (transaction.kind !== TRANSACTION_KIND) return false;
	if (transaction.state !== APPLIED_STATE) return false;
	if (String(transaction.userId ?? "") !== session.userId) return false;

	const createdAt = Number(transaction.createdAt);
	return Number.isFinite(createdAt) && createdAt >= session.openedAt;
}

async function commitOpenTransaction(actor, session) {
	try {
		const transaction = session.transactions.at(-1) ?? null;
		if (!transaction || !transactionBelongsToSession(transaction, session)) return;

		await actor.update({
			[`flags.${FLAG_SCOPE}.${FLAG_KEY}`]: {
				...transaction,
				state: COMMITTED_STATE,
				committedAt: Date.now(),
				commitReason: "character-sheet-close",
				sheetSessionId: session.id,
			},
		});
	} catch (error) {
		console.error(
			"WFRP1ED | Unable to close Character Sheet advancement transaction.",
			error,
		);
	}
}

function sessionKey(actor, userId) {
	return `${String(actor?.uuid ?? actor?.id ?? "")}:${String(userId ?? "")}`;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
