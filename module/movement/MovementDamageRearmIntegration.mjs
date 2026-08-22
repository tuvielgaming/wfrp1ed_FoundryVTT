import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";

const FLAG_SCOPE = "wfrp1ed";
const MOVEMENT_STATE_FLAG_KEY = "movementResultState";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const queues = new Map();

/*
 * Damage rollback keeps the old packet id as immutable reverted history. Jump
 * and Fall results, however, remain active rule results after only their damage
 * application is invalidated. Re-arm those still-active movement consequences
 * with a fresh packet id so Apply Damage becomes available again without ever
 * reusing the reverted transaction.
 *
 * This also closes the same lifecycle gap previously fixed for Risk damage.
 */
Hooks.on("updateChatMessage", (message) => {
	queueRearm(message);
});

Hooks.once("ready", () => {
	if (!isPrimaryActiveGm()) return;
	for (const message of game.messages ?? []) queueRearm(message);
});

function queueRearm(message) {
	if (!isPrimaryActiveGm() || !message?.id) return;
	const movement = movementState(message);
	if (!isRearmableMovement(movement)) return;

	const id = String(message.id);
	const previous = queues.get(id) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => rearmIfNeeded(message))
		.catch((error) => {
			console.error("WFRP1ED | Unable to re-arm movement damage.", error);
			ui.notifications.error(
				error?.message ?? localize(
					"Unable to re-arm the movement damage consequence.",
					"Nie udało się ponownie przygotować obrażeń wynikających z ruchu.",
				),
			);
		})
		.finally(() => {
			if (queues.get(id) === next) queues.delete(id);
		});
	queues.set(id, next);
}

async function rearmIfNeeded(message) {
	const movement = movementState(message);
	if (!isRearmableMovement(movement)) return;

	const damage = damageState(message);
	const oldPacketId = String(damage?.packet?.id ?? "").trim();
	if (!oldPacketId) return;

	const actor = actorForState(movement);
	if (!(actor instanceof foundry.documents.Actor)) return;

	const transaction = DamageApplication.transactionFor(actor, oldPacketId);
	if (transaction?.state !== "reverted") return;

	const wounds = movementWounds(movement);
	if (wounds <= 0) return;

	const updatedMovement = foundry.utils.deepClone(movement);
	updatedMovement.damageGeneration =
		Math.max(1, Number(updatedMovement.damageGeneration) || 1) + 1;
	updatedMovement.rearmedFromPacketId = oldPacketId;
	updatedMovement.damageRearmedAt = Date.now();
	updatedMovement.updatedBy = String(game.user?.id ?? "");
	updatedMovement.updatedAt = Date.now();

	const packet = new DamagePacket({
		rawAmount: wounds,
		targetActorUuid: actor.uuid,
		source: damageSource(message, damage, movement),
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
		criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
	});
	const resolution = DamageResolver.resolve(packet);
	const newDamageState = DamageChat._state(
		packet,
		resolution,
		"attached",
		actor.name,
	);

	await message.update({
		[`flags.${FLAG_SCOPE}.${MOVEMENT_STATE_FLAG_KEY}`]: updatedMovement,
		[`flags.${FLAG_SCOPE}.${DAMAGE_STATE_FLAG_KEY}`]: newDamageState,
	});
}

function isRearmableMovement(state) {
	if (!state || state.cancelled === true) return false;
	return state.kind === "jump" || state.kind === "fall";
}

function movementWounds(state) {
	if (state?.kind === "jump") {
		const height = finiteNumber(state.height, "jump height");
		const die = finiteNumber(state.die, "jump d6");
		const effectBonus = finiteNumber(state.effectBonus ?? 0, "jump effect bonus");
		return Math.max(0, height - (die + effectBonus));
	}

	if (state?.kind === "fall") {
		const doubledHeight = finiteNumber(state.doubledHeight, "fall doubled height");
		const die = finiteNumber(state.die, "fall d6");
		const acrobaticsBonus = finiteNumber(
			state.acrobaticsBonus ?? 0,
			"fall Acrobatics bonus",
		);
		return Math.max(0, doubledHeight - (die + acrobaticsBonus));
	}
	return 0;
}

function movementState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, MOVEMENT_STATE_FLAG_KEY);
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

function actorForState(state) {
	try {
		const actor = foundry.utils.fromUuidSync(
			String(state?.actorUuid ?? "").trim(),
		);
		return actor instanceof foundry.documents.Actor ? actor : null;
	} catch (_error) {
		return null;
	}
}

function damageSource(message, damage, movement) {
	const source = damage?.packet?.source;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		return foundry.utils.deepClone(source);
	}
	return {
		kind: "movement-procedure",
		id: String(movement?.kind ?? "movement"),
		uuid: String(message?.uuid ?? ""),
		label: movement?.kind === "fall"
			? localize("Fall", "Upadek")
			: localize("Jump", "Zeskok"),
	};
}

function finiteNumber(value, label) {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new Error(`${label} must be finite: ${String(value)}.`);
	}
	return number;
}

function isPrimaryActiveGm() {
	return primaryActiveGm()?.id === game.user?.id;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
