import { FireBallBallGroupPresentation } from "./FireBallBallGroupPresentation.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const pendingKeys = new Set();
const dirtyKeys = new Set();

/**
 * Create/update exactly one presentation-only aggregate message per physical
 * Fire Ball once SpellCastLinkage has attached a permanent castId to an impact.
 * Canonical impact/Test/Damage messages remain untouched.
 *
 * Multiple impacts for the same Ball can be created/linked in the same tick.
 * Always rebuild the aggregate from ALL currently linked impacts for that
 * cast+ball key. A second event arriving while the key is already queued marks
 * it dirty so it is reconciled once more after the in-flight pass. This avoids
 * dropping the second target from a Ball aggregate.
 */
Hooks.on("createChatMessage", (message) => queueImpact(message));
Hooks.on("updateChatMessage", (message) => queueImpact(message));

function queueImpact(message) {
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!impact?.castId || !Number.isInteger(Number(impact?.ballNumber))) return;
	const castId = String(impact.castId);
	const ballNumber = Number(impact.ballNumber);
	const key = `${castId}:${ballNumber}`;
	if (pendingKeys.has(key)) {
		dirtyKeys.add(key);
		return;
	}
	queueKey(castId, ballNumber, key);
}

function queueKey(castId, ballNumber, key) {
	pendingKeys.add(key);
	queueMicrotask(() => {
		void ensureBallGroup(castId, ballNumber)
			.catch(reportError)
			.finally(() => {
				pendingKeys.delete(key);
				if (!dirtyKeys.delete(key)) return;
				queueKey(castId, ballNumber, key);
			});
	});
}

async function ensureBallGroup(castId, ballNumber) {
	if (!castId || !Number.isInteger(ballNumber) || ballNumber < 1) return;
	const impacts = impactsForBall(castId, ballNumber);
	if (!impacts.length) return;

	const firstState = impacts[0].getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!firstState) return;
	const impactIds = impacts.map((message) => String(message.id ?? "")).filter(Boolean);
	const targets = impacts
		.map((message) => targetFromImpact(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)))
		.filter((target) => target.actorUuid || target.tokenUuid);
	const castMessageId = impacts
		.map((message) => String(message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)?.castMessageId ?? ""))
		.find(Boolean) ?? "";

	const existing = findGroup(castId, ballNumber);
	if (existing) {
		const state = foundry.utils.deepClone(existing.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG) ?? {});
		state.impactMessageIds = unique(impactIds);
		state.targets = mergeTargets([], targets);
		state.castMessageId ||= castMessageId;
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

function impactsForBall(castId, ballNumber) {
	return [...(game.messages ?? [])].filter((message) => {
		const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		return String(impact?.castId ?? "") === String(castId) &&
			Number(impact?.ballNumber) === Number(ballNumber);
	});
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
