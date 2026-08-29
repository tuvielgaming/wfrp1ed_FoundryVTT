import { FireBallBallGroupPresentation } from "./FireBallBallGroupPresentation.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const CAST_FLAG = "fireBallCast";
const REVEAL_FLAG = "fireBallGroupHitsRevealed";
const pendingKeys = new Set();
const dirtyKeys = new Set();

/**
 * Create/update exactly one presentation-only aggregate message per physical
 * Fire Ball.
 *
 * Group casts have a Dice So Nice target-count animation. Do not create the
 * aggregate ChatMessages until that animation has been explicitly revealed by
 * FireBallGroupHitDiceAnimation. This removes the previous render/hide race:
 * there is simply no Ball aggregate card available to leak into chat before the
 * dice finish.
 *
 * Multiple impacts for the same Ball can still arrive in the same tick. Each
 * reconciliation rebuilds the group from ALL current impacts for cast+ball.
 */
Hooks.on("createChatMessage", (message) => {
	queueImpact(message);
	queueRevealedCast(message);
});
Hooks.on("updateChatMessage", (message) => {
	queueImpact(message);
	queueRevealedCast(message);
});

function queueImpact(message) {
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!impact?.castId || !Number.isInteger(Number(impact?.ballNumber))) return;
	if (!castReadyForAggregate(String(impact.castId))) return;
	queueKey(String(impact.castId), Number(impact.ballNumber));
}

function queueRevealedCast(message) {
	const cast = message?.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (!cast?.castId) return;
	if (cast.group === true && !message.getFlag?.(FLAG_SCOPE, REVEAL_FLAG)) return;

	const castId = String(cast.castId);
	const ballNumbers = new Set(
		impactsForCast(castId)
			.map((impactMessage) => Number(impactMessage.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)?.ballNumber))
			.filter((number) => Number.isInteger(number) && number >= 1),
	);
	for (const ballNumber of ballNumbers) queueKey(castId, ballNumber);
}

function queueKey(castId, ballNumber) {
	const key = `${castId}:${ballNumber}`;
	if (pendingKeys.has(key)) {
		dirtyKeys.add(key);
		return;
	}
	pendingKeys.add(key);
	queueMicrotask(() => {
		void ensureBallGroup(castId, ballNumber)
			.catch(reportError)
			.finally(() => {
				pendingKeys.delete(key);
				if (!dirtyKeys.delete(key)) return;
				queueKey(castId, ballNumber);
			});
	});
}

async function ensureBallGroup(castId, ballNumber) {
	if (!castId || !Number.isInteger(ballNumber) || ballNumber < 1) return;
	if (!castReadyForAggregate(castId)) return;

	const impacts = impactsForBall(castId, ballNumber);
	if (!impacts.length) return;

	const firstState = impacts[0].getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!firstState) return;
	const impactIds = impacts.map((message) => String(message.id ?? "")).filter(Boolean);
	const targets = impacts
		.map((message) => targetFromImpact(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)))
		.filter((target) => target.actorUuid || target.tokenUuid);
	const castMessage = castMessageForId(castId);
	const castMessageId = String(castMessage?.id ?? firstState.castMessageId ?? "");

	const existing = findGroup(castId, ballNumber);
	if (existing) {
		const state = foundry.utils.deepClone(existing.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG) ?? {});
		state.impactMessageIds = unique(impactIds);
		state.targets = mergeTargets([], targets);
		state.castMessageId = castMessageId || String(state.castMessageId ?? "");
		state.updatedAt = Date.now();
		await existing.setFlag(FLAG_SCOPE, BALL_GROUP_FLAG, state);
		requestChatRefresh();
		return;
	}

	const caster = documentFromUuid(firstState.casterUuid);
	const spell = documentFromUuid(firstState.spellUuid);
	await FireBallBallGroupPresentation.create({
		castId,
		castMessageId,
		caster,
		spell: spell ?? { uuid: firstState.spellUuid, name: firstState.spellName },
		ballNumber,
		impactMessageIds: unique(impactIds),
		targets: mergeTargets([], targets),
	});
	requestChatRefresh();
}

function castReadyForAggregate(castId) {
	const message = castMessageForId(castId);
	if (!message) return false;
	const cast = message.getFlag?.(FLAG_SCOPE, CAST_FLAG);
	if (!cast) return false;
	return cast.group !== true || Boolean(message.getFlag?.(FLAG_SCOPE, REVEAL_FLAG));
}

function castMessageForId(castId) {
	for (const message of game.messages ?? []) {
		const cast = message.getFlag?.(FLAG_SCOPE, CAST_FLAG);
		if (String(cast?.castId ?? "") === String(castId)) return message;
	}
	return null;
}

function impactsForCast(castId) {
	return [...(game.messages ?? [])].filter((message) =>
		String(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)?.castId ?? "") === String(castId),
	);
}

function impactsForBall(castId, ballNumber) {
	return impactsForCast(castId).filter((message) =>
		Number(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)?.ballNumber) === Number(ballNumber),
	);
}

function findGroup(castId, ballNumber) {
	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
		if (!state) continue;
		if (String(state.castId ?? "") !== String(castId)) continue;
		if (Number(state.ballNumber) !== Number(ballNumber)) continue;
		return message;
	}
	return null;
}

function targetFromImpact(impact) {
	return {
		actorUuid: String(impact?.targetUuid ?? ""),
		tokenUuid: String(impact?.targetTokenUuid ?? ""),
		name: String(impact?.targetName ?? "—"),
	};
}

function mergeTargets(existing, incoming) {
	const result = [...existing];
	for (const target of incoming) {
		const found = result.some((candidate) =>
			target.tokenUuid
				? String(candidate?.tokenUuid ?? "") === String(target.tokenUuid)
				: String(candidate?.actorUuid ?? "") === String(target.actorUuid),
		);
		if (!found) result.push(target);
	}
	return result;
}

function unique(values) {
	return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function documentFromUuid(uuid) {
	try {
		return foundry.utils.fromUuidSync(String(uuid ?? "").trim()) ?? null;
	} catch (_error) {
		return null;
	}
}

function requestChatRefresh() {
	requestAnimationFrame(() => void ui.chat?.render?.({ force: true }));
}

function reportError(error) {
	console.error("WFRP1ED | Unable to create/update Fire Ball aggregate card.", error);
}
