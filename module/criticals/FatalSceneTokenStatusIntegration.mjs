const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";
const TOKEN_SNAPSHOT_VERSION = 2;
const FINALIZE_DELAY_MS = 350;

const pendingFinalizers = new Map();

/*
 * Transaction-local defeated-state reconciliation for fatal Criticals.
 *
 * FatalStatusTransactionIntegration historically covered the world Actor and
 * Combatants. Scene Tokens which are not represented by a Combatant can still
 * carry the Defeated status, so this module snapshots exact Scene/Token state as
 * well and provides one explicit reconciliation function for transaction
 * boundaries such as Sudden Death invalidation.
 *
 * Important design rule: invalidation must not rely only on a later render or a
 * delayed updateActor hook. The code which reverts the fatal transaction can call
 * reconcileFatalStatusAfterBoundary() immediately with the exact application it
 * just reverted. Hooks remain as a safety net for Fate and other callers.
 */
Hooks.on("preUpdateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;

	const slot = changedFlagMapSlot(changes, FATAL_APPLICATIONS_FLAG_KEY);
	if (!slot || !isRecord(slot.value)) return;

	const previous = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY);
	const incoming = foundry.utils.deepClone(slot.value);
	let changed = false;

	for (const [packetId, application] of Object.entries(incoming)) {
		if (!isRecord(application) || application.state !== "applied") continue;
		if (previous[packetId]?.state === "applied") continue;

		incoming[packetId] = {
			...foundry.utils.deepClone(application),
			tokenStatusSnapshotVersion: TOKEN_SNAPSHOT_VERSION,
			tokenStatusSnapshots: captureRepresentedTokenSnapshots(actor),
		};
		changed = true;
	}

	if (changed) slot.set(incoming);
});

Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;

	const fatalTouched = touchesFlag(changes, FATAL_APPLICATIONS_FLAG_KEY);
	const fateTouched = touchesFlag(changes, FATE_INTERVENTIONS_FLAG_KEY);
	if (!fatalTouched && !fateTouched) return;

	const release = fatalTouched
		? latestRevertedFatal(actor)
		: fatalForLatestFateIntervention(actor);
	queueFinalization(actor, release);
});

function queueFinalization(actor, releaseApplication) {
	const key = String(actor.uuid ?? actor.id ?? "");
	if (!key) return;

	const existing = pendingFinalizers.get(key);
	if (existing) clearTimeout(existing);

	const release = isRecord(releaseApplication)
		? foundry.utils.deepClone(releaseApplication)
		: null;

	const timer = setTimeout(() => {
		pendingFinalizers.delete(key);
		void reconcileFatalStatusAfterBoundary(actor, release).catch((error) => {
			console.error(
				"WFRP1ED | Unable to finalize fatal defeated status.",
				error,
			);
		});
	}, FINALIZE_DELAY_MS);
	pendingFinalizers.set(key, timer);
}

/**
 * Reconcile every Foundry representation owned by the fatal subsystem after an
 * apply/revert/Fate boundary.
 *
 * @param {Actor} actor Target Actor or synthetic Token Actor.
 * @param {Object|null} releaseApplication The fatal application whose effect was
 * removed. Passing it explicitly is preferred because it preserves the exact
 * pre-fatal snapshot even when the Actor has older fatal history.
 */
export async function reconcileFatalStatusAfterBoundary(
	actor,
	releaseApplication = null,
) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;

	const active = activeFatalApplications(actor);
	if (active.length > 0) {
		await imposeFatalState(actor, active);
		return;
	}

	const release = isRecord(releaseApplication)
		? releaseApplication
		: latestRevertedFatal(actor);
	if (!isRecord(release)) return;

	await restoreFatalState(actor, release);
}

async function imposeFatalState(actor, applications) {
	await setActorDefeatedStatus(actor, true);

	let hadTokenSnapshot = false;
	let hadCombatantSnapshot = false;

	for (const application of applications) {
		const tokenSnapshots = validTokenSnapshots(application);
		if (tokenSnapshots.length > 0) {
			hadTokenSnapshot = true;
			await writeSnapshotTokenStatuses(tokenSnapshots, () => true);
		}

		const combatantSnapshots = validCombatantSnapshots(application);
		if (combatantSnapshots.length > 0) {
			hadCombatantSnapshot = true;
			await writeSnapshotCombatantStates(combatantSnapshots, () => true);
			await writeSnapshotCombatantTokenStatuses(combatantSnapshots, () => true);
		}
	}

	if (!hadTokenSnapshot) {
		await writeRepresentedTokenStatuses(actor, true);
	}
	if (!hadCombatantSnapshot) {
		await writeMatchingCombatants(actor, true);
	}
}

async function restoreFatalState(actor, application) {
	const baseline = actorBaseline(application);
	const tokenSnapshots = validTokenSnapshots(application);
	const combatantSnapshots = validCombatantSnapshots(application);

	/* Restore the exact embedded/synthetic representations first. */
	if (combatantSnapshots.length > 0) {
		await writeSnapshotCombatantStates(
			combatantSnapshots,
			(snapshot) => snapshot.defeatedBefore === true,
		);
		await writeSnapshotCombatantTokenStatuses(
			combatantSnapshots,
			(snapshot) => snapshot.tokenActorDefeatedBefore === true,
		);
	} else {
		await writeMatchingCombatants(actor, baseline);
	}

	if (tokenSnapshots.length > 0) {
		await writeSnapshotTokenStatuses(
			tokenSnapshots,
			(snapshot) => snapshot.defeatedBefore === true,
		);
	} else {
		/* Legacy/current safety fallback. If an older fatal application has no exact
		 * Scene-token snapshot, repair every token presently represented by this
		 * Actor at the same explicit rollback boundary. */
		await writeRepresentedTokenStatuses(actor, baseline);
	}

	await setActorDefeatedStatus(actor, baseline);
}

function captureRepresentedTokenSnapshots(actor) {
	return representedTokenDocuments(actor).map((token) => {
		const tokenActor = token?.actor;
		return {
			sceneId: String(token?.parent?.id ?? token?.scene?.id ?? ""),
			tokenId: String(token?.id ?? ""),
			tokenActorUuid: String(tokenActor?.uuid ?? ""),
			defeatedBefore: hasDefeatedStatus(tokenActor),
		};
	});
}

function representedTokenDocuments(actor) {
	const tokens = new Map();
	const add = (token) => {
		const sceneId = String(token?.parent?.id ?? token?.scene?.id ?? "");
		const tokenId = String(token?.id ?? "");
		if (!sceneId || !tokenId) return;
		tokens.set(`${sceneId}:${tokenId}`, token);
	};

	/* Synthetic Token Actors are local to one unlinked Token. */
	if (actor?.token) {
		add(actor.token);
		return [...tokens.values()];
	}

	/* A world Actor represents linked Tokens only. Do not touch unrelated unlinked
	 * copies which merely share the same base actorId. */
	for (const scene of game.scenes ?? []) {
		for (const token of scene?.tokens ?? []) {
			if (token?.actorLink !== true) continue;
			if (
				token?.actor === actor ||
				String(token?.actorId ?? "") === String(actor.id ?? "")
			) add(token);
		}
	}

	return [...tokens.values()];
}

async function writeSnapshotTokenStatuses(snapshots, desiredFor) {
	const visited = new Set();

	for (const snapshot of snapshots) {
		const tokenActor = tokenActorFromSnapshot(snapshot);
		if (!(tokenActor instanceof foundry.documents.Actor)) continue;

		const key = String(tokenActor.uuid ?? tokenActor.id ?? "");
		if (!key || visited.has(key)) continue;
		visited.add(key);

		await setActorDefeatedStatus(tokenActor, Boolean(desiredFor(snapshot)));
	}
}

async function writeRepresentedTokenStatuses(actor, active) {
	const visited = new Set();
	for (const token of representedTokenDocuments(actor)) {
		const tokenActor = token?.actor;
		if (!(tokenActor instanceof foundry.documents.Actor)) continue;

		const key = String(tokenActor.uuid ?? tokenActor.id ?? "");
		if (!key || visited.has(key)) continue;
		visited.add(key);

		await setActorDefeatedStatus(tokenActor, active);
	}
}

async function writeSnapshotCombatantStates(snapshots, desiredFor) {
	const byCombat = new Map();

	for (const snapshot of snapshots) {
		const combat = game.combats?.get?.(String(snapshot?.combatId ?? ""));
		const combatant = combat?.combatants?.get?.(
			String(snapshot?.combatantId ?? ""),
		);
		if (!combat || !combatant) continue;

		const desired = Boolean(desiredFor(snapshot));
		if (combatant.defeated === desired) continue;

		if (!byCombat.has(combat.id)) {
			byCombat.set(combat.id, { combat, updates: [] });
		}
		byCombat.get(combat.id).updates.push({
			_id: combatant.id,
			defeated: desired,
		});
	}

	for (const { combat, updates } of byCombat.values()) {
		if (updates.length > 0) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}
}

async function writeSnapshotCombatantTokenStatuses(snapshots, desiredFor) {
	const visited = new Set();

	for (const snapshot of snapshots) {
		const tokenActor = actorFromUuidSync(snapshot?.tokenActorUuid);
		if (!(tokenActor instanceof foundry.documents.Actor)) continue;

		const key = String(tokenActor.uuid ?? tokenActor.id ?? "");
		if (!key || visited.has(key)) continue;
		visited.add(key);

		await setActorDefeatedStatus(tokenActor, Boolean(desiredFor(snapshot)));
	}
}

async function writeMatchingCombatants(actor, active) {
	const desired = Boolean(active);
	for (const combat of game.combats ?? []) {
		const updates = matchingCombatants(combat, actor)
			.filter((combatant) => combatant.defeated !== desired)
			.map((combatant) => ({ _id: combatant.id, defeated: desired }));
		if (updates.length > 0) {
			await combat.updateEmbeddedDocuments("Combatant", updates);
		}
	}
}

function matchingCombatants(combat, actor) {
	const matches = new Map();
	const add = (combatant) => {
		if (combatant?.id) matches.set(combatant.id, combatant);
	};

	const tokenId = String(actor?.token?.id ?? "");
	if (tokenId && typeof combat?.getCombatantsByToken === "function") {
		for (const combatant of combat.getCombatantsByToken(tokenId) ?? []) add(combatant);
	}
	if (!tokenId && typeof combat?.getCombatantsByActor === "function") {
		for (const combatant of combat.getCombatantsByActor(actor) ?? []) add(combatant);
	}
	for (const combatant of combat?.combatants ?? []) {
		if (combatantMatchesActor(combatant, actor)) add(combatant);
	}
	return [...matches.values()];
}

function combatantMatchesActor(combatant, actor) {
	if (!combatant || !actor) return false;
	if (combatant.actor === actor) return true;

	const actorUuid = String(actor.uuid ?? "");
	if (actorUuid && String(combatant.actor?.uuid ?? "") === actorUuid) return true;

	const tokenId = String(actor.token?.id ?? "");
	if (tokenId) {
		return String(combatant.tokenId ?? combatant.token?.id ?? "") === tokenId;
	}

	const actorId = String(actor.id ?? "");
	if (!actorId) return false;
	return Boolean(
		String(combatant.actor?.id ?? "") === actorId ||
		String(combatant.actorId ?? "") === actorId ||
		String(combatant.token?.actorId ?? "") === actorId
	);
}

function tokenActorFromSnapshot(snapshot) {
	const scene = game.scenes?.get?.(String(snapshot?.sceneId ?? ""));
	const token = scene?.tokens?.get?.(String(snapshot?.tokenId ?? ""));
	if (token?.actor instanceof foundry.documents.Actor) return token.actor;
	return actorFromUuidSync(snapshot?.tokenActorUuid);
}

function validTokenSnapshots(application) {
	return Array.isArray(application?.tokenStatusSnapshots)
		? application.tokenStatusSnapshots.filter(
			(snapshot) =>
				isRecord(snapshot) &&
				(snapshot.tokenActorUuid || (snapshot.sceneId && snapshot.tokenId)),
		)
		: [];
}

function validCombatantSnapshots(application) {
	return Array.isArray(application?.combatantSnapshots)
		? application.combatantSnapshots.filter(
			(snapshot) =>
				isRecord(snapshot) && snapshot.combatId && snapshot.combatantId,
		)
		: [];
}

function activeFatalApplications(actor) {
	const fatalMap = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY);
	const damageMap = objectFlag(actor, DAMAGE_APPLICATIONS_FLAG_KEY);
	const fateMap = objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY);

	return Object.values(fatalMap).filter((application) => {
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

function latestRevertedFatal(actor) {
	return Object.values(objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY))
		.filter((application) => isRecord(application) && application.state === "reverted")
		.sort((left, right) =>
			(Number(right.revertedAt ?? 0) - Number(left.revertedAt ?? 0)) ||
			(Number(right.appliedAt ?? 0) - Number(left.appliedAt ?? 0)),
		)[0] ?? null;
}

function fatalForLatestFateIntervention(actor) {
	const intervention = Object.values(objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY))
		.filter(isRecord)
		.sort((left, right) =>
			Number(right.spentAt ?? 0) - Number(left.spentAt ?? 0),
		)[0];
	if (!intervention) return null;

	return objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY)[
		String(intervention.packetId ?? "")
	] ?? null;
}

function actorBaseline(application) {
	if (application?.actorDefeatedBefore !== undefined) {
		return application.actorDefeatedBefore === true;
	}
	return application?.defeatedBefore === true;
}

async function setActorDefeatedStatus(actor, active) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	const statusId = defeatedStatusId();
	if (!statusId) return;

	const desired = Boolean(active);
	if (hasDefeatedStatus(actor) === desired) return;

	await actor.toggleStatusEffect(statusId, {
		active: desired,
		overlay: true,
	});
}

function hasDefeatedStatus(actor) {
	const statusId = defeatedStatusId();
	return Boolean(statusId && actor?.statuses?.has?.(statusId));
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

function changedFlagMapSlot(changes, key) {
	if (!changes || typeof changes !== "object") return null;
	const path = `flags.${FLAG_SCOPE}.${key}`;

	if (Object.hasOwn(changes, path)) {
		return {
			value: changes[path],
			set: (value) => { changes[path] = value; },
		};
	}

	const value = foundry.utils.getProperty(changes, path);
	if (value === undefined) return null;
	return {
		value,
		set: (next) => foundry.utils.setProperty(changes, path, next),
	};
}

function touchesFlag(changes, key) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${key}`;
	if (Object.hasOwn(changes, path)) return true;
	if (foundry.utils.getProperty(changes, path) !== undefined) return true;

	const flattened = foundry.utils.flattenObject?.(changes) ?? changes;
	return Object.keys(flattened).some(
		(candidate) => candidate === path || candidate.startsWith(`${path}.`),
	);
}

function objectFlag(actor, key) {
	const value = actor?.getFlag?.(FLAG_SCOPE, key);
	return isRecord(value) ? value : {};
}

function actorFromUuidSync(uuid) {
	const id = String(uuid ?? "").trim();
	if (!id) return null;
	try {
		const document = foundry.utils.fromUuidSync(id);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
