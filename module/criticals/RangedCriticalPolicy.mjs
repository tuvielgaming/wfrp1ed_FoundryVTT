import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";

const SETTING_KEY = "detailedCriticalsForRangedAttacks";
const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";

/**
 * Core WFRP 1e recommends Sudden Death Critical Hit tables for missile fire,
 * because many ordinary detailed melee descriptions are inappropriate for
 * arrows, bolts and bullets. This optional World rule deliberately reverses
 * only that routing choice; the ranged damage calculation itself is unchanged.
 *
 * IMPORTANT LOCALIZATION CONTRACT: visible Foundry settings are registered on
 * i18nInit, after translations are loaded and before Settings initialization.
 */
export class RangedCriticalPolicy {
	static settingKey = SETTING_KEY;

	static registerSetting() {
		game.settings.register(game.system.id, SETTING_KEY, {
			name: game.i18n.localize(
				"WFRP1ED.Settings.RangedDetailedCriticals.Name",
			),
			hint: game.i18n.localize(
				"WFRP1ED.Settings.RangedDetailedCriticals.Hint",
			),
			scope: "world",
			config: true,
			type: Boolean,
			default: false,
		});
	}

	static usesDetailedCriticals() {
		try {
			return game.settings.get(game.system.id, SETTING_KEY) === true;
		} catch (_error) {
			return false;
		}
	}

	static criticalMode() {
		return this.usesDetailedCriticals()
			? DAMAGE_CRITICAL_MODE.DETAILED
			: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH;
	}
}

Hooks.once("i18nInit", () => RangedCriticalPolicy.registerSetting());

/*
 * CombatRangedDamageIntegration creates the canonical Core DamagePacket and
 * DamageChat.attach persists it. Keep that damage implementation isolated from
 * campaign-policy concerns by changing only the incoming packet's critical
 * routing at the ChatMessage persistence boundary.
 *
 * This also covers rerolls/reconciliation because every rebuilt ranged damage
 * packet passes through DamageChat.attach again.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family !== "ranged") return;

	const state = incomingDamageState(changes);
	if (!state?.packet?.critical || typeof state.packet.critical !== "object") {
		return;
	}

	state.packet.critical.mode = RangedCriticalPolicy.criticalMode();
});

function incomingDamageState(changes) {
	if (!changes || typeof changes !== "object") return null;
	const flat = changes[`flags.${FLAG_SCOPE}.${DAMAGE_FLAG_KEY}`];
	if (flat && typeof flat === "object") return flat;
	return foundry.utils.getProperty(
		changes,
		`flags.${FLAG_SCOPE}.${DAMAGE_FLAG_KEY}`,
	) ?? null;
}
