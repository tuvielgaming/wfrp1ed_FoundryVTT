const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";
const FINAL_RECONCILE_DELAY_MS = 250;

const pending = new Map();

/*
 * Final defeated-state consistency pass for fatal Critical transactions.
 *
 * IMPORTANT LIFECYCLE BOUNDARY
 * ----------------------------
 * Resolving a Sudden Death table result is NOT the same operation as applying
 * that fatal result. A damageApplications update may therefore say that the
 * resolved outcome is `killed` while the Actor must still remain alive until an
 * authorized user presses Apply Fatal Critical.
 *
 * Only these Actor-side transactions own Foundry's Defeated state:
 * - fatalCriticalApplications: explicit Apply/Revert Fatal Critical;
 * - fateInterventions: explicit Fate transaction which averts applied death.
 *
 * damageApplications is consulted to validate whether an already-applied fatal
 * application is still active, but a damageApplications update never triggers a
 * defeated-state write by itself.
 *
 * Foundry v14 represents visible defeated state through status ActiveEffects on
 * Actor/Token Actors and, independently, Combatant.defeated. This module repairs
 * both and explicitly refreshes rendered Token effects after document changes.
 */
Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;
	if (!fatalBoundaryTouched(changes)) return;
	queueReconcile(actor, "fatal-boundary");
});

/*
 * Startup enforcement is deliberately limited to currently ACTIVE fatal
 * applications. Historical reverted results must never change an Actor's state
 * merely because the World loaded.
 */
Hooks.once("ready", () => {
	if (!isStatusAuthority(null)) return;

	const actors = new Map();
	const add = (actor) => {
		if (!(actor instanceof foundry.documents.Actor)) return;
		const damageMap = objectFlag(actor, DAMAGE_APPLICATIONS_FLAG_KEY);
		const fatalMap = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY);
		const fateMap = objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY);
		if (activeFatalApplications(damageMap, fatalMap, fateMap).length === 0) {
			return;
		}
		const key = String(actor.uuid ?? actor.id ?? "");
		if (key) actors.set(key, actor);
	};

	for (const actor of game.actors ?? []) add(actor);
	for (const scene of game.scenes ?? []) {
		for (const token of scene?.tokens ?? []) add(token?.actor);
	}

	for (const actor of actors.values()) {
		queueReconcile(actor, "ready-active-fatal");
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

	/*
	 * We only reach this branch after an explicit fatal/fate Actor transaction.
	 * Restore the exact most recently released fatal application's pre-application
	 * state. Merely resolving a table never reaches this code.
	 */
	const release = latestReleasedFatalApplication(fatalMap, fateMap);
	if (!release) return;

	const desired = baselineDefeated(release);
	await setDefeatedEverywhere(actor, desired);

	/* Close a possible render/update race with older fatal adapters without
	 * changing the transaction-derived desired state. */
	await delay(75);
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

function latestReleasedFatalApplication(fatalMap, fateMap) {
	const candidates = [];

	for (const [packetId, application] of Object.entries(fatalMap)) {
		if (!isRecord(application)) continue;
		if (application.state !== "reverted") continue;
		candidates.push({
			application: {
				...foundry.utils.deepClone(application),
				packetId: String(application.packetId ?? packetId),
			},
			at: Number(application.revertedAt ?? application.appliedAt ?? 0),
		});
	}

	for (const intervention of Object.values(fateMap)) {
		if (!isRecord(intervention)) continue;
		const packetId = String(intervention.packetId ?? "");
		const application = fatalMap[packetId];
		if (!isRecord(application)) continue;
		candidates.push({
			application: {
				...foundry.utils.deepClone(application),
				packetId,
			},
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

	if (actor.statuses?.has?.(statusId)) {
		await actor.toggleStatusEffect(statusId, {
			active: false,
			overlay: true,
		});
	}

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
		// Ignore malformed legacy serialization and inspect the other sources.
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

		try {
			token.renderFlags?.set?.({
				redrawEffects: true,
				refreshEffects: true,
				refreshState: true,
			});
			await token.drawEffects?.();
		} catch (error) {
			console.warn(
				"WFRP1ED | Unable to refresh rendered Token effects after fatal state change.",
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

function baselineDefeated(application) {
	if (application?.actorDefeatedBefore !== undefined) {
		return application.actorDefeatedBefore === true;
	}
	return application?.defeatedBefore === true;
}

function fatalBoundaryTouched(changes) {
	return [
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
