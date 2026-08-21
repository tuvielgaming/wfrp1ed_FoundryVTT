import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RISK_STATE_FLAG_KEY = "riskConsequenceState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const queues = new Map();

/*
 * An invalidated damage application is immutable history, so DamageChat
 * deliberately never re-applies the same reverted packet id.
 *
 * A failed Risk Test is different from a historical combat hit: while its Risk
 * consequence remains active, invalidating only the damage application does not
 * remove the rule consequence. Re-arm that still-active consequence as a fresh
 * damage packet generation. This preserves the reverted packet as audit history
 * while immediately restoring the normal pending Apply Damage action and the
 * editable physical-dice D3.
 *
 * To avoid a transient mismatch with RiskConsequenceIntegration, the new Risk
 * packet id and the new attached damage snapshot are written in one ChatMessage
 * update.
 */
Hooks.on("updateChatMessage", (message) => {
	queueRearm(message);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	for (const message of game.messages ?? []) {
		queueRearm(message);
	}
});

function queueRearm(message) {
	if (!isPrimaryActiveGm() || !message?.id) return;
	const risk = riskState(message);
	if (!risk?.active || !String(risk.packetId ?? "").trim()) return;

	const id = String(message.id);
	const previous = queues.get(id) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => rearmIfNeeded(message))
		.catch((error) => {
			console.error("WFRP1ED | Unable to re-arm Risk damage.", error);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to re-arm the Risk damage consequence.",
					"Nie udało się ponownie przygotować obrażeń z Testu Ryzyka.",
				),
			);
		})
		.finally(() => {
			if (queues.get(id) === next) queues.delete(id);
		});
	queues.set(id, next);
}

async function rearmIfNeeded(message) {
	const risk = riskState(message);
	if (!risk?.active) return;

	const actor = actorForRiskState(risk);
	if (!(actor instanceof foundry.documents.Actor)) return;

	const oldPacketId = String(risk.packetId ?? "").trim();
	if (!oldPacketId) return;

	const transaction = DamageApplication.transactionFor(actor, oldPacketId);
	if (transaction?.state !== "reverted") return;

	const currentDamage = damageState(message);
	if (
		!currentDamage?.packet ||
		String(currentDamage.packet.id ?? "") !== oldPacketId
	) {
		/* Another subsystem has already replaced or removed this packet. */
		return;
	}

	const die = Number(risk.die);
	if (!Number.isInteger(die) || die < 1 || die > 3) {
		throw new Error(`Risk consequence D3 must be 1-3: ${String(risk.die)}.`);
	}

	const updatedRisk = foundry.utils.deepClone(risk);
	updatedRisk.packetId = foundry.utils.randomID();
	updatedRisk.generation = Math.max(1, Number(updatedRisk.generation) || 1) + 1;
	updatedRisk.rearmedFromPacketId = oldPacketId;
	updatedRisk.rearmedAt = Date.now();
	updatedRisk.updatedBy = String(game.user?.id ?? "");
	updatedRisk.updatedAt = Date.now();

	const packet = new DamagePacket({
		id: updatedRisk.packetId,
		rawAmount: die,
		targetActorUuid: actor.uuid,
		source: damageSource(message, currentDamage),
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		createdAt: Number(updatedRisk.rolledAt) || Date.now(),
	});
	const resolution = DamageResolver.resolve(packet);
	const newDamageState = DamageChat._state(
		packet,
		resolution,
		"attached",
		actor.name,
	);

	await message.update({
		[`flags.${FLAG_SCOPE}.${RISK_STATE_FLAG_KEY}`]: updatedRisk,
		[`flags.${FLAG_SCOPE}.${DAMAGE_STATE_FLAG_KEY}`]: newDamageState,
	});
}

function riskState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, RISK_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function damageState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function actorForRiskState(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function damageSource(message, damage) {
	const source = damage?.packet?.source;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		return foundry.utils.deepClone(source);
	}

	return {
		kind: "standard-test",
		id: "risk",
		uuid: String(message?.uuid ?? ""),
		label: localize("Risk", "Ryzyko"),
	};
}

function isPrimaryActiveGm() {
	return primaryActiveGm()?.id === game.user?.id;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
