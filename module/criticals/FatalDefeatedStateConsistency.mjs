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
 * Foundry v14 stores Token status effects as ActiveEffects on the represented
 * Actor/Token Actor. Combatant.defeated is a separate combat-tracker state.
 * This module reconciles both and explicitly redraws rendered Token effects after
 * the document state has been corrected.
 *
 * The rollback baseline is the Actor state from before this subsystem's first
 * managed fatal application. This is deliberate: after one broken/stale fatal
 * left Defeated behind, a later fatal would otherwise snapshot that stale state
 * as `defeatedBefore: true` and every subsequent rollback would keep restoring
 * the bug forever. The first managed fatal snapshot is the unpoisoned baseline
 * for the managed fatal-history chain.
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

/* Repair stale defeated state left by earlier development builds. Only Actors
 * with fatal transaction history are considered. */
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

	const baselineApplication = earliestManagedFatalApplication(fatalMap);
	if (!baselineApplication) return;

	const desired = baselineDefeated(baselineApplication);
	await setDefeatedEverywhere(actor, desired);

	/* One second pass closes races with the older fatal lifecycle hooks. It does
	 * not change the desired state; it merely reasserts the already-derived
	 * authoritative document state after those hooks have settled. */
	if (!desired) {
		await delay(75);
		await setDefeatedEverywhere(actor, false);
	}

	console.info("WFRP1ED | Fatal defeated-state reconciliation", {
		reason,
		actor: actor.uuid,
		desired,
		baselinePacketId: String(baselineApplication.packetId ?? ""),
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

function earliestManagedFatalApplication(fatalMap) {
	return Object.entries(fatalMap)
		.map(([packetId, application]) => isRecord(application)
			? {
				...foundry.utils.deepClone(application),
				packetId: String(application.packetId ?? packetId),
			}
			: null)
		.filter(Boolean)
		.sort((left, right) =>
			(Number(left.appliedAt ?? 0) - Number(right.appliedAt ?? 0)) ||
			String(left.packetId ?? "").localeCompare(String(right.packetId ?? "")),
		)[0] ?? null;
}

async function setDefeatedEverywhere(actor, desired) {
	const representations = representedActors(actor);
	for (const represented of representations) {
		await forceActorDefeatedStatus(represented, desired);
	}
	await writeMatchingCombatants(actor, desired);
	await refreshRenderedTokenEffects(representations);
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

	/* First use Foundry's supported status API. */
	if (actor.statuses?.has?.(statusId)) {
		await actor.toggleStatusEffect(statusId, {
			active: false,
			overlay: true,
		});
	}

	/* Then delete any residual status ActiveEffect explicitly. Active Effects V2
	 * exposes statuses in source data; inspect both prepared and source forms so a
	 * stale prepared collection cannot hide the effect we need to remove. */
	const residualIds = [...(actor.effects ?? [])]
		.filter((effect) => effectCarriesStatus(effect, statusId))
		.map((effect) => String(effect.id ?? ""))
		.filter(Boolean);

	if (residualIds.length > 0) {
		await actor.deleteEmbeddedDocuments("ActiveEffect", residualIds);
	}
}

function effectCarriesStatus(effect, statusId) {
	return effectStatusIds(effect).includes(String(statusId));
}

function effectStatusIds(effect) {
	const candidates = [
		effect?.statuses,
		effect?._source?.statuses,
	];

	try {
		candidates.push(effect?.toObject?.(false)?.statuses);
	} catch (_error) {
		// Ignore malformed legacy effect serialization and inspect other sources.
	}

	const result = new Set();
	for (const statuses of candidates) {
		if (!statuses) continue;
		if (typeof statuses === "string") {
			result.add(statuses);
			continue;
		}
		if (Array.isArray(statuses) || typeof statuses[Symbol.iterator] === "function") {
			for (const status of statuses) result.add(String(status));
		}
	}
	return [...result];
}

async function refreshRenderedTokenEffects(representations) {
	const uuids = new Set(
		representations
			.map((actor) => String(actor?.uuid ?? ""))
			.filter(Boolean),
	);
	if (uuids.size === 0) return;

	for (const token of canvas?.tokens?.placeables ?? []) {
		const tokenActorUuid = String(token?.actor?.uuid ?? "");
		if (!uuids.has(tokenActorUuid)) continue;

		/* drawEffects is a public Foundry v14 API. The render flag is also set so
		 * any queued canvas refresh uses the same corrected Actor effect state. */
		try {
			token.renderFlags?.set?.({
				redrawEffects: true,
				refreshEffects: true,
				refreshState: true,
			});
			await token.drawEffects?.();
		} catch (error) {
			console.warn(
				"WFRP1ED | Unable to refresh rendered Token effects after fatal rollback.",
				error,
			);
		}
	}
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

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
