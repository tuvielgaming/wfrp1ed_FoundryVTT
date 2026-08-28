import { FireBallBallGroupPresentation } from "./FireBallBallGroupPresentation.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const pendingKeys = new Set();

/**
 * Create/update exactly one presentation-only aggregate message per physical
 * Fire Ball once SpellCastLinkage has attached a permanent castId to an impact.
 * Canonical impact/Test/Damage messages remain untouched.
 */
Hooks.on("createChatMessage", (message) => queueImpact(message));
Hooks.on("updateChatMessage", (message) => queueImpact(message));

function queueImpact(message) {
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!impact?.castId || !Number.isInteger(Number(impact?.ballNumber))) return;
	const key = `${String(impact.castId)}:${Number(impact.ballNumber)}`;
	if (pendingKeys.has(key)) return;
	pendingKeys.add(key);
	queueMicrotask(() => {
		void ensureBallGroup(message)
			.catch(reportError)
			.finally(() => pendingKeys.delete(key));
	});
}

async function ensureBallGroup(impactMessage) {
	const impact = impactMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	if (!impact?.castId) return;
	const castId = String(impact.castId);
	const ballNumber = Number(impact.ballNumber);
	if (!Number.isInteger(ballNumber) || ballNumber < 1) return;

	const existing = findGroup(castId, ballNumber);
	const target = targetFromImpact(impact);
	if (existing) {
		const state = foundry.utils.deepClone(existing.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG) ?? {});
		const impactId = String(impactMessage.id ?? "");
		state.impactMessageIds = unique([...(state.impactMessageIds ?? []), impactId]);
		state.targets = mergeTargets(state.targets ?? [], [target]);
		state.castMessageId ||= String(impact.castMessageId ?? "");
		state.updatedAt = Date.now();
		await existing.setFlag(FLAG_SCOPE, BALL_GROUP_FLAG, state);
		return;
	}

	const caster = documentFromUuid(impact.casterUuid);
	const spell = documentFromUuid(impact.spellUuid);
	await FireBallBallGroupPresentation.create({
		castId,
		castMessageId: String(impact.castMessageId ?? ""),
		caster,
		spell: spell ?? { uuid: impact.spellUuid, name: impact.spellName },
		ballNumber,
		impactMessageIds: [String(impactMessage.id ?? "")],
		targets: [target],
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

function reportError(error) {
	console.error("WFRP1ED | Unable to create/update Fire Ball aggregate card.", error);
}
