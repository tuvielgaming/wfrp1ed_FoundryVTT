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
 * A characteristic purchase may be undone only while the same Character
 * Sheet instance in which it was bought remains open. ApplicationV2 rerenders
 * do not end that session; closing the sheet does.
 *
 * The Actor still owns the authoritative purchase/refund transaction. This
 * integration adds only the UI-session boundary around that existing contract.
 */
const sessions = new Map();
const initializedApplications = new WeakSet();

const originalUndo = Wfrp1edActor.prototype.undoLastCharacteristicAdvance;

Wfrp1edActor.prototype.undoLastCharacteristicAdvance = async function sheetScopedUndo(
	characteristicId,
) {
	const session = currentSession(this);
	const transaction = this.getFlag(FLAG_SCOPE, FLAG_KEY);

	if (!session || !transactionBelongsToSession(transaction, session)) {
		throw new Error(localize(
			"The refundable advancement transaction belongs to a previous Character Sheet session. Reopenings commit earlier purchases.",
			"Transakcja zwrotu rozwinięcia należy do poprzedniej sesji Karty Postaci. Zamknięcie karty zatwierdza wcześniejsze zakupy.",
		));
	}

	return originalUndo.call(this, characteristicId);
};

Hooks.on("renderApplicationV2", (application) => {
	if (!(application instanceof ClassicActorSheet)) return;
	if (application.document?.type !== "character") return;
	if (initializedApplications.has(application)) return;

	initializedApplications.add(application);
	const actor = application.document;
	const session = Object.freeze({
		id: foundry.utils.randomID(),
		actorUuid: String(actor.uuid ?? ""),
		userId: String(game.user?.id ?? ""),
		openedAt: Date.now(),
	});

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
		const transaction = actor.getFlag(FLAG_SCOPE, FLAG_KEY);
		if (!transactionBelongsToSession(transaction, session)) return;

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
