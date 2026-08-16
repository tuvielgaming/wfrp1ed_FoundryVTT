import { DamageApplication } from "../damage/DamageApplication.mjs";
import { CombatDefenceTransaction } from "../combat/CombatDefenceTransaction.mjs";

const FLAG_SCOPE = "wfrp1ed";
const PENDING_STANDARD_TEST_FLAG_KEY = "pendingStandardTest";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const CONTROL_ID = "wfrp1e-pending-interaction-control";
const CONTROL_BUTTON_ID = "wfrp1e-pending-interaction-button";
let navigationSignature = "";
let navigationIndex = 0;
let refreshQueued = false;

/**
 * GM reminder/navigation for unfinished WFRP interactions.
 *
 * Nothing is deleted automatically. At each forward round transition the GM is
 * warned when unresolved work remains. A small button beside the Chat input is
 * visible while at least one interaction is pending; repeated clicks walk from
 * the newest unresolved card backwards through the remaining queue.
 *
 * Combat stays pending through resolved positive Damage until Apply Damage has
 * created the authoritative Actor transaction. Zero-damage results are terminal
 * as soon as Damage is resolved because there is no Apply Damage action.
 */
Hooks.once("ready", () => {
	if (!game.user?.isGM) return;
	queuePendingControlRefresh();
});

Hooks.on("renderChatInput", (_app, elements) => {
	if (!game.user?.isGM) return;
	ensurePendingControl(elements);
	updatePendingControl();
});

Hooks.on("createChatMessage", () => queuePendingControlRefresh());
Hooks.on("updateChatMessage", () => queuePendingControlRefresh());
Hooks.on("deleteChatMessage", () => queuePendingControlRefresh());
Hooks.on("updateActor", () => queuePendingControlRefresh());

/*
 * combatTurnChange fires on every client after the Combat database update. A
 * warning is local to each connected GM; no ChatMessage noise is created.
 */
Hooks.on("combatTurnChange", (_combat, prior, current) => {
	if (!game.user?.isGM) return;
	const previousRound = positiveRound(prior?.round);
	const currentRound = positiveRound(current?.round);
	if (!previousRound || !currentRound || currentRound <= previousRound) return;

	const pending = pendingInteractions();
	queuePendingControlRefresh();
	if (!pending.length) return;

	ui.notifications.warn(localize(
		`${pending.length} unresolved WFRP interaction${pending.length === 1 ? "" : "s"} remain from earlier play. Use the Unresolved button above the Chat input to review them.`,
		`Pozostało ${pending.length} nierozstrzygniętych interakcji WFRP. Użyj przycisku Oczekujące nad polem czatu, aby je przejrzeć.`,
	));
});

function queuePendingControlRefresh() {
	if (!game.user?.isGM || refreshQueued) return;
	refreshQueued = true;
	requestAnimationFrame(() => {
		refreshQueued = false;
		ensurePendingControl();
		updatePendingControl();
	});
}

function ensurePendingControl(elements = null) {
	if (!game.user?.isGM) return null;

	const existing = document.getElementById(CONTROL_ID);
	if (existing?.isConnected) return existing;

	const host = chatInputHost(elements);
	if (!(host instanceof HTMLElement)) return null;

	const wrapper = document.createElement("div");
	wrapper.id = CONTROL_ID;
	wrapper.className = "wfrp1e-pending-interaction-control";
	wrapper.style.display = "none";
	wrapper.style.margin = "0 0 0.35rem";

	const button = document.createElement("button");
	button.id = CONTROL_BUTTON_ID;
	button.type = "button";
	button.className = "wfrp1e-pending-interaction-button";
	button.style.width = "100%";
	button.style.minHeight = "2rem";
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		void focusNextPendingInteraction().catch(reportNavigationError);
	});

	wrapper.append(button);
	host.prepend(wrapper);
	return wrapper;
}

function updatePendingControl() {
	if (!game.user?.isGM) return;
	const wrapper = document.getElementById(CONTROL_ID);
	const button = document.getElementById(CONTROL_BUTTON_ID);
	if (!(wrapper instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
		return;
	}

	const pending = pendingInteractions();
	if (!pending.length) {
		wrapper.style.display = "none";
		button.disabled = true;
		button.textContent = localize("Unresolved", "Oczekujące");
		navigationSignature = "";
		navigationIndex = 0;
		return;
	}

	wrapper.style.display = "block";
	button.disabled = false;
	button.textContent = localize(
		`⚠ Unresolved (${pending.length})`,
		`⚠ Oczekujące (${pending.length})`,
	);
	button.title = localize(
		`Focus the newest unresolved WFRP interaction. Click again for the next one. Next: ${pending[0].stage}.`,
		`Pokaż najnowszą nierozstrzygniętą interakcję WFRP. Kliknij ponownie, aby przejść do następnej. Następna: ${pending[0].stage}.`,
	);
}

async function focusNextPendingInteraction() {
	const pending = pendingInteractions();
	if (!pending.length) {
		updatePendingControl();
		return;
	}

	const signature = pending.map((entry) => entry.key).join("|");
	if (signature !== navigationSignature) {
		navigationSignature = signature;
		navigationIndex = 0;
	}

	if (navigationIndex >= pending.length) navigationIndex = 0;
	const entry = pending[navigationIndex];
	navigationIndex = (navigationIndex + 1) % pending.length;

	ui.chat?.activate?.();
	await nextFrame();

	const element = await ensureChatMessageRendered(entry.focusMessage.id);
	if (!(element instanceof HTMLElement)) {
		ui.notifications.warn(localize(
			`The unresolved ${entry.stage} card could not be brought into the current Chat history.`,
			`Nie udało się odnaleźć karty oczekującej interakcji: ${entry.stage}.`,
		));
		return;
	}

	element.scrollIntoView?.({
		behavior: "smooth",
		block: "center",
		inline: "nearest",
	});

	try {
		element.animate(
			[
				{ outline: "0 solid currentColor", outlineOffset: "0" },
				{ outline: "3px solid currentColor", outlineOffset: "3px" },
				{ outline: "0 solid currentColor", outlineOffset: "0" },
			],
			{ duration: 1100, easing: "ease-out" },
		);
	} catch (_error) {
		/* Scrolling is the important behavior; highlighting is best-effort only. */
	}
}

async function ensureChatMessageRendered(messageId) {
	const id = String(messageId ?? "").trim();
	if (!id) return null;

	let element = chatMessageElement(id);
	if (element) return element;

	/*
	 * ChatLog renders recent history in batches. Pending work can survive for
	 * several rounds, so prepend a few history batches before giving up.
	 */
	for (let attempt = 0; attempt < 8; attempt += 1) {
		if (typeof ui.chat?.renderBatch !== "function") break;
		try {
			await ui.chat.renderBatch(50);
		} catch (_error) {
			break;
		}
		await nextFrame();
		element = chatMessageElement(id);
		if (element) return element;
	}

	return null;
}

function pendingInteractions() {
	if (!game.user?.isGM) return [];
	const pending = [];

	for (const message of game.messages ?? []) {
		const standard = message.getFlag?.(FLAG_SCOPE, PENDING_STANDARD_TEST_FLAG_KEY);
		if (standard?.status === "pending") {
			pending.push({
				key: `standard:${message.id}`,
				sourceMessage: message,
				focusMessage: message,
				stage: localize(
					`Standard Test — ${String(standard.testId ?? "target data")}`,
					`Test Standardowy — ${String(standard.testId ?? "dane celu")}`,
				),
				createdAt: messageTimestamp(message, standard.createdAt),
			});
			continue;
		}

		const attack = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (!attack) continue;
		const combatPending = pendingCombatInteraction(message, attack);
		if (combatPending) pending.push(combatPending);
	}

	return pending.sort((left, right) => right.createdAt - left.createdAt);
}

function pendingCombatInteraction(sourceMessage, attack) {
	if (
		attack?.family !== "melee" ||
		attack?.targetMode !== "defender"
	) return null;

	const outcome = CombatDefenceTransaction.outcomeForAttack(sourceMessage);
	if (!outcome) {
		return combatPending(sourceMessage, sourceMessage, attack, localize(
			"Attack / defence resolution",
			"Rozstrzygnięcie ataku / obrony",
		));
	}
	if (!outcome.attackHit) return null;

	if (outcome.defenceStatus !== "resolved") {
		return combatPending(sourceMessage, sourceMessage, attack, localize(
			"Defence",
			"Obrona",
		));
	}

	if (outcome.dodgeSucceeded || !outcome.continueToDamage) return null;

	const damage = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const roll = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);

	if (!damage?.packet?.id) {
		if (roll?.status === "awaiting-parry") {
			const defenceMessage = attack.defence?.testMessageId
				? game.messages?.get(String(attack.defence.testMessageId))
				: null;
			return combatPending(
				sourceMessage,
				defenceMessage ?? sourceMessage,
				attack,
				localize("Parry damage reduction", "Redukcja obrażeń parowania"),
			);
		}
		return combatPending(sourceMessage, sourceMessage, attack, localize(
			"Damage roll",
			"Rzut obrażeń",
		));
	}

	const actor = actorFromUuidSync(damage.packet.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, damage.packet.id)
		: damage.application ?? null;

	if (transaction?.state === "applied") return null;

	const finalAmount = Number(damage.resolution?.finalAmount ?? 0);
	if (Number.isFinite(finalAmount) && finalAmount <= 0 && transaction?.state !== "reverted") {
		return null;
	}

	if (transaction?.state === "reverted") {
		return combatPending(sourceMessage, sourceMessage, attack, localize(
			"Damage reroll",
			"Ponowny rzut obrażeń",
		));
	}

	const damageView = findDamageResultView(sourceMessage.id, damage.packet.id);
	return combatPending(
		sourceMessage,
		damageView ?? sourceMessage,
		attack,
		localize("Apply Damage", "Zastosuj obrażenia"),
	);
}

function combatPending(sourceMessage, focusMessage, attack, stage) {
	return {
		key: `combat:${sourceMessage.id}`,
		sourceMessage,
		focusMessage,
		stage,
		createdAt: messageTimestamp(sourceMessage, attack?.createdAt),
	};
}

function findDamageResultView(sourceMessageId, packetId) {
	const sourceId = String(sourceMessageId ?? "");
	const packet = String(packetId ?? "");
	if (!sourceId || !packet) return null;

	return [...(game.messages ?? [])].find((message) => {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		return String(view?.sourceAttackMessageId ?? "") === sourceId &&
			String(view?.packetId ?? "") === packet;
	}) ?? null;
}

function chatInputHost(elements) {
	for (const element of Object.values(elements ?? {})) {
		if (!(element instanceof HTMLElement)) continue;
		if (
			element.matches?.("[data-application-part='input'], form") ||
			element.querySelector?.("textarea, [contenteditable='true']")
		) return element;
	}

	const chatRoot = ui.chat?.element instanceof HTMLElement
		? ui.chat.element
		: null;
	const fromChat = chatRoot?.querySelector?.(
		"[data-application-part='input'], #chat-form, .chat-form",
	);
	if (fromChat instanceof HTMLElement) return fromChat;

	const fallback = document.querySelector(
		"#chat-form, .chat-form, [data-application-part='input']",
	);
	return fallback instanceof HTMLElement ? fallback : null;
}

function chatMessageElement(messageId) {
	const escaped = cssEscape(messageId);
	return document.querySelector(`[data-message-id="${escaped}"]`);
}

function cssEscape(value) {
	const text = String(value ?? "");
	return globalThis.CSS?.escape ? CSS.escape(text) : text.replaceAll('"', '\\"');
}

function messageTimestamp(message, fallback) {
	const timestamp = Number(message?.timestamp ?? fallback ?? 0);
	return Number.isFinite(timestamp) ? timestamp : 0;
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

function nextFrame() {
	return new Promise((resolve) => requestAnimationFrame(resolve));
}

function reportNavigationError(error) {
	console.error("WFRP1ED | Unable to focus pending interaction.", error);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to focus the unresolved interaction.",
			"Nie udało się przejść do nierozstrzygniętej interakcji.",
		),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
