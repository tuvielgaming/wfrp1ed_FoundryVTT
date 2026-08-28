import { CoreCastingFailureWorkflow } from "./CoreCastingFailureWorkflow.mjs";

const FLAG_SCOPE = "wfrp1ed";
const FIRE_BALL_CAST_FLAG = "fireBallCast";
const FIRE_BALL_IMPACT_FLAG = "fireBallImpactWorkflow";
const ACTOR_TEST_FLAG = "actorTestRequest";
const reconciling = new Set();

/**
 * Build an explicit message graph for one spell cast while the procedure is
 * executing. This is deliberately presentation-neutral: it does not hide or
 * merge any ChatMessage yet. It only replaces fragile chat-order inference with
 * persisted castId / castMessageId relationships, which the later grouped spell
 * presentation and retroactive adjudication can safely consume.
 */
Hooks.on("createChatMessage", (message) => {
	queueMicrotask(() => void reconcile(message).catch(reportError));
});
Hooks.on("updateChatMessage", (message) => {
	queueMicrotask(() => void reconcile(message).catch(reportError));
});

async function reconcile(message) {
	const messageId = String(message?.id ?? "").trim();
	if (!messageId || reconciling.has(messageId)) return;
	reconciling.add(messageId);
	try {
		if (await reconcileFireBallCast(message)) return;
		if (await reconcileFireBallImpact(message)) return;
		await reconcileFireBallFearRequest(message);
	} finally {
		reconciling.delete(messageId);
	}
}

async function reconcileFireBallCast(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, FIRE_BALL_CAST_FLAG);
	if (!state) return false;
	const context = state.castId
		? { castId: String(state.castId), castSummaryMessageId: String(message.id) }
		: CoreCastingFailureWorkflow.activeContext({
			actorUuid: state.casterUuid,
			spellUuid: state.spellUuid,
		});
	if (!context?.castId) return true;

	if (!state.castId) {
		const updated = foundry.utils.deepClone(state);
		updated.castId = context.castId;
		updated.version = Math.max(6, Number(updated.version) || 0);
		await message.setFlag(FLAG_SCOPE, FIRE_BALL_CAST_FLAG, updated);
	}
	await CoreCastingFailureWorkflow.registerLinkedMessage(
		context.castId,
		"cast-summary",
		message.id,
	);
	return true;
}

async function reconcileFireBallImpact(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, FIRE_BALL_IMPACT_FLAG);
	if (!state) return false;
	const context = state.castId
		? CoreCastingFailureWorkflow.activeContext({
			actorUuid: state.casterUuid,
			spellUuid: state.spellUuid,
		}) ?? { castId: String(state.castId), castSummaryMessageId: state.castMessageId ?? null }
		: CoreCastingFailureWorkflow.activeContext({
			actorUuid: state.casterUuid,
			spellUuid: state.spellUuid,
		});
	if (!context?.castId) return true;

	const castMessageId = context.castSummaryMessageId ?? castSummaryMessageId(context.castId);
	if (!state.castId || (castMessageId && !state.castMessageId)) {
		const updated = foundry.utils.deepClone(state);
		updated.castId = context.castId;
		if (castMessageId) updated.castMessageId = castMessageId;
		updated.version = Math.max(3, Number(updated.version) || 0);
		await message.setFlag(FLAG_SCOPE, FIRE_BALL_IMPACT_FLAG, updated);
	}
	await CoreCastingFailureWorkflow.registerLinkedMessage(
		context.castId,
		"impact",
		message.id,
	);
	return true;
}

async function reconcileFireBallFearRequest(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
	if (state?.source?.kind !== "spell-fire-ball") return false;
	const source = state.source ?? {};
	const context = source.castId
		? CoreCastingFailureWorkflow.activeContext({ spellUuid: source.spellUuid }) ?? { castId: String(source.castId), castSummaryMessageId: source.castMessageId ?? null }
		: CoreCastingFailureWorkflow.activeContext({ spellUuid: source.spellUuid });
	if (!context?.castId) return true;

	const castMessageId = context.castSummaryMessageId ?? castSummaryMessageId(context.castId);
	if (!source.castId || (castMessageId && !source.castMessageId)) {
		const updated = foundry.utils.deepClone(state);
		updated.source = {
			...(updated.source ?? {}),
			castId: context.castId,
			...(castMessageId ? { castMessageId } : {}),
		};
		await message.setFlag(FLAG_SCOPE, ACTOR_TEST_FLAG, updated);
	}
	await CoreCastingFailureWorkflow.registerLinkedMessage(
		context.castId,
		"fear-request",
		message.id,
	);
	return true;
}

function castSummaryMessageId(castId) {
	const id = String(castId ?? "").trim();
	if (!id) return null;
	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, FIRE_BALL_CAST_FLAG);
		if (String(state?.castId ?? "") === id) return String(message.id ?? "") || null;
	}
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to link spell cast ChatMessages.", error);
}
