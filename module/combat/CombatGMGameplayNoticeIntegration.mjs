import { GMGameplayNotice } from "../chat/GMGameplayNotice.mjs";
import { WEAPON_KIND } from "../data-models/item/WeaponData.mjs";
import { CombatAttackLauncher } from "./CombatAttackLauncher.mjs";
import { CombatRangedState } from "./CombatRangedState.mjs";

let installed = false;

/*
 * Convert only explicitly recognised, expected gameplay failures into the
 * GMGameplayNotice channel. Unknown exceptions continue through the ordinary
 * error path so programming/system failures are never hidden as rule notices.
 *
 * This first consumer covers the audited ammunition-access rule. Additional
 * mechanics should opt in here or call GMGameplayNotice directly only after the
 * notification has been classified as gameplay/adjudication information.
 */
Hooks.once("init", () => install());

function install() {
	if (installed) return;
	installed = true;

	const originalLaunch = CombatAttackLauncher.launch;
	CombatAttackLauncher.launch = async function launchWithGmGameplayNotices(actor, weapon) {
		try {
			return await originalLaunch.call(this, actor, weapon);
		} catch (error) {
			const notice = rangedAmmunitionNotice(actor, weapon, error);
			if (!notice) throw error;
			await GMGameplayNotice.warn(notice);
			return null;
		}
	};
}

function rangedAmmunitionNotice(actor, weapon, error) {
	if (
		weapon?.type !== "weapon" ||
		weapon.system?.kind !== WEAPON_KIND.RANGED
	) return null;

	let fire;
	try {
		fire = CombatRangedState.fireAvailability(actor, weapon);
	} catch (_classificationError) {
		return null;
	}

	/* The ammunition integration exposes its gate on fireAvailability. Because
	 * the ranged-state reason now has priority over ammunition, this marker is
	 * present only when missing accessible ammunition is actually the reason the
	 * attack was refused. Match the thrown text as an additional guard against
	 * accidentally reclassifying some unrelated exception. */
	if (fire?.ammunition?.allowed !== false) return null;
	if (String(error?.message ?? "") !== String(fire.reason ?? "")) return null;

	return {
		category: "ranged-ammunition",
		title: localize("Ammunition", "Amunicja"),
		message: fire.reason,
		summary: localize(
			"No readily accessible ammunition — details saved in private GM chat.",
			"Brak łatwo dostępnej amunicji — szczegóły zapisano w prywatnym czacie MG.",
		),
		actor,
		item: weapon,
	};
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
