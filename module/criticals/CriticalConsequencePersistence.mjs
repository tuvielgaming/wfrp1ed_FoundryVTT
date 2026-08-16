const FLAG_SCOPE = "wfrp1ed";
const GENERIC_EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const TIMED_FLAG_KEY = "criticalTimed";
const PERIODIC_FLAG_KEY = "criticalPeriodic";
const repairing = new Set();

for (const hookName of ["createActiveEffect", "updateActiveEffect"]) {
	Hooks.on(hookName, (effect) => {
		void synchronizeGenericCriticalEffect(effect).catch(reportError);
	});
}

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	void repairExisting().catch(reportError);
});

async function repairExisting() {
	for (const actor of game.actors ?? []) {
		for (const wound of actor.items ?? []) {
			if (wound?.type !== "criticalWound") continue;
			for (const effect of wound.effects ?? []) {
				await synchronizeGenericCriticalEffect(effect);
			}
		}
	}
}

/**
 * Preserve the declarative rule payload and the terminal state of managed
 * Critical effects.
 *
 * "Automation enabled" means execute the wound's declared consequence once
 * when the wound is applied. It is not a repeating toggle. Once a WFRP timer
 * has stamped an expiry, the generated transfer ActiveEffect must remain
 * disabled; otherwise Foundry can prepare/transfer the Item child again and
 * make a completed temporary consequence appear to re-apply.
 */
async function synchronizeGenericCriticalEffect(effect) {
	const wound = effect?.parent;
	if (wound?.type !== "criticalWound") return false;
	const metadata = effect.getFlag?.(FLAG_SCOPE, GENERIC_EFFECT_FLAG_KEY);
	if (!metadata?.kind) return false;

	const uuid = String(effect.uuid ?? "");
	if (repairing.has(uuid)) return false;

	const update = {};
	const timed = effect.getFlag?.(FLAG_SCOPE, TIMED_FLAG_KEY);
	const periodic = effect.getFlag?.(FLAG_SCOPE, PERIODIC_FLAG_KEY);
	const terminal = Boolean(
		positiveInteger(timed?.expiredAtRound) > 0 ||
		positiveInteger(periodic?.expiredAtRound) > 0 ||
		positiveNumber(periodic?.expiredAtWorldTime) > 0
	);
	if (terminal && effect.disabled !== true) {
		update.disabled = true;
		update["duration.expired"] = true;
	}

	if (metadata.kind === "characteristics") {
		const source = effect.toObject?.() ?? {};
		const changes = Array.isArray(source.changes) ? source.changes : [];
		if (changes.length) {
			const flagged = effect.getFlag?.(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY);
			if (!sameJson(flagged, changes)) {
				update[`flags.${FLAG_SCOPE}.${RULE_CHANGES_FLAG_KEY}`] =
					foundry.utils.deepClone(changes);
			}
		}
	}

	if (!Object.keys(update).length) return false;

	repairing.add(uuid);
	try {
		await effect.update(update);
	} finally {
		repairing.delete(uuid);
	}
	return true;
}

function positiveInteger(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : 0;
}

function positiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function sameJson(a, b) {
	try {
		return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	} catch (_error) {
		return false;
	}
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

function isPrimaryActiveGm() {
	return Boolean(game.user?.isGM && primaryActiveGm()?.id === game.user.id);
}

function reportError(error) {
	console.error("WFRP1ED | Unable to persist generic Critical consequence changes.", error);
}
