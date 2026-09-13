import { Wfrp1edActor } from "../documents/Wfrp1edActor.mjs";
import { ExperienceTransactionService } from "../experience/ExperienceTransactionService.mjs";

/*
 * Characteristic advancement transaction bridge
 * ---------------------------------------------
 *
 * The old implementation kept a volatile LIFO stack tied to one rendered
 * Character Sheet. That made only the most recent purchase refundable and left
 * no durable recovery information if the browser disappeared mid-session.
 *
 * The Actor remains authoritative for purchase eligibility and the actual
 * characteristic/Experience mutation. This bridge adds durable transaction
 * intent before that mutation, then marks the event applied afterwards.
 * Shift-click undo is now scoped to the latest purchase of the selected
 * characteristic inside the current open Experience transaction, rather than
 * to the globally latest purchase.
 */
const originalPurchase = Wfrp1edActor.prototype.purchaseCharacteristicAdvance;

Wfrp1edActor.prototype.purchaseCharacteristicAdvance = async function transactionalCharacteristicPurchase(
	characteristicId,
) {
	const state = this.getCharacteristicAdvanceState(characteristicId);
	const spentBefore = nonNegativeInteger(this.system?.experience?.spent);
	const prepared = await ExperienceTransactionService.prepareCharacteristicAdvance(this, {
		characteristic: state.characteristicId,
		storageKey: state.storageKey,
		cost: state.cost,
		purchasedBefore: state.purchased,
		purchasedAfter: state.purchased + 1,
		spentBefore,
		spentAfter: spentBefore + state.cost,
	});

	try {
		const legacyTransaction = await originalPurchase.call(this, characteristicId);
		await ExperienceTransactionService.markCharacteristicApplied(
			this,
			prepared.id,
			legacyTransaction,
		);
		return {
			...legacyTransaction,
			experienceTransactionEventId: prepared.id,
		};
	} catch (error) {
		await ExperienceTransactionService.cancelPreparedEvent(this, prepared.id).catch(() => {});
		throw error;
	}
};

Wfrp1edActor.prototype.undoLastCharacteristicAdvance = async function transactionalCharacteristicUndo(
	characteristicId,
) {
	return ExperienceTransactionService.undoCharacteristicAdvance(this, characteristicId);
};

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}
