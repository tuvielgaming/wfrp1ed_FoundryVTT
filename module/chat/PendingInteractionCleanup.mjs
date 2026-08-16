import { DamageApplication } from "../damage/DamageApplication.mjs";
import { WfrpRuleSettings } from "../settings/WfrpRuleSettings.mjs";
import { CombatDefenceTransaction } from "../combat/CombatDefenceTransaction.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PENDING_STANDARD_TEST_FLAG_KEY = "pendingStandardTest";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_RESULT_FLAG_KEY = "combatDefenceResult";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_FLAG_KEY = "damageState";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const LIFECYCLE_FLAG_KEY = "pendingInteractionLifecycle";
const STALE_AFTER_ROUNDS = 2;
let cleanupRunning = false;

/**
 * Housekeeping for genuinely unfinished chat interactions.
 *
 * Resolved history is deliberately retained. In particular, a resolved positive
 * Damage result waiting for Apply Damage is not stale test input and is never
 * discarded automatically. We clean only Standard Test requests still waiting
 * for target data and combat attacks which have not yet reached a final Damage
 * result (including explicitly reverted damage which reopened the transaction).
 */
Hooks.once("ready", () => {
	if (!isPrimaryActiveGM()) return;
	installWorldShutdownCleanup();
	if (!WfrpRuleSettings.autoClearPendingTests()) return;
	void stampLegacyPendingInteractions().catch(reportCleanupError);
});

Hooks.on("createChatMessage", (message) => {
	if (!isPrimaryActiveGM() || !WfrpRuleSettings.autoClearPendingTests()) return;
	if (!isPendingStandardTest(message)) return;
	void ensureLifecycleStamp(message).catch(reportCleanupError);
});

Hooks.on("updateChatMessage", (message) => {
	if (!isPrimaryActiveGM() || !WfrpRuleSettings.autoClearPendingTests()) return;
	if (!isOpenCombatInteraction(message)) return;
	void ensureLifecycleStamp(message).catch(reportCleanupError);
});

/*
 * Foundry v14 dispatches combatTurnChange on every client after the Combat
 * database update. Only the primary active GM performs deletion.
 */
Hooks.on("combatTurnChange", (combat, prior, current) => {
	if (!isPrimaryActiveGM() || !WfrpRuleSettings.autoClearPendingTests()) return;
	const previousRound = positiveRound(prior?.round);
	const currentRound = positiveRound(current?.round);
	if (!previousRound || !currentRound || currentRound <= previousRound) return;
	void cleanupStaleForCombat(combat, currentRound).catch(reportCleanupError);
});

async function stampLegacyPendingInteractions() {
	for (const message of game.messages ?? []) {
		if (!isPendingStandardTest(message) && !isOpenCombatInteraction(message)) continue;
		await ensureLifecycleStamp(message);
	}
}

async function ensureLifecycleStamp(message) {
	if (!message?.id || message.getFlag?.(FLAG_SCOPE, LIFECYCLE_FLAG_KEY)) return;
	if (!message.canUserModify?.(game.user, "update")) return;

	const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const attackLifecycle = normalizeLifecycle(attack?.lifecycle);
	const current = currentCombatLifecycle();
	const lifecycle = attackLifecycle ?? current;
	if (!lifecycle) return;

	await message.setFlag(FLAG_SCOPE, LIFECYCLE_FLAG_KEY, {
		version: 1,
		combatId: lifecycle.combatId,
		round: lifecycle.round,
		stampedAt: Date.now(),
	});
}

async function cleanupStaleForCombat(combat, currentRound) {
	if (cleanupRunning || !combat?.id) return;
	cleanupRunning = true;
	try {
		const stale = [];
		for (const message of game.messages ?? []) {
			if (!isPendingStandardTest(message) && !isOpenCombatInteraction(message)) continue;
			const lifecycle = lifecycleFor(message);
			if (!lifecycle || lifecycle.combatId !== String(combat.id)) continue;
			if ((currentRound - lifecycle.round) < STALE_AFTER_ROUNDS) continue;
			stale.push(message);
		}
		await deletePendingRoots(stale, "stale-round");
	} finally {
		cleanupRunning = false;
	}
}

async function cleanupAllPendingForShutdown() {
	if (cleanupRunning || !WfrpRuleSettings.autoClearPendingTests()) return;
	cleanupRunning = true;
	try {
		const pending = [...(game.messages ?? [])].filter((message) =>
			isPendingStandardTest(message) || isOpenCombatInteraction(message),
		);
		await deletePendingRoots(pending, "world-shutdown");
	} finally {
		cleanupRunning = false;
	}
}

async function deletePendingRoots(messages, reason) {
	const ids = new Set();
	for (const message of messages) {
		if (!message?.id) continue;
		if (isPendingStandardTest(message)) {
			ids.add(String(message.id));
			continue;
		}
		if (!isOpenCombatInteraction(message)) continue;
		for (const id of linkedCombatFamilyIds(message.id)) ids.add(id);
	}

	const deletable = [...ids]
		.map((id) => game.messages?.get(id))
		.filter((message) => message?.canUserModify?.(game.user, "delete"));
	if (!deletable.length) return;

	/* Delete derived/child cards before their source attack for clean hooks. */
	deletable.sort((left, right) =>
		Number(Boolean(left.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY))) -
		Number(Boolean(right.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY))),
	);
	for (const message of deletable) await message.delete();

	console.info(
		`WFRP1ED | Cleared ${deletable.length} abandoned pending ChatMessage(s) (${reason}).`,
	);
}

function linkedCombatFamilyIds(sourceAttackMessageId) {
	const sourceId = String(sourceAttackMessageId ?? "");
	const ids = new Set(sourceId ? [sourceId] : []);
	if (!sourceId) return ids;

	for (const message of game.messages ?? []) {
		const defence = message.getFlag?.(FLAG_SCOPE, DEFENCE_RESULT_FLAG_KEY);
		if (String(defence?.attackMessageId ?? "") === sourceId) {
			ids.add(String(message.id));
		}

		const additional = message.getFlag?.(FLAG_SCOPE, ADDITIONAL_DAMAGE_FLAG_KEY);
		if (String(additional?.attackMessageId ?? "") === sourceId) {
			ids.add(String(message.id));
		}

		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		if (String(view?.sourceAttackMessageId ?? "") === sourceId) {
			ids.add(String(message.id));
		}
	}
	return ids;
}

function isPendingStandardTest(message) {
	const pending = message?.getFlag?.(FLAG_SCOPE, PENDING_STANDARD_TEST_FLAG_KEY);
	return pending?.status === "pending";
}

function isOpenCombatInteraction(message) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (!attack || attack.family !== "melee" || attack.targetMode !== "defender") {
		return false;
	}

	const outcome = CombatDefenceTransaction.outcomeForAttack(message);
	if (!outcome) return true;
	if (!outcome.attackHit) return false;
	if (outcome.defenceStatus !== "resolved") return true;
	if (outcome.dodgeSucceeded || !outcome.continueToDamage) return false;

	const damage = message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!damage?.packet?.id) return true;

	const actor = actorFromUuidSync(damage.packet.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, damage.packet.id)
		: damage.application ?? null;

	/* Explicit invalidation reopens the transaction and therefore makes it pending. */
	if (transaction?.state === "reverted") return true;

	/*
	 * Any complete DamagePacket is already a resolved result. Positive damage may
	 * still await Apply Damage, but deleting it automatically would lose a valid
	 * hit rather than clean an abandoned Test, so it is intentionally retained.
	 */
	return false;
}

function lifecycleFor(message) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	return normalizeLifecycle(attack?.lifecycle) ??
		normalizeLifecycle(message?.getFlag?.(FLAG_SCOPE, LIFECYCLE_FLAG_KEY));
}

function currentCombatLifecycle() {
	const combat = game.combat;
	if (!combat?.started) return null;
	const round = positiveRound(combat.round);
	if (!round) return null;
	return { combatId: String(combat.id ?? ""), round };
}

function normalizeLifecycle(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const combatId = String(value.combatId ?? "").trim();
	const round = positiveRound(value.round);
	return combatId && round ? { combatId, round } : null;
}

/**
 * Foundry exposes public Game.shutDown(), but v14 has no corresponding system
 * hook in the documented hook list. Wrap the public method narrowly so a normal
 * GM world shutdown can clean unfinished interactions before the server closes.
 * Browser/tab termination is intentionally not used because asynchronous World
 * document deletion is not reliable during beforeunload.
 */
function installWorldShutdownCleanup() {
	const prototype = Object.getPrototypeOf(game);
	if (!prototype || prototype.__wfrpPendingCleanupInstalled === true) return;
	const original = prototype.shutDown;
	if (typeof original !== "function") return;

	prototype.shutDown = async function wfrpShutdownWithPendingCleanup(...args) {
		if (this === game && game.user?.isGM && WfrpRuleSettings.autoClearPendingTests()) {
			try {
				await cleanupAllPendingForShutdown();
			} catch (error) {
				reportCleanupError(error);
			}
		}
		return original.apply(this, args);
	};

	Object.defineProperty(
		prototype,
		"__wfrpPendingCleanupInstalled",
		{ value: true, configurable: false, enumerable: false },
	);
}

function positiveRound(value) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : null;
}

function actorFromUuidSync(uuid) {
	const value = String(uuid ?? "").trim();
	if (!value) return null;
	try {
		const document = foundry.utils.fromUuidSync(value);
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function primaryActiveGM() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(game.user?.isGM && primaryActiveGM()?.id === game.user.id);
}

function reportCleanupError(error) {
	console.error("WFRP1ED | Unable to clean pending chat interactions.", error);
}
