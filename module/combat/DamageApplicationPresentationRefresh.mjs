import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
const DAMAGE_FLAG_KEY = "damageState";
let refreshQueued = false;
const mirrorRunning = new Set();

/**
 * DamageApplication is Actor-authoritative. An Actor OWNER may therefore apply
 * damage without permission to rewrite the originating attack ChatMessage.
 *
 * Every client receives the resulting Actor update. Use that authoritative
 * broadcast as the presentation refresh signal so dedicated Damage cards and
 * their source Attack/Defence cards update together.
 *
 * The primary GM additionally mirrors the authoritative Actor transaction into
 * every damage-bearing ChatMessage. This is important for players who may not
 * have access to the target Actor document itself (for example an attacker who
 * does not own an NPC target): transaction-closed presentation must still be
 * identical for GM and players. Damage invalidation mirrors the reverted state
 * through the same path and therefore re-opens the Test inputs everywhere.
 */
Hooks.once("ready", () => {
	if (!isPrimaryActiveGM()) return;
	void repairMirroredApplications().catch((error) => {
		console.error(
			"WFRP1ED | Unable to repair mirrored damage transaction state.",
			error,
		);
	});
});

Hooks.on("updateActor", (actor, changes) => {
	if (!damageApplicationsChanged(changes)) return;

	requestChatRefresh();
	if (!isPrimaryActiveGM()) return;
	void mirrorDamageApplications(actor).catch((error) => {
		console.error(
			"WFRP1ED | Unable to mirror damage transaction into ChatMessages.",
			error,
		);
	});
});

async function repairMirroredApplications() {
	for (const actor of game.actors ?? []) {
		if (!hasDamageApplications(actor)) continue;
		await mirrorDamageApplications(actor);
	}
}

async function mirrorDamageApplications(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	const actorKey = String(actor.uuid ?? actor.id ?? "");
	if (!actorKey || mirrorRunning.has(actorKey)) return;

	mirrorRunning.add(actorKey);
	try {
		for (const message of game.messages ?? []) {
			const state = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
			if (!state?.packet?.id) continue;
			if (String(state.packet.targetActorUuid ?? "") !== actor.uuid) continue;
			if (!message.canUserModify?.(game.user, "update")) continue;

			const transaction = DamageApplication.transactionFor(
				actor,
				state.packet.id,
			);
			if (sameSnapshot(state.application ?? null, transaction ?? null)) continue;

			const updated = foundry.utils.deepClone(state);
			updated.application = transaction
				? foundry.utils.deepClone(transaction)
				: null;
			updated.updatedBy = game.user?.id ?? "";
			updated.updatedAt = Date.now();

			await message.update({
				[`flags.${FLAG_SCOPE}.${DAMAGE_FLAG_KEY}`]: updated,
			});
		}
	} finally {
		mirrorRunning.delete(actorKey);
		requestChatRefresh();
	}
}

function hasDamageApplications(actor) {
	const applications = actor?.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_APPLICATIONS_FLAG_KEY,
	);
	return Boolean(
		applications &&
		typeof applications === "object" &&
		!Array.isArray(applications) &&
		Object.keys(applications).length,
	);
}

function damageApplicationsChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function sameSnapshot(left, right) {
	try {
		return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
	} catch (_error) {
		return false;
	}
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(game.user?.isGM && primaryActiveGM()?.id === game.user.id);
}

function requestChatRefresh() {
	if (refreshQueued) return;
	refreshQueued = true;
	requestAnimationFrame(() => {
		setTimeout(() => {
			refreshQueued = false;
			void ui.chat?.render?.({ force: true });
		}, 0);
	});
}
