const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";
const TOKEN_SNAPSHOT_VERSION = 1;
const FINALIZE_DELAY_MS = 350;

const pendingFinalizers = new Map();

/*
 * Complement FatalStatusTransactionIntegration with exact Scene-token state.
 *
 * FatalStatusTransactionIntegration already snapshots the Actor and Combatants,
 * but a Token does not have to be in Combat. A fatal Sudden Death can therefore
 * put Foundry's Defeated status on a normal Scene token which the Combatant-only
 * snapshot cannot later find during invalidation. This integration owns only
 * that missing Scene-token boundary:
 * - before a new fatal application, snapshot every Scene token actually
 *   represented by the target Actor;
 * - after apply, keep those token Actors defeated;
 * - after fatal invalidation or Fate intervention, restore each exact token to
 *   its pre-fatal status instead of blindly clearing a status which may have
 *   existed before the critical.
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
		void finalizeSceneTokenState(actor, release).catch((error) => {
			console.error(
				"WFRP1ED | Unable to finalize fatal Scene-token status.",
				error,
			);
		});
	}, FINALIZE_DELAY_MS);
	pendingFinalizers.set(key, timer);
}

async function finalizeSceneTokenState(actor, releaseApplication) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isStatusAuthority(actor)) return;

	const active = activeFatalApplications(actor);
	if (active.length > 0) {
		let hadExactSnapshot = false;
		for (const application of active) {
			const snapshots = validTokenSnapshots(application);
			if (snapshots.length === 0) continue;
			hadExactSnapshot = true;
			await writeSnapshotTokenStatuses(snapshots, () => true);
		}
		if (!hadExactSnapshot) {
			await writeRepresentedTokenStatuses(actor, true);
		}
		return;
	}

	if (!isRecord(releaseApplication)) return;
	const snapshots = validTokenSnapshots(releaseApplication);
	if (snapshots.length > 0) {
		await writeSnapshotTokenStatuses(
			snapshots,
			(snapshot) => snapshot.defeatedBefore === true,
		);
		return;
	}

	/* Legacy fallback for applications created before token snapshots existed.
	 * This path runs only at the transaction boundary that is changing now. */
	await writeRepresentedTokenStatuses(
		actor,
		actorBaseline(releaseApplication),
	);
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

	/* Synthetic Token Actors are local to one unlinked Token. Never affect other
	 * unlinked copies which happen to use the same base Actor id. */
	if (actor?.token) {
		add(actor.token);
		return [...tokens.values()];
	}

	/* A world Actor represents its linked Tokens. Their status is shared through
	 * the Actor, but recording the exact Scene/Token identity makes rollback
	 * deterministic and also covers Foundry token-status synchronization. */
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
