const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";

const reconcilingActors = new Set();

/**
 * Safety boundary for Foundry's defeated/dead status.
 *
 * WFRP reaching 0 Wounds and producing Critical overflow does not itself kill a
 * character. Only an explicitly-applied fatal Critical transaction may set the
 * defeated status. Historical/reverted/orphan fatal records are ignored when
 * determining the current state.
 *
 * FatalCriticalIntegration remains the transaction owner. This guard runs after
 * Actor updates and enforces the stricter invariant, including worlds carrying
 * stale fatal flags created by earlier development builds.
 */
Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!touchesManagedFatalState(changes)) return;
	queueReconciliation(actor);
});

for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
	Hooks.on(hook, (effect) => {
		const actor = effect?.parent;
		if (!(actor instanceof foundry.documents.Actor)) return;
		if (!hasManagedFatalHistory(actor)) return;
		queueReconciliation(actor);
	});
}

Hooks.once("ready", () => {
	if (!isStatusAuthority()) return;
	for (const actor of game.actors ?? []) {
		if (hasManagedFatalHistory(actor)) queueReconciliation(actor);
	}
});

function queueReconciliation(actor) {
	if (!isStatusAuthority() || reconcilingActors.has(actor.id)) return;
	/* Let the canonical fatal integration finish its own immediate update first. */
	setTimeout(() => void reconcileStrictFatalStatus(actor), 50);
}

async function reconcileStrictFatalStatus(actor) {
	if (!(actor instanceof foundry.documents.Actor) || reconcilingActors.has(actor.id)) return;
	reconcilingActors.add(actor.id);
	try {
		const fatalMap = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY);
		const damageMap = objectFlag(actor, DAMAGE_APPLICATIONS_FLAG_KEY);
		const fateMap = objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY);
		const history = Object.values(fatalMap).filter(isRecord);
		if (history.length === 0) return;

		const activeFatality = history.some((application) => {
			if (application.state !== "applied") return false;
			const packetId = String(application.packetId ?? "");
			const damage = damageMap[packetId];
			return Boolean(
				damage?.state === "applied" &&
				damage?.criticalResolution?.outcome === KILLED_OUTCOME &&
				!isRecord(fateMap[packetId])
			);
		});

		if (activeFatality) {
			await setDefeated(actor, true);
			return;
		}

		/*
		 * No currently-applied fatal Critical owns death. Restore the status which
		 * existed before this subsystem's first fatal application. Never infer death
		 * from Wounds, Critical value, or historical later `defeatedBefore` values.
		 */
		const first = [...history].sort(
			(left, right) =>
				(Number(left?.appliedAt) - Number(right?.appliedAt)) ||
				String(left?.packetId ?? "").localeCompare(String(right?.packetId ?? "")),
		)[0];
		await setDefeated(actor, first?.defeatedBefore === true);
	} catch (error) {
		console.error("WFRP1ED | Unable to enforce fatal-status consistency.", error);
	} finally {
		reconcilingActors.delete(actor.id);
	}
}

async function setDefeated(actor, active) {
	const statusId = defeatedStatusId();
	if (!statusId) return;
	const current = actor.statuses?.has?.(statusId) === true;
	if (current === Boolean(active)) return;
	await actor.toggleStatusEffect(statusId, {
		active: Boolean(active),
		overlay: true,
	});
}

function defeatedStatusId() {
	const configured = CONFIG.statusEffects ?? {};
	const special = CONFIG.specialStatusEffects ?? {};
	const direct = special.DEFEATED ?? special.defeated;
	if (typeof direct === "string" && configured[direct]) return direct;

	for (const [key, id] of Object.entries(special)) {
		if (
			String(key).toLowerCase().includes("defeat") &&
			typeof id === "string" &&
			configured[id]
		) return id;
	}
	for (const fallback of ["dead", "defeated"]) {
		if (configured[fallback]) return fallback;
	}
	return null;
}

function touchesManagedFatalState(changes) {
	if (!changes || typeof changes !== "object") return false;
	return [
		DAMAGE_APPLICATIONS_FLAG_KEY,
		FATAL_APPLICATIONS_FLAG_KEY,
		FATE_INTERVENTIONS_FLAG_KEY,
	].some((key) => {
		const path = `flags.${FLAG_SCOPE}.${key}`;
		return Object.hasOwn(changes, path) ||
			foundry.utils.getProperty(changes, path) !== undefined;
	});
}

function hasManagedFatalHistory(actor) {
	return Object.values(objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY)).some(isRecord);
}

function objectFlag(actor, key) {
	const value = actor?.getFlag?.(FLAG_SCOPE, key);
	return isRecord(value) ? value : {};
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStatusAuthority() {
	const primary = primaryActiveGm();
	if (primary) return Boolean(game.user?.isGM && primary.id === game.user.id);
	return false;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}
