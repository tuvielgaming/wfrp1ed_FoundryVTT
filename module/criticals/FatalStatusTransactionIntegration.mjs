const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";
const SNAPSHOT_VERSION = 2;
const FINALIZE_DELAY_MS = 250;

const pendingFinalizers = new Map();

/**
 * Transaction-local owner for Foundry's defeated state.
 *
 * The older fatal implementation can still derive "defeated" while an active
 * fatal Critical exists, but rollback must never derive an Actor's living state
 * from some older fatal record. This integration snapshots the exact Actor,
 * Token Actor and Combatant state before a newly-applied fatal result and makes
 * the just-changed transaction the final authority after apply/revert/Fate.
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

		const snapshot = captureFatalSnapshot(actor);
		incoming[packetId] = {
			...foundry.utils.deepClone(application),
			...snapshot,
			version: Math.max(Number(application.version) || 1, SNAPSHOT_VERSION),
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

Hooks.once("ready", () => {
	if (!isStatusAuthority(null)) return;

	for (const actor of game.actors ?? []) {
		const active = activeFatalApplications(actor);
		if (active.length > 0) queueFinalization(actor, null);
	}
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
		void finalizeFatalState(actor, release).catch((error) => {
			console.error("WFRP1ED | Unable to finalize fatal transaction status.", error);
		});
	}, FINALIZE_DELAY_MS);
	pendingFinalizers.set(key, timer);
}

async function finalizeFatalState(actor, releaseApplication) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;

	const active = activeFatalApplications(actor);
	if (active.length > 0) {
		await imposeFatalState(actor, active);
		return;
	}

	if (isRecord(releaseApplication)) {
		await restoreFatalState(actor, releaseApplication);
	}
}

async function imposeFatalState(actor, applications) {
	await setActorDefeatedStatus(actor, true);

	let hadExactSnapshot = false;
	for (const application of applications) {
		const snapshots = validSnapshots(application);
		if (snapshots.length === 0) continue;
		hadExactSnapshot = true;
		await writeSnapshotCombatants(snapshots, () => true);
		await writeSnapshotTokenStatuses(snapshots, () => true);
	}

	if (!hadExactSnapshot) {
		await writeMatchingCombatants(actor, true);
		await writeMatchingTokenStatuses(actor, true);
	}
}

async function restoreFatalState(actor, application) {
	const snapshots = validSnapshots(application);

	if (snapshots.length > 0) {
		await writeSnapshotCombatants(
			snapshots,
			(snapshot) => snapshot.defeatedBefore === true,
		);
		await writeSnapshotTokenStatuses(
			snapshots,
			(snapshot) => snapshot.tokenActorDefeatedBefore === true,
		);
	} else {
		const baseline = actorBaseline(application);
		await writeMatchingCombatants(actor, baseline);
		await writeMatchingTokenStatuses(actor, baseline);
	}

	await setActorDefeatedStatus(actor, actorBaseline(application));
}

function captureFatalSnapshot(actor) {
	const actorDefeatedBefore = hasDefeatedStatus(actor);
	const snapshots = [];

	for (const combat of game.combats ?? []) {
		for (const combatant of matchingCombatants(combat, actor)) {
			const tokenActor = combatant.actor;
			snapshots.push({
				combatId: String(combat.id ?? ""),
				combatantId: String(combatant.id ?? ""),
				tokenId: String(combatant.tokenId ?? combatant.token?.id ?? ""),
				defeatedBefore: combatant.defeated === true,
				tokenActorUuid: String(tokenActor?.uuid ?? ""),
				tokenActorDefeatedBefore: hasDefeatedStatus(tokenActor),
			});
		}
	}

	return {
		defeatedBefore: actorDefeatedBefore,
		actorDefeatedBefore,
		combatantSnapshotVersion: SNAPSHOT_VERSION,
		combatantSnapshots: snapshots,
	};
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

async function writeSnapshotCombatants(snapshots, desiredFor) {
	const byCombat = new Map();

	for (const snapshot of snapshots) {
		const combat = game.combats?.get?.(String(snapshot.combatId ?? ""));
		const combatant = combat?.combatants?.get?.(
			String(snapshot.combatantId ?? ""),
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

async function writeSnapshotTokenStatuses(snapshots, desiredFor) {
	const visited = new Set();

	for (const snapshot of snapshots) {
		const combat = game.combats?.get?.(String(snapshot.combatId ?? ""));
		const combatant = combat?.combatants?.get?.(
			String(snapshot.combatantId ?? ""),
		);
		const tokenActor = combatant?.actor ?? actorFromUuidSync(snapshot.tokenActorUuid);
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

async function writeMatchingTokenStatuses(actor, active) {
	const visited = new Set();

	for (const combat of game.combats ?? []) {
		for (const combatant of matchingCombatants(combat, actor)) {
			const tokenActor = combatant.actor;
			if (!(tokenActor instanceof foundry.documents.Actor)) continue;

			const key = String(tokenActor.uuid ?? tokenActor.id ?? "");
			if (!key || visited.has(key)) continue;
			visited.add(key);

			await setActorDefeatedStatus(tokenActor, active);
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

function validSnapshots(application) {
	return Array.isArray(application?.combatantSnapshots)
		? application.combatantSnapshots.filter(
			(snapshot) =>
				isRecord(snapshot) && snapshot.combatId && snapshot.combatantId,
		)
		: [];
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

function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
