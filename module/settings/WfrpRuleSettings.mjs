export const SHIELD_PARRY_RULE = Object.freeze({
	FOLLOWING_ATTACKS: "followingAttacks",
	DEFENSIVE_COMMITMENT: "defensiveCommitment",
});

const SHIELD_PARRY_SETTING_KEY = "shieldParryRule";

/**
 * Native Foundry world settings for explicit WFRP 1e rule interpretations.
 *
 * Settings in this module are intentionally world-scoped because they change
 * table mechanics, not an individual client's presentation. The Core/default
 * behavior remains the project baseline; alternative interpretations must be
 * explicitly enabled by the GM.
 */
export class WfrpRuleSettings {
	static register() {
		game.settings.register(game.system.id, SHIELD_PARRY_SETTING_KEY, {
			name: localize(
				"Shield parry attack cost",
				"Koszt Ataków przy parowaniu tarczą",
			),
			hint: localize(
				"Choose how the shield rule 'lose all following attacks' is interpreted. Core/default uses the existing following-attack/debt model. Defensive commitment is an optional table interpretation: the first shield parry commits all offensive Attacks for the current round, allows further parry attempts up to A, and does not create additional shield debt for the next round. It cannot be declared after making an offensive attack that round.",
				"Wybierz interpretację zasady tarczy „traci wszystkie swoje następne ataki”. Domyślna używa obecnego modelu kolejnych Ataków/długu. Zobowiązanie obronne jest opcjonalną interpretacją stołową: pierwsze parowanie tarczą poświęca wszystkie ofensywne Ataki w bieżącej rundzie, nadal pozwala parować do limitu A i nie tworzy dodatkowego długu tarczy na następną rundę. Nie można go zadeklarować po wykonaniu ofensywnego ataku w tej rundzie.",
			),
			scope: "world",
			config: true,
			type: String,
			choices: {
				[SHIELD_PARRY_RULE.FOLLOWING_ATTACKS]: localize(
					"Core/default — lose following attacks (debt when necessary)",
					"Domyślna — utrata kolejnych Ataków (dług, gdy potrzebny)",
				),
				[SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT]: localize(
					"Optional — shield defensive commitment for this round",
					"Opcjonalna — zobowiązanie obronne tarczą na tę rundę",
				),
			},
			default: SHIELD_PARRY_RULE.FOLLOWING_ATTACKS,
		});
	}

	static shieldParryRule() {
		let value = SHIELD_PARRY_RULE.FOLLOWING_ATTACKS;
		try {
			value = String(
				game.settings.get(game.system.id, SHIELD_PARRY_SETTING_KEY) ?? value,
			);
		} catch (_error) {
			/* During very early initialization the registry may not be readable yet. */
		}
		return Object.values(SHIELD_PARRY_RULE).includes(value)
			? value
			: SHIELD_PARRY_RULE.FOLLOWING_ATTACKS;
	}

	static usesShieldDefensiveCommitment() {
		return this.shieldParryRule() === SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT;
	}
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

Hooks.once("init", () => WfrpRuleSettings.register());
