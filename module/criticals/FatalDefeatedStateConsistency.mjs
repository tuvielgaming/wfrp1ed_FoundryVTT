const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const KILLED_OUTCOME = "killed";
const FINAL_RECONCILE_DELAY_MS = 700;

const pending = new Map();

/*
 * Final defeated-state consistency pass for fatal Critical transactions.
 *
 * Foundry v14 represents the visible defeated state through two independent
 * mechanisms:
 *   1. a configured status ActiveEffect on the represented Actor/Token Actor;
 *   2. Combatant.defeated when that Token is in a Combat encounter.
 *
 * The critical subsystem also contains earlier lifecycle adapters which restore
 * snapshots immediately or after short delays. This final pass intentionally
 * runs after those adapters and derives the desired state only from the current
 * authoritative WFRP transaction maps. It then repairs both Foundry mechanisms.
 *
 * In particular, clearing a fatal result does not merely call
 * Actor.toggleStatusEffect(false). If a duplicate/stale ActiveEffect still
 * carries the configured defeated status, every such effect is removed when the
 * transaction baseline says the Actor was alive before this fatal result.
 */
Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;
	if (!fatalStateTouched(changes)) return;
	queueReconcile(actor, "actor-update");
});

Hooks.on("deleteChatMessage", (message) => {
	const result = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!isRecord(result) || !result.packetId) return;
	const actor = actorForCriticalResult(result);
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;
	queueReconcile(actor, "critical-message-delete");
});

/* Repair stale defeated state left by earlier development builds. This does not
 * invent a state: only Actors/Token Actors with an existing fatal transaction
 * map are considered, and their desired state is recomputed from that history. */
Hooks.once("ready", () => {
	if (!isStatusAuthority(null)) return;

	const actors = new Map();
	const add = (actor) => {
		if (!(actor instanceof foundry.documents.Actor)) return;
		if (Object.keys(objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY)).length === 0) return;
		const key = String(actor.uuid ?? actor.id ?? "");
		if (key) actors.set(key, actor);
	};

	for (const actor of game.actors ?? []) add(actor);
	for (const scene of game.scenes ?? []) {
		for (const token of scene?.tokens ?? []) add(token?.actor);
	}

	for (const actor of actors.values()) {
		queueReconcile(actor, "ready-repair");
	}
});

function queueReconcile(actor, reason) {
	const key = String(actor.uuid ?? actor.id ?? "");
	if (!key) return;

	const previous = pending.get(key);
	if (previous) clearTimeout(previous);

	const timer = setTimeout(() => {
		pending.delete(key);
		void reconcileDefeatedState(actor, reason).catch((error) => {
			console.error(
				"WFRP1ED | Final fatal defeated-state reconciliation failed.",
				error,
			);
		});
	}, FINAL_RECONCILE_DELAY_MS);
	pending.set(key, timer);
}

async function reconcileDefeatedState(actor, reason) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;

	const damageMap = objectFlag(actor, DAMAGE_APPLICATIONS_FLAG_KEY);
	const fatalMap = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY);
	const fateMap = objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY);
	const active = activeFatalApplications(damageMap, fatalMap, fateMap);

	if (active.length > 0) {
		await setDefeatedEverywhere(actor, true);
		console.info("WFRP1ED | Fatal defeated-state reconciliation", {
			reason,
			actor: actor.uuid,
			desired: true,
			activePacketIds: active.map((entry) => entry.packetId),
		});
		return;
	}

	const release = latestReleaseApplication(fatalMap, fateMap);
	if (!release) return;

	const desired = baselineDefeated(release);
	await setDefeatedEverywhere(actor, desired);

	console.info("WFRP1ED | Fatal defeated-state reconciliation", {
		reason,
		actor: actor.uuid,
		desired,
		releasePacketId: String(release.packetId ?? ""),
		actorStatuses: [...(actor.statuses ?? [])],
	});
}

function activeFatalApplications(damageMap, fatalMap, fateMap) {
	return Object.entries(fatalMap)
		.map(([packetId, application]) => ({
			...foundry.utils.deepClone(application),
			packetId: String(application?.packetId ?? packetId),
		}))
		.filter((application) => {
			if (!isRecord(application) || application.state !== "applied") return false;
			const packetId = String(application.packetId ?? "");
			const damage = damageMap[packetId];
			return Boolean(
				damage?.state === "applied" &&
				damage?.criticalResolution?.outcome === KILLED_OUTCOME &&
				!isRecord(fateMap[packetId])
			);
		});
}

function latestReleaseApplication(fatalMap, fateMap) {
	const candidates = [];

	for (const application of Object.values(fatalMap)) {
		if (!isRecord(application)) continue;
		if (application.state === "reverted") {
			candidates.push({
				application,
				at: Number(application.revertedAt ?? application.appliedAt ?? 0),
			});
		}
	}

	for (const intervention of Object.values(fateMap)) {
		if (!isRecord(intervention)) continue;
		const application = fatalMap[String(intervention.packetId ?? "")];
		if (!isRecord(application)) continue;
		candidates.push({
			application,
			at: Number(intervention.spentAt ?? application.appliedAt ?? 0),
		});
	}

	return candidates
		.sort((left, right) => right.at - left.at)[0]
		?.application ?? null;
}

async function setDefeatedEverywhere(actor, desired) {
	const representations = representedActors(actor);
	for (const represented of representations) {
		await forceActorDefeatedStatus(represented, desired);
	}
	await writeMatchingCombatants(actor, desired);
}

function representedActors(actor) {
	const actors = new Map();
	const add = (candidate) => {
		if (!(candidate instanceof foundry.documents.Actor)) return;
		const key = String(candidate.uuid ?? candidate.id ?? "");
		if (key) actors.set(key, candidate);
	};

	add(actor);
	add(actor?.token?.actor);

	for (const scene of game.scenes ?? []) {
		for (const token of scene?.tokens ?? []) {
			const tokenActor = token?.actor;
			if (!(tokenActor instanceof foundry.documents.Actor)) continue;

			if (actor?.token) {
				if (
					String(token.id ?? "") === String(actor.token.id ?? "") &&
					String(scene.id ?? "") === String(actor.token.parent?.id ?? actor.token.scene?.id ?? "")
				) add(tokenActor);
				continue;
			}

			if (
				token?.actorLink === true &&
				(
					tokenActor === actor ||
					String(token?.actorId ?? "") === String(actor.id ?? "")
				)
			) add(tokenActor);
		}
	}

	return [...actors.values()];
}

async function forceActorDefeatedStatus(actor, desired) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	const statusId = defeatedStatusId();
	if (!statusId) return;

	if (desired) {
		if (!actor.statuses?.has?.(statusId)) {
			await actor.toggleStatusEffect(statusId, {
				active: true,
				overlay: true,
			});
		}
		return;
	}

	/* Use the public API first. */
	if (actor.statuses?.has?.(statusId)) {
		await actor.toggleStatusEffect(statusId, {
			active: false,
			overlay: true,
		});
	}

	/* Then remove every residual ActiveEffect carrying the same status. This is
	 * the authoritative cleanup for a baseline which was explicitly alive. */
	const residualIds = [...(actor.effects ?? [])]
		.filter((effect) => effectCarriesStatus(effect, statusId))
		.map((effect) => String(effect.id ?? ""))
		.filter(Boolean);

	if (residualIds.length > 0) {
		await actor.deleteEmbeddedDocuments("ActiveEffect", residualIds);
	}
}

function effectCarriesStatus(effect, statusId) {
	const statuses = effect?.statuses;
	if (statuses?.has?.(statusId)) return true;
	if (Array.isArray(statuses)) return statuses.includes(statusId);
	if (statuses && typeof statuses[Symbol.iterator] === "function") {
		return [...statuses].includes(statusId);
	}
	return false;
}

async function writeMatchingCombatants(actor, desired) {
	for (const combat of game.combats ?? []) {
		const updates = matchingCombatants(combat, actor)
			.filter((combatant) => Boolean(combatant.isDefeated ?? combatant.defeated) !== Boolean(desired))
			.map((combatant) => ({
				_id: combatant.id,
				defeated: Boolean(desired),
			}));
		if (updates.length > 0) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}
}

function matchingCombatants(combat, actor) {
	const matches = new Map();
	const add = (combatant) => {
		if (combatant?.id) matches.set(String(combatant.id), combatant);
	};

	const actorId = String(actor?.id ?? "");
	const actorUuid = String(actor?.uuid ?? "");
	const tokenId = String(actor?.token?.id ?? "");

	if (actorId && typeof combat?.getCombatantsByActor === "function") {
		for (const combatant of combat.getCombatantsByActor(actor) ?? []) add(combatant);
	}
	if (tokenId && typeof combat?.getCombatantsByToken === "function") {
		for (const combatant of combat.getCombatantsByToken(tokenId) ?? []) add(combatant);
	}

	for (const combatant of combat?.combatants ?? []) {
		if (combatant?.actor === actor) add(combatant);
		else if (actorUuid && String(combatant?.actor?.uuid ?? "") === actorUuid) add(combatant);
		else if (tokenId && String(combatant?.tokenId ?? combatant?.token?.id ?? "") === tokenId) add(combatant);
		else if (
			!tokenId && actorId &&
			(
				String(combatant?.actorId ?? "") === actorId ||
				String(combatant?.actor?.id ?? "") === actorId ||
				String(combatant?.token?.actorId ?? "") === actorId
			)
		) add(combatant);
	}

	return [...matches.values()];
}

function actorForCriticalResult(result) {
	const sourceMessage = game.messages?.get(String(result?.sourceMessageId ?? ""));
	const damage = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	return actorFromUuidSync(damage?.packet?.targetActorUuid);
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function baselineDefeated(application) {
	if (application?.actorDefeatedBefore !== undefined) {
		return application.actorDefeatedBefore === true;
	}
	return application?.defeatedBefore === true;
}

function fatalStateTouched(changes) {
	return [
		DAMAGE_APPLICATIONS_FLAG_KEY,
		FATAL_APPLICATIONS_FLAG_KEY,
		FATE_INTERVENTIONS_FLAG_KEY,
	].some((key) => touchesFlag(changes, key));
}

function touchesFlag(changes, key) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${key}`;
	if (Object.hasOwn(changes, path)) return true;
	if (foundry.utils.getProperty?.(changes, path) !== undefined) return true;
	const flattened = foundry.utils.flattenObject?.(changes) ?? changes;
	return Object.keys(flattened).some(
		(candidate) => candidate === path || candidate.startsWith(`${path}.`),
	);
}

function objectFlag(actor, key) {
	const value = actor?.getFlag?.(FLAG_SCOPE, key);
	return isRecord(value) ? foundry.utils.deepClone(value) : {};
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

function isStatusAuthority(actor) {
	const primary = primaryActiveGm();
	if (primary) {
		return Boolean(game.user?.isGM && String(primary.id) === String(game.user.id));
	}
	if (!(actor instanceof foundry.documents.Actor) || !game.user) return false;
	return actor.testUserPermission?.(
		game.user,
		CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
	) === true;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
