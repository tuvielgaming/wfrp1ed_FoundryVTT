import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";

/** Shared ownership/automation rules for rolls which belong to one Actor. */
export class ActorRollPolicy {
	static hasOwnerPermission(actor, user = game.user) {
		if (!(actor instanceof foundry.documents.Actor) || !user) return false;
		if (user.isGM) return true;
		return actor.testUserPermission?.(
			user,
			CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
		) === true;
	}

	static canAdjudicate(actor, user = game.user) {
		return this.hasOwnerPermission(actor, user);
	}

	static ownedByPlayer(actor) {
		if (!(actor instanceof foundry.documents.Actor)) return false;
		return [...(game.users ?? [])].some((user) =>
			!user?.isGM && this.hasOwnerPermission(actor, user),
		);
	}

	/**
	 * Existing combat/damage automation boundary. Keep the transient damage
	 * reconciliation suspension here so an adjudication never starts a new damage
	 * generation while the previous result is being repaired.
	 */
	static shouldAutomaticallyRoll(actor, user = game.user) {
		return this.#canAutomaticallyRoll(actor, user) &&
			WfrpRuleSettings.autoRollDamageForGmActors();
	}

	/**
	 * Dependent mechanic Test/check automation uses the same World preference but
	 * is intentionally independent of the transient damage-only suspension.
	 * Every caller must still create its ordinary editable/auditable ChatMessage.
	 */
	static shouldAutomaticallyRollMechanicTest(actor, user = game.user) {
		return this.#canAutomaticallyRoll(actor, user) &&
			WfrpRuleSettings.autoRollMechanicTestsForGmActors();
	}

	static primaryActiveGM() {
		return [...(game.users ?? [])]
			.filter((user) => user?.active && user?.isGM)
			.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
	}

	static isPrimaryActiveGM() {
		return Boolean(
			game.user?.isGM &&
			String(this.primaryActiveGM()?.id ?? "") === String(game.user.id),
		);
	}

	static actorFromUuidSync(uuid) {
		try {
			const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
			if (document instanceof foundry.documents.Actor) return document;
			if (document?.actor instanceof foundry.documents.Actor) return document.actor;
		} catch (_error) {
			return null;
		}
		return null;
	}

	static #canAutomaticallyRoll(actor, user) {
		if (!(actor instanceof foundry.documents.Actor) || !user) return false;
		if (this.ownedByPlayer(actor)) return false;
		return Boolean(user.isGM && this.isPrimaryActiveGM());
	}
}
