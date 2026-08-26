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

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
