import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const RECENT_REVERT_WINDOW_MS = 2000;
const AUTOMATION_HOLD_MS = 750;
const activeHolds = new Map();

/**
 * Damage invalidation is an adjudication/rollback action, not a request to roll
 * replacement damage immediately. CombatDamageIntegration normally auto-rolls
 * damage for GM-controlled Actors when a damage stage is open; the forced chat
 * render performed by rollback could therefore turn a just-reverted attack into
 * a fresh damage/parry-reduction sequence without another user action.
 *
 * Hold only automatic damage/parry actions during the render immediately caused
 * by a newly reverted transaction. Manual buttons remain available because the
 * underlying request permission checks do not depend on this automation setting.
 */
Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!damageApplicationsChanged(changes)) return;

	const applications = actor.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_APPLICATIONS_FLAG_KEY,
	);
	if (!applications || typeof applications !== "object" || Array.isArray(applications)) {
		return;
	}

	const now = Date.now();
	for (const transaction of Object.values(applications)) {
		if (transaction?.state !== "reverted") continue;
		const revertedAt = Number(transaction.revertedAt) || 0;
		if (revertedAt <= 0 || now - revertedAt > RECENT_REVERT_WINDOW_MS) continue;

		const packetId = String(transaction.packetId ?? transaction.id ?? "").trim();
		if (!packetId) continue;
		const key = `damage-revert:${actor.uuid}:${packetId}`;
		if (activeHolds.has(key)) continue;

		WfrpRuleSettings.suspendDamageAutomation(key);
		const timeout = setTimeout(() => {
			WfrpRuleSettings.resumeDamageAutomation(key);
			activeHolds.delete(key);
		}, AUTOMATION_HOLD_MS);
		activeHolds.set(key, timeout);
	}
});

function damageApplicationsChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}
