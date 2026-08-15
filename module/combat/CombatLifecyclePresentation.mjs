import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG_KEY = "damageState";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";

Hooks.once("init", () => {
	/*
	 * Damage application is now a visible action on the result itself. Keep one
	 * interaction contract and do not also hide the same action in the generic
	 * ChatMessage context menu.
	 */
	DamageChat.addContextMenuOptions = () => {};

	Hooks.on("renderChatMessageHTML", (message, html) => {
		relabelAdditionalDamageTest(message, html);
		decorateInlineDamageApplication(message, html);
		decorateDetailedCriticalResult(message, html);
		removeRevertedCriticalSourcePanel(message, html);
	});

	Hooks.on("createChatMessage", (message) => {
		void normalizeCriticalResultSpeaker(message);
	});

	Hooks.on("updateActor", (actor, changes) => {
		void removeRevertedCriticalResultMessages(actor, changes);
	});
});

/**
 * Core calls this an Additional Damage test. It is mechanically an unmodified
 * WS test, but presenting it as an ordinary "Weapon Skill" action makes the
 * reason for the extra d100 ambiguous in chat.
 */
function relabelAdditionalDamageTest(message, html) {
	const marker = message?.getFlag?.(
		FLAG_SCOPE,
		ADDITIONAL_DAMAGE_FLAG_KEY,
	);
	if (!marker) return;

	const root = asElement(html);
	const heading = root?.querySelector?.(
		".wfrp1e-test-card__header h2",
	);
	if (heading) {
		heading.textContent = localize(
			"Additional Damage",
			"Obrażenia dodatkowe",
		);
	}
}

/** Put Apply Damage directly on every actionable WFRP damage-bearing card. */
function decorateInlineDamageApplication(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return;

	const root = asElement(html);
	if (!root || root.querySelector("[data-wfrp-inline-apply-damage]")) {
		return;
	}

	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, state.packet.id)
		: state.application ?? null;

	if (transaction?.state === "reverted") return;
	if (!DamageChat.canApplyMessage(message)) return;

	const host =
		root.querySelector?.(".combat-damage-context__resolved") ??
		root.querySelector?.("[data-wfrp-damage-card]") ??
		root.querySelector?.(".wfrp1e-test-card") ??
		(root.matches?.("[data-wfrp-damage-card], .wfrp1e-test-card")
			? root
			: null);
	if (!host) return;

	const status = root.querySelector?.(".combat-damage-context__status");
	if (status && transaction?.state !== "applied") {
		status.textContent = localize(
			"Damage resolved — ready to apply.",
			"Obrażenia rozstrzygnięte — gotowe do zastosowania.",
		);
	}

	const action = document.createElement("button");
	action.type = "button";
	action.classList.add(
		"combat-damage-roll-button",
		"wfrp-inline-apply-damage",
	);
	action.dataset.wfrpInlineApplyDamage = "";
	action.innerHTML = `<i class="fa-solid fa-heart-crack"></i> ${localize(
		"Apply Damage",
		"Zastosuj obrażenia",
	)}`;
	action.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		action.disabled = true;
		void DamageChat.applyMessage(message).finally(() => {
			if (action.isConnected) {
				action.disabled = false;
			}
		});
	});
	host.append(action);
}

/**
 * Keep the detailed result compact: header, roll, resolved effect. Once a
 * persistent Critical Wound has been materialized, the chat result becomes a
 * terminal resolved record rather than a launcher for the Item sheet.
 */
function decorateDetailedCriticalResult(message, html) {
	const resultState = detailedCriticalResultState(message);
	if (!resultState) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-detailed-critical-card]")
		? root
		: root?.querySelector?.("[data-wfrp-detailed-critical-card]");
	if (!card) return;

	const meta = card.querySelector(
		"[data-wfrp-detailed-meta]",
	);
	meta?.remove();

	const roll = card.querySelector(
		"[data-wfrp-detailed-roll]",
	);
	if (roll) {
		roll.textContent = `${localize("Roll", "Rzut")}: ${
			resultState.resolution?.roll?.total ?? "—"
		}`;
	}

	const sourceMessage = game.messages?.get(
		String(resultState.sourceMessageId ?? ""),
	);
	const sourceState = sourceMessage?.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_FLAG_KEY,
	);
	const actor = actorFromUuidSync(sourceState?.packet?.targetActorUuid);
	if (!actor) return;

	const transaction = DamageApplication.transactionFor(
		actor,
		resultState.packetId,
	);
	if (transaction?.state === "reverted") {
		card.classList.add("is-wfrp-transaction-reverted");
		card.querySelector?.("[data-wfrp-critical-wound-application]")?.remove();
		return;
	}

	const wound = [...(actor.items ?? [])].find((item) =>
		item?.type === "criticalWound" &&
		String(item.system?.resolution?.resultMessageId ?? "") ===
			String(message.id ?? ""),
	);
	if (!wound) return;

	const application = card.querySelector?.(
		"[data-wfrp-critical-wound-application]",
	);
	if (!application) return;

	application.replaceChildren();
	const status = document.createElement("div");
	status.className = "wfrp1e-fate-intervention__spent";
	status.textContent = localize(
		"✓ Critical result applied — resolved",
		"✓ Trafienie krytyczne zastosowane — rozstrzygnięte",
	);
	application.append(status);
}

/** Reverted damage must not keep a stale "critical resolved" panel on source. */
function removeRevertedCriticalSourcePanel(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return;

	const actor = actorFromUuidSync(state.packet.targetActorUuid);
	if (!actor) return;
	const transaction = DamageApplication.transactionFor(actor, state.packet.id);
	if (transaction?.state !== "reverted") return;

	const root = asElement(html);
	root?.querySelector?.("[data-wfrp-detailed-critical-panel]")?.remove();
}

/**
 * A critical-result ChatMessage describes injury suffered by the damage target,
 * not an action performed by the attacker. Give the result the target's speaker
 * identity so the chat author label cannot imply that the attacker was injured.
 */
async function normalizeCriticalResultSpeaker(message) {
	const resultState = detailedCriticalResultState(message);
	if (!resultState || !message?.id) return;

	const authorId = String(
		message.user?.id ??
		message.author?.id ??
		"",
	);
	if (authorId && authorId !== String(game.user?.id ?? "")) return;
	if (!message.canUserModify?.(game.user, "update")) return;

	const sourceMessage = game.messages?.get(
		String(resultState.sourceMessageId ?? ""),
	);
	const state = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state) return;

	const actor = actorFromUuidSync(state.packet?.targetActorUuid);
	const targetName = String(
		actor?.name ??
		state.targetName ??
		"",
	).trim();
	if (!targetName) return;

	const speaker = actor
		? ChatMessage.getSpeaker({ actor })
		: {
			scene: null,
			actor: null,
			token: null,
			alias: targetName,
		};

	if (
		String(message.speaker?.actor ?? "") === String(speaker.actor ?? "") &&
		String(message.speaker?.alias ?? "") === String(speaker.alias ?? "")
	) {
		return;
	}

	await message.update({ speaker });
}

/** Delete derived critical result cards when their source damage is reverted. */
async function removeRevertedCriticalResultMessages(actor, changes) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	if (!isPrimaryActiveGM()) return;
	if (!damageApplicationsChanged(changes)) return;

	const applications = actor.getFlag?.(
		FLAG_SCOPE,
		DAMAGE_APPLICATIONS_FLAG_KEY,
	);
	if (!applications || typeof applications !== "object" || Array.isArray(applications)) {
		return;
	}

	const revertedPacketIds = new Set(
		Object.entries(applications)
			.filter(([, transaction]) => transaction?.state === "reverted")
			.map(([packetId, transaction]) =>
				String(transaction?.packetId ?? packetId),
			)
			.filter(Boolean),
	);
	if (revertedPacketIds.size === 0) return;

	const messages = [...(game.messages ?? [])].filter((message) => {
		const result = message.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
		return Boolean(
			result &&
			revertedPacketIds.has(String(result.packetId ?? "")) &&
			message.canUserModify?.(game.user, "delete"),
		);
	});

	for (const message of messages) {
		await message.delete();
	}
}

function detailedCriticalResultState(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, CRITICAL_RESULT_FLAG_KEY);
	return state &&
		typeof state === "object" &&
		!Array.isArray(state) &&
		(state.kind === "detailed" || state.resolution?.role === "detailed-chart")
		? state
		: null;
}

function damageApplicationsChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
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
		.sort((left, right) =>
			String(left.id).localeCompare(String(right.id)),
		)[0] ?? null;
}

function isPrimaryActiveGM() {
	return Boolean(
		game.user?.isGM &&
		primaryActiveGM()?.id === game.user.id,
	);
}

function asElement(html) {
	if (html instanceof HTMLElement) return html;
	if (html?.[0] instanceof HTMLElement) return html[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
