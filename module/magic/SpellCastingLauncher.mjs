import { SpellProcedureRegistry } from "./SpellProcedureRegistry.mjs";

/** User-facing dispatch from an embedded Spell row to its audited procedure. */
export class SpellCastingLauncher {
	static async launch(actor, spell) {
		if (spell?.type !== "spell" || spell.parent?.uuid !== actor?.uuid) {
			throw new Error(localize(
				"The selected Spell is not owned by this Actor.",
				"Wybrany Czar nie należy do tego Aktora.",
			));
		}
		if (!actor.isOwner && !game.user?.isGM) {
			throw new Error(localize(
				"You do not have permission to cast this Actor's Spell.",
				"Nie masz uprawnień do rzucania Czaru tego Aktora.",
			));
		}

		assertCastingTurn(actor);

		const procedure = SpellProcedureRegistry.get(spell.system?.rulesId);
		if (!procedure) {
			throw new Error(localize(
				"Open the Spell with a double-click and choose its Rules link before casting.",
				"Otwórz Czar dwuklikiem i przed rzuceniem wybierz jego Powiązanie z zasadami.",
			));
		}

		return procedure.execute(actor, spell);
	}
}

/**
 * Casting is unrestricted outside an active combat. Once combat has started,
 * however, a Spell is a turn action and may only be launched for the Actor whose
 * Combatant currently owns the turn. This guard lives in the generic launcher,
 * not in Fire Ball, so every implemented Spell procedure inherits the same
 * combat-turn contract.
 */
function assertCastingTurn(actor) {
	const combat = game.combat;
	if (!combat?.started) return;

	const current = combat.combatant;
	if (current && combatantBelongsToActor(current, actor)) return;

	const currentName = String(current?.name ?? current?.actor?.name ?? "").trim();
	throw new Error(currentName
		? localize(
			`It is ${currentName}'s turn. ${actor.name} cannot cast a Spell now.`,
			`Trwa tura postaci ${currentName}. ${actor.name} nie może teraz rzucić Czaru.`,
		)
		: localize(
			`${actor.name} cannot cast a Spell because no Combatant currently has the turn.`,
			`${actor.name} nie może rzucić Czaru, ponieważ żaden uczestnik walki nie ma obecnie tury.`,
		));
}

function combatantBelongsToActor(combatant, actor) {
	if (!combatant || !actor) return false;

	const actorId = String(actor.id ?? "");
	const combatantActorId = String(combatant.actorId ?? combatant.actor?.id ?? "");
	if (actorId && combatantActorId && actorId === combatantActorId) return true;

	/* Synthetic/token Actors do not always share the base Actor id, so keep the
	 * Document UUID comparison as the authoritative fallback. */
	const actorUuid = String(actor.uuid ?? "");
	const combatantActorUuid = String(combatant.actor?.uuid ?? "");
	return Boolean(actorUuid && combatantActorUuid && actorUuid === combatantActorUuid);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
