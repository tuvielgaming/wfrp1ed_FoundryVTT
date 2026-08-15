export const SHIELD_PARRY_RULE = Object.freeze({
	FOLLOWING_ATTACKS: "followingAttacks",
	DEFENSIVE_COMMITMENT: "defensiveCommitment",
});

const SHIELD_PARRY_SETTING_KEY = "shieldParryRule";
const WEAPON_MODIFIERS_SETTING_KEY = "optionalWeaponModifiers";
const GM_DAMAGE_AUTOMATION_SETTING_KEY = "autoRollDamageForGmActors";
const OWNED_DAMAGE_AUTOMATION_SETTING_KEY = "autoRollDamageForOwnedActors";

/**
 * Native Foundry settings for explicit WFRP 1e rule interpretations and local
 * combat-roll preferences.
 *
 * Rules which change the shared world contract use world scope. Automatic rolls
 * for player-owned Actors are a client preference so every player may decide
 * whether their own damage/parry dice wait for a click or roll immediately.
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
			name: game.i18n.localize(
				"WFRP1ED.Settings.WeaponModifiers.Name",
			),
			hint: game.i18n.localize(
				"WFRP1ED.Settings.WeaponModifiers.Hint",
			),
			scope: "world",
			config: true,
			type: Boolean,
			/* Most WFRP 1e tables use this optional Core table in practice. */
			default: true,
		});

		game.settings.register(game.system.id, GM_DAMAGE_AUTOMATION_SETTING_KEY, {
			name: game.i18n.localize(
				"WFRP1ED.Settings.AutoDamageGM.Name",
			),
			hint: game.i18n.localize(
				"WFRP1ED.Settings.AutoDamageGM.Hint",
			),
			scope: "world",
			config: true,
			type: Boolean,
			default: true,
		});

		game.settings.register(game.system.id, OWNED_DAMAGE_AUTOMATION_SETTING_KEY, {
			name: game.i18n.localize(
				"WFRP1ED.Settings.AutoDamageOwned.Name",
			),
			hint: game.i18n.localize(
				"WFRP1ED.Settings.AutoDamageOwned.Hint",
			),
			scope: "client",
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
		return this.#booleanSetting(WEAPON_MODIFIERS_SETTING_KEY, true);
	}

	static autoRollDamageForGmActors() {
		return this.#booleanSetting(GM_DAMAGE_AUTOMATION_SETTING_KEY, true);
	}

	static autoRollDamageForOwnedActors() {
		return this.#booleanSetting(OWNED_DAMAGE_AUTOMATION_SETTING_KEY, false);
	}

	/** Optional interpretation: all parry costs are confined to this round. */
	static usesRoundDefenceContract() {
		return this.shieldParryRule() === SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT;
	}

	/** Compatibility alias used by existing combat/UI integrations. */
	static usesShieldDefensiveCommitment() {
		return this.usesRoundDefenceContract();
	}

	static #booleanSetting(key, fallback) {
		try {
			return game.settings.get(game.system.id, key) === true;
		} catch (_error) {
			return Boolean(fallback);
		}
	}
}

Hooks.once("init", () => WfrpRuleSettings.register());
