import { CombatInitiativeClock } from "../combat/CombatInitiativeClock.mjs";
import { DamageApplication } from "./DamageApplication.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "./DamagePacket.mjs";
import { DamageResolution } from "./DamageResolution.mjs";

const FLAG_SCOPE = "wfrp1ed";
const RUNTIME_FLAG_KEY = "periodicDirectDamage";
const RULE_CHANGES_FLAG_KEY = "ruleChanges";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const SOURCE_KIND = "periodic-direct-damage";
const VERSION = 1;
const processingTicks = new Set();
let processingWorldTime = false;

/**
 * Generic recipient-owned periodic direct damage.
 *
 * Combat weapon and ammunition hits are the first producer, but delivery is a
 * public source-independent API so a later spell resolver can pass the same
 * immutable delivery records after its own successful transaction.
 */
export class PeriodicDirectDamageEngine {
	static async deliver({
		targetActor,
		originPacketId,
		originMessageId = "",
		deliveries = [],
	} = {}) {
		if (!(targetActor instanceof foundry.documents.Actor)) {
			throw new Error("Periodic direct damage delivery requires a target Actor.");
		}
		const packetId = String(originPacketId ?? "").trim();
		if (!packetId || !Array.isArray(deliveries) || deliveries.length === 0) {
			return [];
		}

		const existing = deliveredEffects(targetActor, packetId);
		const existingIds = new Set(existing.map((effect) =>
			String(runtimeState(effect)?.deliveryId ?? ""),
		));
		const activeDeliveryIds = new Set(
			[...(targetActor.effects ?? [])]
				.filter((effect) => effect.disabled !== true)
				.map((effect) => String(runtimeState(effect)?.deliveryId ?? ""))
				.filter(Boolean),
		);
		const combat = activeCombatForActor(targetActor);
		const sources = [];

		for (const delivery of deliveries) {
			const deliveryId = String(delivery?.id ?? "").trim();
			const formula = String(delivery?.formula ?? "").trim();
			const stacking = String(delivery?.stacking ?? "once");
			if (
				!deliveryId ||
				!formula ||
				existingIds.has(deliveryId) ||
				(stacking === "once" && activeDeliveryIds.has(deliveryId))
			) {
				continue;
			}

			const duration = normalizedDuration(delivery.duration);
			const worldTime = currentWorldTime();
			const runtime = {
				version: VERSION,
				deliveryId,
				originPacketId: packetId,
				originMessageId: String(originMessageId ?? ""),
				formula,
				condition: String(delivery.condition ?? ""),
				stacking,
				sourceKind: String(delivery.sourceKind ?? ""),
				sourceUuid: String(delivery.sourceUuid ?? ""),
				sourceName: String(delivery.sourceName ?? ""),
				sourceEffectId: String(delivery.effectId ?? ""),
				sourceEffectName: String(delivery.effectName ?? "Active Effect"),
				duration,
				ticksApplied: 0,
				generation: 1,
				createdAt: Date.now(),
				startWorldTime: worldTime,
				endWorldTime: durationSeconds(duration) > 0
					? worldTime + durationSeconds(duration)
					: 0,
				...captureActorClock(combat, targetActor),
			};
			const change = foundry.utils.deepClone(delivery.change ?? {});
			const changes = change?.type ? [change] : [];
			const nativeDuration = effectDuration(duration, combat);
			sources.push({
				name: String(delivery.effectName ?? localize(
					"Periodic direct damage",
					"Okresowe obrażenia bezpośrednie",
				)),
				img: String(delivery.effectImg ?? "icons/svg/fire.svg"),
				disabled: false,
				transfer: false,
				changes,
				system: { changes: foundry.utils.deepClone(changes) },
				...(nativeDuration ? { duration: nativeDuration } : {}),
				flags: {
					[FLAG_SCOPE]: {
						[RUNTIME_FLAG_KEY]: runtime,
						[RULE_CHANGES_FLAG_KEY]: foundry.utils.deepClone(changes),
					},
				},
			});
		}

		if (sources.length === 0) return existing;
		return targetActor.createEmbeddedDocuments("ActiveEffect", sources);
	}

	static async deliverFromAppliedDamage({
		message,
		packet,
		transaction,
		targetActor,
	} = {}) {
		if (
			packet?.source?.kind !== "combat-attack" ||
			transaction?.state !== "applied" ||
			Number(transaction.amountApplied) <= 0
		) {
			return [];
		}
		const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
		const deliveries = rollState?.periodicDirectDamage;
		if (!Array.isArray(deliveries) || deliveries.length === 0) return [];

		return this.deliver({
			targetActor,
			originPacketId: packet.id,
			originMessageId: message?.id,
			deliveries,
		});
	}

	static async handleRevertedDamage({ actor, packet } = {}) {
		if (!(actor instanceof foundry.documents.Actor) || !packet?.id) return null;
		if (packet.source?.kind === "combat-attack") {
			const effects = deliveredEffects(actor, packet.id);
			if (effects.length > 0) {
				await actor.deleteEmbeddedDocuments(
					"ActiveEffect",
					effects.map((effect) => effect.id),
				);
			}
			return { removed: effects.length };
		}
		if (packet.source?.kind !== SOURCE_KIND) return null;

		const effect = effectFromPacket(actor, packet);
		if (!effect) return null;
		const runtime = runtimeState(effect);
		const cycle = nonNegativeInteger(
			packet.source?.id?.match?.(/cycle-(\d+)/)?.[1] ?? runtime?.lastCycle,
		);
		if (!runtime || cycle <= 0) return null;

		const next = {
			...foundry.utils.deepClone(runtime),
			ticksApplied: Math.max(0, nonNegativeInteger(runtime.ticksApplied) - 1),
			generation: nonNegativeInteger(runtime.generation) + 1,
		};
		await effect.update({
			disabled: false,
			"duration.expired": false,
			[`flags.${FLAG_SCOPE}.${RUNTIME_FLAG_KEY}`]: next,
		});
		return foundry.utils.deepFreeze({
			rearmed: true,
			cycle,
			generation: next.generation,
		});
	}
}

CombatInitiativeClock.registerConsumer(async (combat, event) => {
	if (!isPrimaryActiveGm()) return;
	try {
		await processClock(combat, event);
	} catch (error) {
		reportError(error);
	}
});

Hooks.on("updateWorldTime", (worldTime) => {
	if (!isPrimaryActiveGm() || processingWorldTime) return;
	processingWorldTime = true;
	void expireByWorldTime(Number(worldTime))
		.catch(reportError)
		.finally(() => { processingWorldTime = false; });
});

async function processClock(combat, event) {
	for (const actor of combatActors(combat)) {
		for (const effect of actor.effects ?? []) {
			let runtime = runtimeState(effect);
			if (!runtime || effect.disabled === true) continue;
			if (await expireIfWorldTimeElapsed(effect, runtime, currentWorldTime())) continue;

			const hadClock = CombatInitiativeClock.anchored(runtime, combat);
			if (!hadClock) {
				runtime = {
					...foundry.utils.deepClone(runtime),
					...captureActorClock(combat, actor),
				};
				runtime.lastClockRound = Math.max(
					nonNegativeInteger(runtime.lastClockRound),
					nonNegativeInteger(event?.round),
				);
				await effect.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, runtime);
				continue;
			}
			if (!CombatInitiativeClock.isDue(runtime, event)) continue;

			const maxTicks = maximumTicks(runtime.duration);
			const ticksApplied = nonNegativeInteger(runtime.ticksApplied);
			if (maxTicks > 0 && ticksApplied >= maxTicks) {
				await expireEffect(effect);
				continue;
			}
			await applyTick(actor, effect, runtime, combat, event, ticksApplied + 1);
		}
	}
}

async function applyTick(actor, effect, runtime, combat, event, cycle) {
	const generation = Math.max(1, nonNegativeInteger(runtime.generation));
	const combatId = String(combat?.id ?? runtime.combatId ?? "combat");
	const sourceId = `effect-${effect.id}-cycle-${cycle}-generation-${generation}`;
	const packetId = `periodic-${sourceId}`;
	const tickKey = `${actor.uuid}|${packetId}`;
	if (processingTicks.has(tickKey)) return null;
	processingTicks.add(tickKey);

	try {
		const existing = DamageApplication.transactionFor(actor, packetId);
		if (existing?.state === "applied") {
			return stampTick(effect, runtime, combat, event, cycle);
		}

		const roll = await new Roll(
			String(runtime.formula),
			actor.getRollData?.() ?? {},
		).evaluate({ allowInteractive: false });
		await showDice(roll);
		const amount = damageAmount(roll.total, runtime.formula);
		const packet = new DamagePacket({
			id: packetId,
			rawAmount: amount,
			targetActorUuid: actor.uuid,
			source: {
				kind: SOURCE_KIND,
				id: sourceId,
				uuid: String(effect.uuid ?? ""),
				label: String(effect.name ?? runtime.sourceEffectName ?? ""),
			},
			armour: DAMAGE_MITIGATION_POLICY.IGNORE,
			toughness: DAMAGE_MITIGATION_POLICY.IGNORE,
			criticalMode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		});
		const resolution = DamageResolution.forPacket(packet, {
			finalAmount: amount,
			breakdown: {
				source: SOURCE_KIND,
				formula: String(runtime.formula),
				roll: amount,
				effectUuid: String(effect.uuid ?? ""),
				sourceUuid: String(runtime.sourceUuid ?? ""),
				originPacketId: String(runtime.originPacketId ?? ""),
				cycle,
				generation,
				clockEvent: String(event?.kind ?? runtime.lastClockEvent?.kind ?? "rearm"),
			},
		});
		const chat = game.WFRP1ED?.damage?.Chat;
		if (!chat) throw new Error("WFRP damage chat API is unavailable.");
		const message = await chat.publish({ packet, resolution, speakerActor: actor });
		const transaction = await chat.applyMessage(message);
		if (!transaction || transaction.state !== "applied") {
			throw new Error("Periodic direct damage could not be applied.");
		}
		return stampTick(effect, runtime, combat, event, cycle);
	} finally {
		processingTicks.delete(tickKey);
	}
}

async function stampTick(effect, runtime, combat, event, cycle) {
	const clockEvent = event ?? runtime.lastClockEvent ?? {};
	const stamped = event
		? CombatInitiativeClock.stamp(runtime, event)
		: foundry.utils.deepClone(runtime);
	const ticksApplied = Math.max(
		nonNegativeInteger(runtime.ticksApplied) + 1,
		nonNegativeInteger(cycle),
	);
	const next = {
		...stamped,
		version: VERSION,
		lastCombatId: String(combat?.id ?? runtime.combatId ?? ""),
		lastRound: nonNegativeInteger(event?.round ?? runtime.lastRound),
		lastCycle: nonNegativeInteger(cycle),
		lastClockEvent: foundry.utils.deepClone(clockEvent),
		ticksApplied,
	};
	const expires = maximumTicks(runtime.duration) > 0 &&
		ticksApplied >= maximumTicks(runtime.duration);
	const update = {
		[`flags.${FLAG_SCOPE}.${RUNTIME_FLAG_KEY}`]: next,
	};
	if (expires) {
		update.disabled = true;
		update["duration.expired"] = true;
	}
	await effect.update(update);
	return next;
}

function deliveredEffects(actor, originPacketId) {
	const packetId = String(originPacketId ?? "");
	return [...(actor?.effects ?? [])].filter((effect) =>
		String(runtimeState(effect)?.originPacketId ?? "") === packetId,
	);
}

function effectFromPacket(actor, packet) {
	const uuid = String(packet?.source?.uuid ?? "");
	if (uuid) {
		try {
			const effect = foundry.utils.fromUuidSync(uuid);
			if (effect?.parent === actor && runtimeState(effect)) return effect;
		} catch (_error) {
			// Fall back to the embedded effect id encoded in source.id.
		}
	}
	const effectId = String(packet?.source?.id ?? "")
		.match(/^effect-(.+)-cycle-\d+-generation-\d+$/)?.[1];
	return effectId ? actor.effects?.get?.(effectId) ?? null : null;
}

function runtimeState(effect) {
	const state = effect?.getFlag?.(FLAG_SCOPE, RUNTIME_FLAG_KEY) ??
		effect?.flags?.[FLAG_SCOPE]?.[RUNTIME_FLAG_KEY];
	return state && typeof state === "object"
		? foundry.utils.deepClone(state)
		: null;
}

function normalizedDuration(duration) {
	const source = duration && typeof duration === "object" ? duration : {};
	return {
		value: positiveNumber(
			source.value ??
			source.rounds ??
			source.seconds ??
			source.turns,
		),
		units: String(
			source.units ??
			(source.rounds ? "rounds" : source.seconds ? "seconds" : source.turns ? "turns" : ""),
		),
	};
}

function effectDuration(duration) {
	if (!duration.value || !duration.units) return null;
	return {
		value: duration.value,
		units: duration.units,
		expired: false,
		expiry: null,
	};
}

function maximumTicks(duration) {
	if (String(duration?.units ?? "") === "rounds") {
		return nonNegativeInteger(duration?.value);
	}
	return String(duration?.units ?? "") === "turns" && positiveNumber(duration?.value)
		? 1
		: 0;
}

async function expireByWorldTime(worldTime) {
	if (!Number.isFinite(worldTime)) return;
	for (const actor of game.actors ?? []) {
		for (const effect of actor.effects ?? []) {
			const runtime = runtimeState(effect);
			if (!runtime || effect.disabled === true) continue;
			await expireIfWorldTimeElapsed(effect, runtime, worldTime);
		}
	}
}

async function expireIfWorldTimeElapsed(effect, runtime, worldTime) {
	let end = Number(runtime?.endWorldTime);
	if (!Number.isFinite(end) || end <= 0) {
		const seconds = durationSeconds(runtime?.duration);
		if (!seconds) return false;
		const next = {
			...foundry.utils.deepClone(runtime),
			startWorldTime: worldTime,
			endWorldTime: worldTime + seconds,
		};
		await effect.setFlag(FLAG_SCOPE, RUNTIME_FLAG_KEY, next);
		return false;
	}
	if (worldTime < end) return false;
	await expireEffect(effect);
	return true;
}

function durationSeconds(duration) {
	const amount = positiveNumber(duration?.value);
	if (!amount) return 0;
	switch (String(duration?.units ?? "")) {
		case "seconds": return amount;
		case "minutes": return amount * 60;
		case "hours": return amount * 60 * 60;
		case "days": return amount * 24 * 60 * 60;
		default: return 0;
	}
}

async function expireEffect(effect) {
	await effect.update({ disabled: true, "duration.expired": true });
}

function activeCombatForActor(actor) {
	const combats = game.combats?.contents ?? [...(game.combats ?? [])];
	return combats.find((combat) =>
		combat?.started && [...(combat.combatants ?? [])].some((combatant) =>
			combatant?.actorId === actor?.id || combatant?.actor?.uuid === actor?.uuid,
		),
	) ?? null;
}

function captureActorClock(combat, actor) {
	if (!(combat instanceof foundry.documents.Combat) || !combat.started) {
		return {
			combatId: "",
			startRound: 0,
			clockInitiative: null,
			lastClockRound: 0,
		};
	}
	const combatant = [...(combat.combatants ?? [])].find((entry) =>
		entry?.actorId === actor?.id || entry?.actor?.uuid === actor?.uuid,
	) ?? null;
	return {
		combatId: String(combat.id ?? ""),
		startRound: nonNegativeInteger(combat.round),
		clockInitiative: CombatInitiativeClock.timelineInitiative(combat, combatant),
		lastClockRound: 0,
	};
}

function combatActors(combat) {
	const actors = new Map();
	for (const combatant of combat?.combatants ?? []) {
		const actor = combatant?.actor;
		if (actor instanceof foundry.documents.Actor) actors.set(actor.uuid, actor);
	}
	return [...actors.values()];
}

function isPrimaryActiveGm() {
	if (!game.user?.isGM || game.user.active === false) return false;
	const activeGms = [...(game.users ?? [])]
		.filter((user) => user?.isGM && user.active !== false)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)));
	return activeGms[0]?.id === game.user.id;
}

async function showDice(roll) {
	try {
		if (game.dice3d?.showForRoll) {
			await game.dice3d.showForRoll(roll, game.user, true);
		}
	} catch (error) {
		console.warn("WFRP1ED | Dice So Nice periodic-damage animation failed.", error);
	}
}

function reportError(error) {
	console.error("WFRP1ED | Periodic direct damage failed.", error);
	ui.notifications.error(error?.message ?? localize(
		"Periodic direct damage failed.",
		"Nie udało się zastosować okresowych obrażeń bezpośrednich.",
	));
}

function currentWorldTime() {
	const time = Number(game.time?.worldTime);
	return Number.isFinite(time) ? time : 0;
}

function positiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function damageAmount(value, formula) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) {
		throw new Error(
			`Periodic direct-damage formula '${formula}' did not produce a non-negative integer.`,
		);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
