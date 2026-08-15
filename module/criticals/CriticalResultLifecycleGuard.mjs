import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const DAMAGE_STATE_FLAG_KEY = "damageState";
const KILLED_OUTCOME = "killed";

const cleanupPackets = new Set();

/**
 * A DamagePacket owns at most one live Critical-result ChatMessage.
 *
 * Invalidated criticals already keep their audit trail in the Actor-side damage
 * transaction (`criticalHistory`). Leaving their derived ChatMessages around is
 * both redundant and dangerous because old Apply buttons look actionable. When
 * a replacement result is published, remove every older result for that packet.
 */
Hooks.on("createChatMessage", (message) => {
	const state = detailedCriticalState(message);
	if (!state?.packetId) return;
	queueMicrotask(() => void removeSiblingCriticalMessages(message, state.packetId));
});

/**
 * CriticalTransactionRollback clears `criticalResolution` before deleting the
 * result which was invalidated. Use that authoritative state change to clean any
 * older sibling result cards left by previous implementation versions.
 */
Hooks.on("deleteChatMessage", (message) => {
	const state = detailedCriticalState(message);
	if (!state?.packetId) return;
	const context = damageContext(state);
	if (context?.transaction?.criticalResolution) return;
	queueMicrotask(() => void removeAllCriticalMessagesForPacket(state.packetId));
});

/* Repair historical duplicate result cards left by older development builds. */
Hooks.once("ready", () => {
	if (!canAuthoritativelyDeleteChat()) return;
	void repairExistingCriticalResultMessages();
});

/* Final presentation guard: one applied-fatal confirmation, never duplicates. */
Hooks.on("renderChatMessageHTML", (message, html) => {
	const state = detailedCriticalState(message);
	if (state?.resolution?.outcome !== KILLED_OUTCOME) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	requestAnimationFrame(() => keepSingleFatalConfirmation(card));
});

/*
 * FatalCriticalIntegration and DetailedFatalCriticalPresentation also refresh
 * visible cards directly from updateActor, without emitting another render hook.
 * Re-run the final de-duplication after those direct decorators have completed.
 */
Hooks.on("updateActor", () => {
	requestAnimationFrame(() => {
		for (const card of document.querySelectorAll(
			"[data-wfrp-detailed-critical-card].is-killed",
		)) {
			keepSingleFatalConfirmation(card);
		}
	});
});

async function repairExistingCriticalResultMessages() {
	const packetIds = new Set(
		[...(game.messages ?? [])]
			.map((message) => String(detailedCriticalState(message)?.packetId ?? ""))
			.filter(Boolean),
	);

	for (const packetId of packetIds) {
		const messages = criticalMessagesForPacket(packetId)
			.sort(compareNewestFirst);
		if (messages.length === 0) continue;

		const context = damageContext(detailedCriticalState(messages[0]));
		const keep = context?.transaction?.criticalResolution ? messages[0] : null;
		await deleteMessages(
			messages.filter((message) => !keep || message.id !== keep.id),
			packetId,
		);
	}
}

async function removeSiblingCriticalMessages(currentMessage, packetId) {
	if (!canAuthoritativelyDeleteChat()) return;
	const currentId = String(currentMessage?.id ?? "");
	const siblings = criticalMessagesForPacket(packetId).filter(
		(message) => String(message.id) !== currentId,
	);
	await deleteMessages(siblings, packetId);
}

async function removeAllCriticalMessagesForPacket(packetId) {
	if (!canAuthoritativelyDeleteChat()) return;
	await deleteMessages(criticalMessagesForPacket(packetId), packetId);
}

async function deleteMessages(messages, packetId) {
	const key = String(packetId ?? "");
	if (!key || cleanupPackets.has(key) || messages.length === 0) return;
	cleanupPackets.add(key);
	try {
		for (const message of messages) {
			if (!message?.id) continue;
			if (message.canUserModify?.(game.user, "delete") !== true) continue;
			await message.delete();
		}
	} catch (error) {
		console.error("WFRP1ED | Unable to clean superseded Critical result messages.", error);
	} finally {
		cleanupPackets.delete(key);
	}
}

function criticalMessagesForPacket(packetId) {
	const key = String(packetId ?? "");
	if (!key) return [];
	return [...(game.messages ?? [])].filter((message) =>
		String(detailedCriticalState(message)?.packetId ?? "") === key,
	);
}

function detailedCriticalState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	if (!state || typeof state !== "object" || Array.isArray(state)) return null;
	return state.kind === "detailed" ? state : null;
}

function damageContext(resultState) {
	const source = game.messages?.get(String(resultState?.sourceMessageId ?? ""));
	const damage = source?.getFlag?.(FLAG_SCOPE, DAMAGE_STATE_FLAG_KEY);
	const actor = actorFromUuidSync(damage?.packet?.targetActorUuid);
	const packetId = String(resultState?.packetId ?? damage?.packet?.id ?? "");
	return {
		actor,
		transaction: actor && packetId
			? DamageApplication.transactionFor(actor, packetId)
			: null,
	};
}

function keepSingleFatalConfirmation(card) {
	if (!(card instanceof HTMLElement)) return;
	const confirmations = [...card.querySelectorAll(".wfrp1e-fate-intervention__spent")]
		.filter((element) => isAppliedFatalConfirmation(element));
	for (const duplicate of confirmations.slice(1)) {
		const panel = duplicate.closest(
			"[data-wfrp-detailed-fatal-lifecycle], [data-wfrp-fatal-application], .wfrp1e-fate-intervention",
		);
		if (panel && panel !== card) panel.remove();
		else duplicate.remove();
	}
}

function isAppliedFatalConfirmation(element) {
	const text = String(element?.textContent ?? "").toLowerCase();
	return text.includes("fatal critical applied") ||
		text.includes("zastosowano śmiertelne trafienie krytyczne");
}

function compareNewestFirst(left, right) {
	const leftTime = Number(left?._stats?.createdTime ?? left?.timestamp ?? 0);
	const rightTime = Number(right?._stats?.createdTime ?? right?.timestamp ?? 0);
	return (rightTime - leftTime) || String(right?.id ?? "").localeCompare(String(left?.id ?? ""));
}

function canAuthoritativelyDeleteChat() {
	const primary = primaryActiveGm();
	if (primary) return Boolean(game.user?.isGM && primary.id === game.user.id);
	return true;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function actorFromUuidSync(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		return document instanceof foundry.documents.Actor ? document : null;
	} catch (_error) {
		return null;
	}
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}
