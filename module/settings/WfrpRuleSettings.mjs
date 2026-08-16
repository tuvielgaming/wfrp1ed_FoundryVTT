export const SHIELD_PARRY_RULE = Object.freeze({
	FOLLOWING_ATTACKS: "followingAttacks",
	DEFENSIVE_COMMITMENT: "defensiveCommitment",
});

const SHIELD_PARRY_SETTING_KEY = "shieldParryRule";
const WEAPON_MODIFIERS_SETTING_KEY = "optionalWeaponModifiers";
const GM_DAMAGE_AUTOMATION_SETTING_KEY = "autoRollDamageForGmActors";
const OWNED_DAMAGE_AUTOMATION_SETTING_KEY = "autoRollDamageForOwnedActors";
const PENDING_TEST_CLEANUP_SETTING_KEY = "autoClearPendingTests";

export class WfrpRuleSettings {
	static #damageAutomationSuspensions = new Set();

	static register() {
		game.settings.register(game.system.id, SHIELD_PARRY_SETTING_KEY, {
			name: game.i18n.localize("WFRP1ED.Settings.ParryEconomy.Name"),
			hint: game.i18n.localize("WFRP1ED.Settings.ParryEconomy.Hint"),
			scope: "world",
			config: true,
			type: String,
			choices: {
				[SHIELD_PARRY_RULE.FOLLOWING_ATTACKS]: game.i18n.localize("WFRP1ED.Settings.ParryEconomy.Core"),
				[SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT]: game.i18n.localize("WFRP1ED.Settings.ParryEconomy.RoundContract"),
			},
			default: SHIELD_PARRY_RULE.FOLLOWING_ATTACKS,
		});

		game.settings.register(game.system.id, WEAPON_MODIFIERS_SETTING_KEY, {
			name: game.i18n.localize("WFRP1ED.Settings.WeaponModifiers.Name"),
			hint: game.i18n.localize("WFRP1ED.Settings.WeaponModifiers.Hint"),
			scope: "world",
			config: true,
			type: Boolean,
			default: true,
		});

		game.settings.register(game.system.id, GM_DAMAGE_AUTOMATION_SETTING_KEY, {
			name: game.i18n.localize("WFRP1ED.Settings.AutoDamageGM.Name"),
			hint: game.i18n.localize("WFRP1ED.Settings.AutoDamageGM.Hint"),
			scope: "world",
			config: true,
			type: Boolean,
			default: true,
		});

		game.settings.register(game.system.id, OWNED_DAMAGE_AUTOMATION_SETTING_KEY, {
			name: game.i18n.localize("WFRP1ED.Settings.AutoDamageOwned.Name"),
			hint: game.i18n.localize("WFRP1ED.Settings.AutoDamageOwned.Hint"),
			scope: "client",
			config: true,
			type: Boolean,
			default: false,
		});

		game.settings.register(game.system.id, PENDING_TEST_CLEANUP_SETTING_KEY, {
			name: localize(
				"Automatically clear stale pending tests",
				"Automatycznie usuwaj nieaktualne oczekujące testy",
			),
			hint: localize(
				"Remove unresolved Standard Test requests and abandoned pre-damage combat interactions after two combat rounds. Also clear all such unresolved interactions during a normal GM world shutdown. Resolved damage waiting to be applied is preserved.",
				"Usuwaj nierozstrzygnięte Testy Standardowe i porzucone interakcje walki sprzed rozstrzygnięcia obrażeń po dwóch rundach walki. Wszystkie takie nierozstrzygnięte interakcje są też usuwane podczas normalnego zamknięcia Świata przez MG. Rozstrzygnięte obrażenia oczekujące na zastosowanie pozostają zachowane.",
			),
			scope: "world",
			config: true,
			type: Boolean,
			default: true,
		});
	}

	static shieldParryRule() {
		let value = SHIELD_PARRY_RULE.FOLLOWING_ATTACKS;
		try {
			value = String(game.settings.get(game.system.id, SHIELD_PARRY_SETTING_KEY) ?? value);
		} catch (_error) {}
		return Object.values(SHIELD_PARRY_RULE).includes(value)
			? value
			: SHIELD_PARRY_RULE.FOLLOWING_ATTACKS;
	}

	static usesOptionalWeaponModifiers() {
		return this.#booleanSetting(WEAPON_MODIFIERS_SETTING_KEY, true);
	}

	static autoRollDamageForGmActors() {
		return !this.damageAutomationSuspended() && this.#booleanSetting(GM_DAMAGE_AUTOMATION_SETTING_KEY, true);
	}

	static autoRollDamageForOwnedActors() {
		return !this.damageAutomationSuspended() && this.#booleanSetting(OWNED_DAMAGE_AUTOMATION_SETTING_KEY, false);
	}

	static autoClearPendingTests() {
		return this.#booleanSetting(PENDING_TEST_CLEANUP_SETTING_KEY, true);
	}

	static suspendDamageAutomation(key) {
		const id = String(key ?? "").trim();
		if (!id) throw new Error("Damage automation suspension requires a non-empty key.");
		this.#damageAutomationSuspensions.add(id);
		return id;
	}

	static resumeDamageAutomation(key) {
		this.#damageAutomationSuspensions.delete(String(key ?? "").trim());
	}

	static damageAutomationSuspended() {
		return this.#damageAutomationSuspensions.size > 0;
	}

	static usesRoundDefenceContract() {
		return this.shieldParryRule() === SHIELD_PARRY_RULE.DEFENSIVE_COMMITMENT;
	}

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

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}

Hooks.once("init", () => WfrpRuleSettings.register());
