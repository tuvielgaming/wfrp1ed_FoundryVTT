import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DamagePacket,
} from "../damage/DamagePacket.mjs";

const SETTING_KEY = "detailedCriticalsForRangedAttacks";
const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";

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
 * DamageChat.attach is the canonical boundary where a combat attack becomes a
 * shared damage transaction. Rebuild only ranged packets there, preserving the
 * packet id and every damage/mitigation field while replacing only the critical
 * routing selected by the World rule.
 *
 * Presentation is intentionally handled elsewhere. Keeping policy and UI
 * separate prevents a ranged presentation layer from clearing normal shared
 * Damage-card actions such as Apply Damage.
 */
const originalAttach = DamageChat.attach;
DamageChat.attach = async function rangedCriticalPolicyAttach(
	message,
	{ packet, resolution } = {},
) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (attack?.family !== "ranged" || !packet) {
		return originalAttach.call(this, message, { packet, resolution });
	}

	const source = packet instanceof DamagePacket
		? packet.toJSON()
		: foundry.utils.deepClone(packet);
	const rewritten = DamagePacket.fromJSON({
		...source,
		critical: {
			...(source?.critical ?? {}),
			mode: RangedCriticalPolicy.criticalMode(),
		},
	});

	return originalAttach.call(this, message, {
		packet: rewritten,
		resolution,
	});
};
