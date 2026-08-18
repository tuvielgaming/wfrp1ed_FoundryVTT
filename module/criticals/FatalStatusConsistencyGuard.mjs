const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const FATAL_APPLICATIONS_FLAG_KEY = "fatalCriticalApplications";
const FATE_INTERVENTIONS_FLAG_KEY = "fateInterventions";
const KILLED_OUTCOME = "killed";
const SNAPSHOT_VERSION = 1;
const RECONCILE_DELAY_MS = 150;

const reconciliationTimers = new Map();

/**
 * Preserve the exact Foundry documents touched by a fatal Critical.
 *
 * Actor/token defeated status and Combatant.defeated are independent pieces of
 * state in Foundry v14. A fatal application therefore snapshots both layers
 * before death is imposed. Rollback/Fate restores that transaction snapshot
 * instead of guessing from an Actor's historical fatal records.
 */
Hooks.on("preUpdateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;

	const slot = changedFlagSlot(changes, FATAL_APPLICATIONS_FLAG_KEY);
	if (!slot || !isRecord(slot.value)) return;

	const previous = objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY);
	const incoming = foundry.utils.deepClone(slot.value);
	let changed = false;

	for (const [packetId, candidate] of Object.entries(incoming)) {
		if (!isRecord(candidate) || candidate.state !== "applied") continue;
		if (previous[packetId]?.state === "applied") continue;

		const actorDefeatedBefore = hasDefeatedStatus(actor);
		incoming[packetId] = {
			...foundry.utils.deepClone(candidate),
			defeatedBefore: actorDefeatedBefore,
			actorDefeatedBefore,
			combatantSnapshotVersion: SNAPSHOT_VERSION,
			combatantSnapshots: captureCombatantSnapshots(actor),
		};
		changed = true;
	}

	if (changed) slot.set(incoming);
});

Hooks.on("updateActor", (actor, changes) => {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!touchesExplicitFatalState(changes)) return;

	queueReconciliation(actor, releaseApplicationForChanges(actor, changes));
});

Hooks.once("ready", () => {
	if (!isStatusAuthority(null)) return;

	/* On startup only enforce genuinely active fatality. Historical reverted
	 * entries must never resurrect an old defeated baseline. */
	for (const actor of game.actors ?? []) {
		if (activeFatalApplications(actor).length > 0) {
			queueReconciliation(actor, null);
		}
	}
});

function queueReconciliation(actor, releaseApplication) {
	if (!isStatusAuthority(actor)) return;

	const key = String(actor.uuid ?? actor.id ?? "");
	if (!key) return;
	const existing = reconciliationTimers.get(key);
	if (existing) clearTimeout(existing);

	const application = isRecord(releaseApplication)
		? foundry.utils.deepClone(releaseApplication)
		: null;
	const timer = setTimeout(() => {
		reconciliationTimers.delete(key);
		void reconcileFatalDocuments(actor, application).catch((error) => {
			console.error("WFRP1ED | Unable to reconcile fatal Combatant state.", error);
		});
	}, RECONCILE_DELAY_MS);
	reconciliationTimers.set(key, timer);
}

async function reconcileFatalDocuments(actor, releaseApplication) {
	if (!(actor instanceof foundry.documents.Actor)) return;

	const active = activeFatalApplications(actor);
	if (active.length > 0) {
		await imposeActiveFatality(actor, active);
		return;
	}

	/* No live fatal transaction owns defeated state. Restore the transaction which
	 * was just released. If this is an old record without a v1 snapshot, use its
	 * original defeatedBefore value as a conservative compatibility fallback. */
	if (isRecord(releaseApplication)) {
		await restoreReleasedFatality(actor, releaseApplication);
	}
}

async function imposeActiveFatality(actor, applications) {
	await setActorDefeatedStatus(actor, true);

	let restoredExactDocuments = false;
	for (const application of applications) {
		const snapshots = validSnapshots(application);
		if (snapshots.length === 0) continue;
		restoredExactDocuments = true;
		await writeSnapshotCombatants(snapshots, () => true);
		await writeSnapshotTokenStatuses(snapshots, () => true);
	}

	/* Legacy fatal applications do not have exact snapshot IDs. */
	if (!restoredExactDocuments) {
		await writeMatchingCombatants(actor, true);
		await writeMatchingTokenStatuses(actor, true);
	}
}

async function restoreReleasedFatality(actor, application) {
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
		const baseline = application.actorDefeatedBefore === true ||
			application.defeatedBefore === true;
		await writeMatchingCombatants(actor, baseline);
		await writeMatchingTokenStatuses(actor, baseline);
	}

	const actorBaseline = application.actorDefeatedBefore !== undefined
		? application.actorDefeatedBefore === true
		: application.defeatedBefore === true;
	await setActorDefeatedStatus(actor, actorBaseline);
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

function releaseApplicationForChanges(actor, changes) {
	const fatalTouched = changedFlagSlot(changes, FATAL_APPLICATIONS_FLAG_KEY);
	if (fatalTouched) {
		const reverted = Object.values(objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY))
			.filter((application) => isRecord(application) && application.state === "reverted")
			.sort((left, right) =>
				(Number(right.revertedAt ?? 0) - Number(left.revertedAt ?? 0)) ||
				(Number(right.appliedAt ?? 0) - Number(left.appliedAt ?? 0)),
			);
		if (reverted[0]) return reverted[0];
	}

	const fateTouched = changedFlagSlot(changes, FATE_INTERVENTIONS_FLAG_KEY);
	if (fateTouched) {
		const intervention = Object.values(objectFlag(actor, FATE_INTERVENTIONS_FLAG_KEY))
			.filter(isRecord)
			.sort((left, right) => Number(right.spentAt ?? 0) - Number(left.spentAt ?? 0))[0];
		if (intervention) {
			return objectFlag(actor, FATAL_APPLICATIONS_FLAG_KEY)[String(intervention.packetId ?? "")] ?? null;
		}
	}

	return null;
}

function captureCombatantSnapshots(actor) {
	const snapshots = [];
	for (const combat of game.combats ?? []) {
		for (const combatant of matchingCombatants(combat, actor)) {
			snapshots.push({
				combatId: String(combat.id ?? ""),
				combatantId: String(combatant.id ?? ""),
				tokenId: String(combatant.tokenId ?? combatant.token?.id ?? ""),
				defeatedBefore: combatant.defeated === true,
				isDefeatedBefore: combatant.isDefeated === true,
				tokenActorUuid: String(combatant.actor?.uuid ?? ""),
				tokenActorDefeatedBefore: hasDefeatedStatus(combatant.actor),
			});
		}
	}
	return snapshots;
}

function validSnapshots(application) {
	return Array.isArray(application?.combatantSnapshots)
		? application.combatantSnapshots.filter((snapshot) =>
			isRecord(snapshot) && snapshot.combatId && snapshot.combatantId,
		)
		: [];
}

async function writeSnapshotCombatants(snapshots, desiredFor) {
	const byCombat = new Map();
	for (const snapshot of snapshots) {
		const combat = game.combats?.get?.(String(snapshot.combatId ?? ""));
		const combatant = combat?.combatants?.get?.(String(snapshot.combatantId ?? ""));
		if (!combat || !combatant) continue;

		const desired = Boolean(desiredFor(snapshot));
		if (combatant.defeated === desired) continue;
		if (!byCombat.has(combat.id)) byCombat.set(combat.id, { combat, updates: [] });
		byCombat.get(combat.id).updates.push({ _id: combatant.id, defeated: desired });
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
		const combatant = combat?.combatants?.get?.(String(snapshot.combatantId ?? ""));
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

	try {
		for (const combatant of combat?.getCombatantsByActor?.(actor) ?? []) add(combatant);
	} catch (_error) {
		// Fall through to explicit identity matching.
	}

	const tokenId = String(actor?.token?.id ?? "");
	if (tokenId) {
		try {
			for (const combatant of combat?.getCombatantsByToken?.(tokenId) ?? []) add(combatant);
		} catch (_error) {
			// Fall through to explicit identity matching.
		}
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
	if (tokenId && String(combatant.tokenId ?? combatant.token?.id ?? "") === tokenId) return true;

	const actorId = String(actor.id ?? "");
	if (!actorId) return false;
	return Boolean(
		String(combatant.actor?.id ?? "") === actorId ||
		String(combatant.actorId ?? "") === actorId ||
		String(combatant.token?.actorId ?? "") === actorId
	);
}

async function setActorDefeatedStatus(actor, active) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	const statusId = defeatedStatusId();
	if (!statusId) return;
	const desired = Boolean(active);
	if (hasDefeatedStatus(actor) === desired) return;
	await actor.toggleStatusEffect(statusId, { active: desired, overlay: true });
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
			typeof id === "string" && configured[id]
		) return id;
	}
	for (const fallback of ["dead", "defeated"]) {
		if (configured[fallback]) return fallback;
	}
	return null;
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

function changedFlagSlot(changes, key) {
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

function touchesExplicitFatalState(changes) {
	return Boolean(
		changedFlagSlot(changes, FATAL_APPLICATIONS_FLAG_KEY) ||
		changedFlagSlot(changes, FATE_INTERVENTIONS_FLAG_KEY)
	);
}

function objectFlag(actor, key) {
	const value = actor?.getFlag?.(FLAG_SCOPE, key);
	return isRecord(value) ? value : {};
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
