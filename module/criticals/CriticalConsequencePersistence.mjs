const FLAG_SCOPE = "wfrp1ed";
const GENERIC_EFFECT_FLAG_KEY = "criticalConsequenceEffect";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const repairing = new Set();

for (const hookName of ["createActiveEffect", "updateActiveEffect"]) {
	Hooks.on(hookName, (effect) => {
		void persistGenericCriticalChanges(effect).catch(reportError);
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
				await persistGenericCriticalChanges(effect);
			}
		}
	}
}

async function persistGenericCriticalChanges(effect) {
	const wound = effect?.parent;
	if (wound?.type !== "criticalWound") return false;
	const metadata = effect.getFlag?.(FLAG_SCOPE, GENERIC_EFFECT_FLAG_KEY);
	if (metadata?.kind !== "characteristics") return false;

	const uuid = String(effect.uuid ?? "");
	if (repairing.has(uuid)) return false;
	const source = effect.toObject?.() ?? {};
	const changes = Array.isArray(source.changes) ? source.changes : [];
	if (!changes.length) return false;
	const flagged = effect.getFlag?.(FLAG_SCOPE, RULE_CHANGES_FLAG_KEY);
	if (sameJson(flagged, changes)) return false;

	repairing.add(uuid);
	try {
		await effect.update({
			[`flags.${FLAG_SCOPE}.${RULE_CHANGES_FLAG_KEY}`]:
				foundry.utils.deepClone(changes),
		});
	} finally {
		repairing.delete(uuid);
	}
	return true;
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
