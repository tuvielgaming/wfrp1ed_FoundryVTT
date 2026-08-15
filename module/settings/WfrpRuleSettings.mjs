export const SHIELD_PARRY_RULE = Object.freeze({
	FOLLOWING_ATTACKS: "followingAttacks",
	DEFENSIVE_COMMITMENT: "defensiveCommitment",
});

const SHIELD_PARRY_SETTING_KEY = "shieldParryRule";
const WEAPON_MODIFIERS_SETTING_KEY = "optionalWeaponModifiers";

/**
 * Native Foundry world settings for explicit WFRP 1e rule interpretations.
 *
 * The persisted shield-parry key/value names are retained for compatibility
 * with worlds which already selected that optional interpretation. The Core
 * Weapon Modifiers table is a separate optional rule and therefore defaults to
 * disabled; authoring values on Weapon Items never enables it implicitly.
 */
export class WfrpRuleSettings {
	static register() {
		game.settings.register(game.system.id, SHIELD_PARRY_SETTING_KEY, {
			name: game.i18n.localize("WFRP1ED.Settings.ParryEconomy.Name"),
			hint: game.i18n.localize("WFRP1ED.Settings.ParryEconomy.Hint"),
			scope: "world",
			config: true,
			type: String,
			choices: {
				[SHIELD_PARRY_RULE.FOLLOWING_ATTACKS]: game.i18n.localize(
					"WFRP1ED.Settings.ParryEconomy.Core",
				),
				[SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT]: game.i18n.localize(
					"WFRP1ED.Settings.ParryEconomy.RoundContract",
				),
			},
			default: SHIELD_PARRY_RULE.FOLLOWING_ATTACKS,
		});

		game.settings.register(game.system.id, WEAPON_MODIFIERS_SETTING_KEY, {
			name: localize(
				"Optional Weapon Modifiers",
				"Opcjonalne modyfikatory broni",
			),
			hint: localize(
				"Use the optional WFRP 1e Weapon Modifiers table for To Hit, Damage and Parry. Initiative remains disabled until its round-order interaction is audited separately.",
				"Używaj opcjonalnej tabeli Modyfikatorów Broni z WFRP 1e dla Trafienia, Obrażeń i Parowania. Modyfikator Inicjatywy pozostaje wyłączony do osobnego audytu jego wpływu na kolejność rundy.",
			),
			scope: "world",
			config: true,
			type: Boolean,
			default: false,
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

	static usesOptionalWeaponModifiers() {
		try {
			return game.settings.get(
				game.system.id,
				WEAPON_MODIFIERS_SETTING_KEY,
			) === true;
		} catch (_error) {
			return false;
		}
	}

	/** Optional interpretation: all parry costs are confined to this round. */
	static usesRoundDefenceContract() {
		return this.shieldParryRule() === SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT;
	}

	/** Compatibility alias used by existing combat/UI integrations. */
	static usesShieldDefensiveCommitment() {
		return this.usesRoundDefenceContract();
	}
}

Hooks.once("init", () => WfrpRuleSettings.register());

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
