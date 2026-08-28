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
	 * Shared automation boundary for rolls belonging to one Actor. Player-owned
	 * Actors always require an explicit owner/GM action. GM-only Actors may
	 * automate only on the primary active GM and only while the World automation
	 * setting allows it. The dependent mechanic must still publish its ordinary
	 * roll/result ChatMessage; this policy decides only whether its action starts
	 * automatically.
	 */
	static shouldAutomaticallyRoll(actor, user = game.user) {
		if (!(actor instanceof foundry.documents.Actor) || !user) return false;
		if (this.ownedByPlayer(actor)) return false;
		return Boolean(
			user.isGM &&
			this.isPrimaryActiveGM() &&
			WfrpRuleSettings.autoRollMechanicTestsForGmActors(),
		);
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
}
