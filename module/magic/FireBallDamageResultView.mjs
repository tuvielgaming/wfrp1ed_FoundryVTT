import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import {
	DAMAGE_CRITICAL_MODE,
	DAMAGE_MITIGATION_POLICY,
	DamagePacket,
} from "../damage/DamagePacket.mjs";
import { DamageResolution } from "../damage/DamageResolution.mjs";
import { DamageResolver } from "../damage/DamageResolver.mjs";
import { TestResultChat } from "../tests/TestResultChat.mjs";
import { TestResultModifierToggle } from "../tests/TestResultModifierToggle.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const DAMAGE_FLAG_KEY = "damageState";
const VIEW_FLAG_KEY = "fireBallDamageResultView";
const ACTOR_TEST_FLAG_KEY = "actorTestRequest";
const TEST_FLAG_KEY = "testResultState";
const INLINE_TEST_FLAG_KEY = "fireBallInlineTest";
const SOCKET_CHANNEL = "system.wfrp1ed";
const REQUEST_TYPE = "fire-ball-damage-view-action-request";
const RESPONSE_TYPE = "fire-ball-damage-view-action-response";
const TIMEOUT_MS = 30000;
const STRENGTH = 3;
const pending = new Map();
const active = new Set();
const reconcilingSources = new Set();
let installed = false;

/**
 * Fire Ball presentation/adjudication bridge.
 *
 * The impact ChatMessage is the permanent spell-resolution transaction. It owns
 * target/vulnerability state and mirrors the linked Initiative/Fear Tests. It
 * must never disappear merely because a derived damage value changes.
 *
 * The dedicated Damage ChatMessage is a derived view of the same DamagePacket.
 * It intentionally contains damage only: Fire Ball d10, optional ignition d8,
 * folded calculation detail and the system-wide DamageChat application state.
 * This mirrors the melee/ranged split between the attack/defence transaction
 * and its dedicated damage result instead of implementing a second damage card.
 */
export function installFireBallDamageResultView() {
	if (installed) return;
	installed = true;

	Hooks.on("createChatMessage", (message) => {
		if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) {
			void ensureDamageView(message).catch(reportError);
		}
	});

	Hooks.on("updateChatMessage", (message, changes) => {
		if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) {
			void ensureDamageView(message).catch(reportError);
		}
		if (testStateChanged(changes)) {
			void reconcileLinkedTest(message).catch(reportError);
		}
	});

	Hooks.on("renderChatMessageHTML", (message, html) => {
		requestAnimationFrame(() => {
			decorateDamageView(message, html);
			decorateImpactSource(message, html);
			hideFireBallTestPlumbing(message, html);
		});
	});

	Hooks.once("ready", () => {
		game.socket?.on?.(SOCKET_CHANNEL, (payload) => void handleSocket(payload));
		if (!ActorRollPolicy.isPrimaryActiveGM()) return;
		for (const message of game.messages ?? []) {
			if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) {
				void ensureDamageView(message).catch(reportError);
			}
		}
	});
}

async function ensureDamageView(sourceMessage) {
	if (!ActorRollPolicy.isPrimaryActiveGM()) return null;
	const impact = sourceMessage?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) return null;

	const existing = findView(sourceMessage.id);
	if (!impact.damage) {
		if (existing && existing.canUserModify?.(game.user, "delete")) {
			const transaction = transactionForView(existing);
			if (!transaction || transaction.state !== "applied") await existing.delete();
		}
		return null;
	}

	const damageState = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	/* DamageChat.attach and the impact flag are two Document updates. During the
	 * short interval between them keep the current view rather than deleting and
	 * recreating it. */
	if (!damageState?.packet || !damageState?.resolution) return existing ?? null;

	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	if (!target) return null;
	const packet = DamagePacket.fromJSON(damageState.packet);
	const resolution = DamageResolution.fromJSON(damageState.resolution);
	const transaction = DamageApplication.transactionFor(target, packet.id);
	const standalone = DamageChat._state(packet, resolution, "standalone", target.name);
	standalone.application = transaction ? foundry.utils.deepClone(transaction) : null;
	const baseContent = await DamageChat._render(standalone, target, transaction);
	const content = fireBallDamageContent(baseContent, impact, damageState);
	const previousView = existing?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
	const viewState = {
		version: 2,
		sourceImpactMessageId: String(sourceMessage.id),
		packetId: String(packet.id),
		targetActorUuid: String(target.uuid),
		createdAt: previousView?.createdAt ?? Date.now(),
		updatedAt: Date.now(),
	};

	if (existing) {
		await existing.update({
			content,
			[`flags.${FLAG_SCOPE}.${DAMAGE_FLAG_KEY}`]: standalone,
			[`flags.${FLAG_SCOPE}.${VIEW_FLAG_KEY}`]: viewState,
		});
		return existing;
	}

	return ChatMessage.create({
		speaker: ChatMessage.getSpeaker({ actor: target }),
		content,
		whisper: foundry.utils.deepClone(sourceMessage.whisper ?? []),
		blind: sourceMessage.blind === true,
		flags: {
			[FLAG_SCOPE]: {
				[DAMAGE_FLAG_KEY]: standalone,
				[VIEW_FLAG_KEY]: viewState,
			},
		},
	});
}

function fireBallDamageContent(baseContent, impact, damageState) {
	const template = document.createElement("template");
	template.innerHTML = String(baseContent ?? "").trim();
	const card = template.content.querySelector("[data-wfrp-damage-card]");
	if (!card) return String(baseContent ?? "");

	/* DamageChat supplies the shell/status. Replace only the generic body with
	 * the two spell damage components requested by the spell transaction. */
	for (const element of card.querySelectorAll(
		":scope > .wfrp1e-damage-card__row, :scope > .wfrp1e-damage-card__mitigation",
	)) element.remove();

	const status = card.querySelector("[data-wfrp-damage-status]");
	const hint = card.querySelector(".wfrp1e-damage-card__hint");
	const before = status ?? hint ?? null;

	insertBefore(card, damageDieRow({
		kind: "d10",
		label: localize("Fire Ball", "Ognista Kula"),
		faces: 10,
		value: impact.damage?.damageRoll,
	}), before);

	if (impact.flammable && isDieValue(impact.damage?.flammableRoll, 8)) {
		insertBefore(card, damageDieRow({
			kind: "d8",
			label: localize("Ignition", "Podpalenie"),
			faces: 8,
			value: impact.damage.flammableRoll,
		}), before);
	}

	const details = document.createElement("details");
	details.className = "wfrp1e-damage-card__details";
	details.dataset.wfrpDisclosureKey = "fire-ball-damage-details";
	const summary = document.createElement("summary");
	summary.textContent = localize("Damage details", "Szczegóły obrażeń");
	const body = document.createElement("div");
	body.className = "wfrp1e-damage-card__details-body combat-damage-context__details-body";
	body.append(
		detailRow(localize("Strength", "Siła"), `+${STRENGTH}`),
		detailRow(
			localize("Damage Reduction - Initiative", "Redukcja obrażeń — Inicjatywa"),
			currentInitiativeOutcome(impact).success
				? localize("success — half", "sukces — połowa")
				: localize("failure — full", "porażka — pełne"),
		),
		detailRow(localize("Armour", "Pancerz"), localize("ignored", "pominięty")),
		detailRow(
			localize("Toughness", "Wytrzymałość"),
			`−${nonNegativeInteger(impact.damage?.toughness)}`,
		),
		detailRow(
			localize("Final", "Wynik końcowy"),
			String(damageState?.resolution?.finalAmount ?? impact.damage?.finalDamage ?? 0),
		),
	);
	details.append(summary, body);
	insertBefore(card, details, before);
	return template.innerHTML;
}

function decorateDamageView(message, html) {
	const view = message?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
	if (!view) return;
	const source = game.messages?.get(String(view.sourceImpactMessageId ?? ""));
	const impact = source?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!source || !impact) return;
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!card) return;

	bindDamageDie(card, source, impact, "d10");
	bindDamageDie(card, source, impact, "d8");
}

/** Keep the Fire Ball source card as the permanent resolution record. */
function decorateImpactSource(message, html) {
	const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-impact-workflow]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-impact-workflow]");
	if (!(panel instanceof HTMLElement)) return;

	/* Final damage belongs to the dedicated Damage card, not the spell header. */
	panel.querySelector(":scope > .wfrp1e-damage-card__header .wfrp1e-damage-card__amount")?.remove();

	if (impact.status === "awaiting-initiative") {
		compactPendingInitiative(panel, message, impact);
	} else if (impact.initiative) {
		compactInitiativeRow(panel, message, impact);
	}

	if (impact.fearOfFire) appendFearRow(panel, message, impact);

	if (impact.damage) {
		/* The source transaction must not duplicate the damage result. */
		for (const row of panel.querySelectorAll(":scope > .wfrp-fireball-die-row")) row.remove();
		for (const details of panel.querySelectorAll(
			":scope > details.combat-damage-context__resolved, :scope > details.wfrp1e-damage-card__details",
		)) details.remove();
		for (const button of panel.querySelectorAll(":scope > .wfrp1e-damage-card__apply")) button.remove();
	}
}

function compactPendingInitiative(panel, source, impact) {
	for (const status of panel.querySelectorAll(":scope > .combat-damage-context__status")) {
		status.remove();
	}
	const original = [...panel.querySelectorAll(":scope > button.combat-damage-roll-button")]
		.find((button) => /initiative|inicjatyw/i.test(String(button.textContent ?? "")));
	if (!original) return;

	const button = original.cloneNode(true);
	button.textContent = localize("Roll", "Rzuć");
	button.disabled = !ActorRollPolicy.canAdjudicate(
		ActorRollPolicy.actorFromUuidSync(impact.targetUuid),
		game.user,
	);
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		button.disabled = true;
		void requestMutation(source, "initiative-roll")
			.catch(reportError)
			.finally(() => {
				if (button.isConnected) button.disabled = false;
			});
	});

	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row wfrp-fireball-initiative-row";
	row.dataset.fireBallCompactInitiative = "";
	const label = document.createElement("span");
	label.textContent = localize(
		"Damage Reduction - Initiative",
		"Redukcja obrażeń — Inicjatywa",
	);
	row.append(label, button);
	original.replaceWith(row);
}

function compactInitiativeRow(panel, source, impact) {
	const row = panel.querySelector(":scope > .wfrp-fireball-initiative-row");
	if (!(row instanceof HTMLElement)) return;
	const label = row.querySelector(":scope > span:first-child");
	if (label) {
		label.textContent = localize(
			"Damage Reduction - Initiative",
			"Redukcja obrażeń — Inicjatywa",
		);
	}

	const outcome = currentInitiativeOutcome(impact);
	const editor = row.querySelector(".wfrp-fireball-inline-roll");
	const oldInput = editor?.querySelector("input[type='number']");
	if (oldInput instanceof HTMLInputElement) {
		const input = oldInput.cloneNode(true);
		input.value = String(outcome.roll ?? "");
		const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
		input.disabled = !ActorRollPolicy.canAdjudicate(target, game.user) || hasAppliedDamage(source, target);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") input.blur();
		});
		input.addEventListener("change", () => {
			void requestMutation(source, "initiative", { value: input.value }).catch(reportError);
		});
		oldInput.replaceWith(input);
	}
	const strong = editor?.querySelector("strong");
	if (strong) strong.textContent = testOutcomeLabel(outcome);
}

function appendFearRow(panel, source, impact) {
	panel.querySelector(":scope > [data-fire-ball-fear-test-row]")?.remove();
	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	if (!target) return;
	const resultMessage = fearResultMessage(impact);
	const testState = resultMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);

	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row";
	row.dataset.fireBallFearTestRow = "";
	const label = document.createElement("span");
	label.textContent = localize("Fear Test", "Test Strachu");

	if (testState) {
		const outcome = TestResultChat._templateContext(testState).result;
		const editor = document.createElement("span");
		editor.className = "wfrp-fireball-inline-roll";
		const input = document.createElement("input");
		input.type = "number";
		input.min = "1";
		input.max = "100";
		input.step = "1";
		input.inputMode = "numeric";
		input.value = String(outcome.roll ?? testState.roll ?? "");
		input.className = "wfrp-fireball-inline-roll__input";
		input.disabled = !ActorRollPolicy.canAdjudicate(target, game.user);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") input.blur();
		});
		input.addEventListener("change", () => {
			void requestMutation(source, "fear", { value: input.value }).catch(reportError);
		});
		const result = document.createElement("strong");
		result.textContent = testOutcomeLabel(outcome);
		editor.append(input, result);
		row.append(label, editor);
	} else {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "combat-damage-roll-button";
		button.textContent = localize("Roll", "Rzuć");
		button.disabled = !ActorRollPolicy.canAdjudicate(target, game.user);
		button.addEventListener("click", () => {
			button.disabled = true;
			void requestMutation(source, "fear-roll")
				.catch(reportError)
				.finally(() => {
					if (button.isConnected) button.disabled = false;
				});
		});
		row.append(label, button);
	}

	const initiative = panel.querySelector(":scope > .wfrp-fireball-initiative-row");
	if (initiative) initiative.after(row);
	else panel.append(row);
}

/**
 * ActorTestRequest is plumbing for assigning the Fear roll to the target owner;
 * once Fire Ball presents that action on its own transaction card the request
 * card would be redundant. The actual Fear TestResult remains visible as the
 * canonical result/audit card.
 */
function hideFireBallTestPlumbing(message, html) {
	const request = message?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	const inline = message?.getFlag?.(FLAG_SCOPE, INLINE_TEST_FLAG_KEY);
	const shouldHide = request?.source?.kind === "spell-fire-ball" || inline?.role === "initiative";
	if (!shouldHide) return;
	const root = asElement(html);
	const entry = root?.closest?.(".chat-message, li.message, li.chat-message");
	if (entry instanceof HTMLElement) entry.style.display = "none";
	else if (root instanceof HTMLElement) root.hidden = true;
}

function bindDamageDie(card, source, impact, kind) {
	const input = card.querySelector(`[data-fire-ball-damage-die="${kind}"]`);
	if (!(input instanceof HTMLInputElement)) return;
	const caster = ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	input.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user) || hasAppliedDamage(source, target);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") input.blur();
	});
	input.addEventListener("change", () => {
		void requestMutation(source, kind, { value: input.value }).catch(reportError);
	});
}

async function requestMutation(source, action, extra = {}) {
	const impact = source?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) throw new Error("This Fire Ball impact is no longer available.");
	const targetOwnedActions = new Set(["initiative-roll", "initiative", "fear-roll", "fear"]);
	const actor = targetOwnedActions.has(action)
		? ActorRollPolicy.actorFromUuidSync(impact.targetUuid)
		: ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
	if (!ActorRollPolicy.canAdjudicate(actor, game.user)) {
		throw new Error(localize(
			"You may not adjudicate this roll.",
			"Nie masz uprawnień do rozstrzygnięcia tego rzutu.",
		));
	}
	if (ActorRollPolicy.isPrimaryActiveGM()) {
		return mutateAsAuthority(source, action, game.user, extra);
	}
	const gm = ActorRollPolicy.primaryActiveGM();
	if (!gm || !game.socket) {
		throw new Error(localize("An active GM is required.", "Wymagany jest aktywny MG."));
	}

	const requestId = foundry.utils.randomID();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error(localize(
				"The GM did not resolve the edit in time.",
				"MG nie rozstrzygnął zmiany w wymaganym czasie.",
			)));
		}, TIMEOUT_MS);
		pending.set(requestId, { resolve, reject, timeout });
		game.socket.emit(SOCKET_CHANNEL, {
			type: REQUEST_TYPE,
			requestId,
			requestUserId: String(game.user?.id ?? ""),
			sourceMessageId: String(source.id ?? ""),
			action,
			extra,
		});
	});
}

async function handleSocket(payload) {
	if (!payload || typeof payload !== "object") return;
	if (payload.type === RESPONSE_TYPE) {
		if (String(payload.requestUserId ?? "") !== String(game.user?.id ?? "")) return;
		const entry = pending.get(String(payload.requestId ?? ""));
		if (!entry) return;
		pending.delete(String(payload.requestId ?? ""));
		clearTimeout(entry.timeout);
		if (payload.ok) entry.resolve(payload.result ?? null);
		else entry.reject(new Error(String(payload.error ?? "Unable to edit Fire Ball resolution.")));
		return;
	}
	if (payload.type !== REQUEST_TYPE || !ActorRollPolicy.isPrimaryActiveGM()) return;

	const requester = game.users?.get(String(payload.requestUserId ?? ""));
	const source = game.messages?.get(String(payload.sourceMessageId ?? ""));
	const response = {
		type: RESPONSE_TYPE,
		requestId: String(payload.requestId ?? ""),
		requestUserId: String(payload.requestUserId ?? ""),
		ok: false,
		result: null,
		error: null,
	};
	try {
		if (!requester || !source) throw new Error("The Fire Ball source is unavailable.");
		response.result = await mutateAsAuthority(
			source,
			String(payload.action ?? ""),
			requester,
			payload.extra ?? {},
		);
		response.ok = true;
	} catch (error) {
		response.error = error?.message ?? "Unable to edit Fire Ball resolution.";
	}
	game.socket.emit(SOCKET_CHANNEL, response);
}

async function mutateAsAuthority(source, action, requester, extra = {}) {
	const key = `${source.id}:${action}`;
	if (active.has(key)) return null;
	const impact = foundry.utils.deepClone(
		source.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY) ?? {},
	);
	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	const caster = ActorRollPolicy.actorFromUuidSync(impact.casterUuid);
	if (!target || !caster) throw new Error("The Fire Ball caster or target is unavailable.");

	const targetOwnedActions = new Set(["initiative-roll", "initiative", "fear-roll", "fear"]);
	const ownedActor = targetOwnedActions.has(action) ? target : caster;
	if (!ActorRollPolicy.canAdjudicate(ownedActor, requester)) {
		throw new Error("The requesting user does not own this roll.");
	}
	if (hasAppliedDamage(source, target)) {
		throw new Error(localize(
			"Revert applied Fire Ball damage before changing this resolution.",
			"Cofnij zastosowane obrażenia Ognistej Kuli przed zmianą tego rozstrzygnięcia.",
		));
	}

	active.add(key);
	try {
		if (action === "initiative-roll") {
			if (impact.status !== "awaiting-initiative") return impact;
			const result = await target.rollTest("i", { modifier: 0 });
			if (!result?.chatMessage) throw new Error("Initiative Test did not produce a ChatMessage.");
			await result.chatMessage.setFlag(FLAG_SCOPE, INLINE_TEST_FLAG_KEY, {
				version: 1,
				role: "initiative",
				sourceImpactMessageId: String(source.id),
			});
			impact.initiative = initiativeSnapshotFromMessage(result.chatMessage, impact.initiative);
			impact.initiative.testMessageId = String(result.chatMessage.id);
			impact.status = "awaiting-damage";
			impact.updatedBy = String(requester?.id ?? "");
			impact.updatedAt = Date.now();
			await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
			requestChatRefresh();
			return impact;
		}

		if (action === "initiative") {
			const roll = boundedInteger(extra.value, 1, 100, "Initiative d100");
			const testMessage = initiativeTestMessage(impact);
			if (testMessage) {
				await TestResultModifierToggle.commitRollValue(testMessage, roll, requester);
				impact.initiative = initiativeSnapshotFromMessage(testMessage, impact.initiative);
				impact.initiative.testMessageId = String(testMessage.id);
			} else {
				/* Compatibility for casts made before Initiative became a linked Test. */
				if (!impact.initiative) throw new Error("Initiative has not been resolved yet.");
				impact.initiative.roll = roll;
				impact.initiative.success = roll <= Number(impact.initiative.target);
			}
			return persistInitiativeChange(source, impact, target, caster, requester);
		}

		if (action === "fear-roll") {
			if (!impact.fearOfFire) throw new Error("Fear of Fire is not active for this target.");
			const request = fearRequestMessage(impact);
			const existingResult = fearResultMessage(impact);
			if (existingResult) return impact;
			const result = await target.rollTest("fear", { modifier: 0 });
			if (!result?.chatMessage) throw new Error("Fear Test did not produce a ChatMessage.");
			if (request?.canUserModify?.(game.user, "update")) {
				const state = foundry.utils.deepClone(
					request.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY) ?? {},
				);
				state.status = "resolved";
				state.resultMessageId = String(result.chatMessage.id);
				state.resolvedBy = String(requester?.id ?? "");
				state.resolvedAt = Date.now();
				await request.setFlag(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY, state);
			}
			requestChatRefresh();
			return impact;
		}

		if (action === "fear") {
			const resultMessage = fearResultMessage(impact);
			if (!resultMessage) throw new Error("Fear Test has not been resolved yet.");
			const roll = boundedInteger(extra.value, 1, 100, "Fear d100");
			await TestResultModifierToggle.commitRollValue(resultMessage, roll, requester);
			requestChatRefresh();
			return impact;
		}

		if (action === "d10" || action === "d8") {
			if (!impact.damage) throw new Error("Fire Ball damage has not been rolled yet.");
			if (action === "d10") {
				impact.damage.damageRoll = boundedInteger(extra.value, 1, 10, "Fire Ball d10");
			} else {
				if (!impact.flammable) throw new Error("Ignition damage is not active.");
				impact.damage.flammableRoll = boundedInteger(extra.value, 1, 8, "Ignition d8");
			}
			return recalculateDamage(source, impact, target, caster, requester);
		}

		throw new Error(`Unknown Fire Ball damage-view action '${action}'.`);
	} finally {
		active.delete(key);
	}
}

async function persistInitiativeChange(source, impact, target, caster, requester) {
	if (impact.damage) {
		return recalculateDamage(source, impact, target, caster, requester);
	}
	impact.updatedBy = String(requester?.id ?? "");
	impact.updatedAt = Date.now();
	await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
	requestChatRefresh();
	return impact;
}

async function recalculateDamage(source, impact, target, caster, requester) {
	if (!impact.initiative || !impact.damage) {
		throw new Error("Initiative and Fire Ball damage must already exist.");
	}
	const initiative = currentInitiativeOutcome(impact);
	const d10 = boundedInteger(impact.damage.damageRoll, 1, 10, "Fire Ball d10");
	const d8 = impact.flammable
		? boundedInteger(impact.damage.flammableRoll, 1, 8, "Ignition d8")
		: 0;
	const fullDamage = STRENGTH + d10 + d8;
	const afterInitiative = initiative.success ? Math.floor(fullDamage / 2) : fullDamage;
	const toughness = nonNegativeInteger(target.getCharacteristicValue("t"));
	const existingState = source.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const packet = new DamagePacket({
		id: existingState?.packet?.id ?? impact.damage?.packetId ?? null,
		rawAmount: afterInitiative,
		targetActorUuid: target.uuid,
		source: existingState?.packet?.source ?? {
			kind: "spell-fire-ball",
			id: `${impact.castId || impact.spellUuid}-ball-${impact.ballNumber}-${target.id}`,
			uuid: String(impact.spellUuid ?? ""),
			label: String(impact.spellName ?? localize("Fire Ball", "Ognista Kula")),
		},
		armour: DAMAGE_MITIGATION_POLICY.IGNORE,
		toughness: DAMAGE_MITIGATION_POLICY.APPLY,
		criticalMode: DAMAGE_CRITICAL_MODE.DETAILED,
	});
	const resolution = DamageResolver.resolve(packet, {
		toughness: { value: toughness },
	});
	await DamageChat.attach(source, { packet, resolution });
	impact.status = "resolved";
	impact.initiative = {
		...impact.initiative,
		roll: initiative.roll,
		target: initiative.target,
		success: initiative.success,
		margin: initiative.margin,
	};
	impact.damage = {
		...impact.damage,
		packetId: packet.id,
		damageRoll: d10,
		flammableRoll: d8,
		fullDamage,
		afterInitiative,
		toughness,
		finalDamage: resolution.finalAmount,
		updatedBy: String(requester?.id ?? ""),
		updatedAt: Date.now(),
	};
	impact.updatedBy = String(requester?.id ?? "");
	impact.updatedAt = Date.now();
	await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, impact);
	await ensureDamageView(source);
	requestChatRefresh();
	return impact;
}

async function reconcileLinkedTest(testMessage) {
	const testId = String(testMessage?.id ?? "").trim();
	if (!testId) return;
	const source = sourceForLinkedTest(testId);
	if (!source) return;
	const impact = source.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	if (!impact) return;

	/* Fear changes only affect psychology presentation. */
	if (String(fearResultMessage(impact)?.id ?? "") === testId) {
		requestChatRefresh();
		return;
	}
	if (String(initiativeTestMessage(impact)?.id ?? "") !== testId) return;
	if (!ActorRollPolicy.isPrimaryActiveGM()) {
		requestChatRefresh();
		return;
	}
	if (reconcilingSources.has(source.id)) return;

	reconcilingSources.add(source.id);
	try {
		const updated = foundry.utils.deepClone(impact);
		updated.initiative = initiativeSnapshotFromMessage(testMessage, updated.initiative);
		updated.initiative.testMessageId = testId;
		const target = ActorRollPolicy.actorFromUuidSync(updated.targetUuid);
		const caster = ActorRollPolicy.actorFromUuidSync(updated.casterUuid);
		if (!target || !caster) return;
		if (updated.damage && !hasAppliedDamage(source, target)) {
			await recalculateDamage(source, updated, target, caster, game.user);
		} else {
			updated.updatedAt = Date.now();
			await source.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, updated);
		}
	} finally {
		reconcilingSources.delete(source.id);
		requestChatRefresh();
	}
}

function currentInitiativeOutcome(impact) {
	const testMessage = initiativeTestMessage(impact);
	const testState = testMessage?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (testState) {
		const result = TestResultChat._templateContext(testState).result;
		return {
			roll: Number(result.roll),
			target: Number(result.target),
			success: result.success === true,
			margin: Number(result.margin),
		};
	}
	const initiative = impact?.initiative ?? {};
	return {
		roll: Number(initiative.roll),
		target: Number(initiative.target),
		success: initiative.success === true,
		margin: Number(initiative.margin),
	};
}

function initiativeSnapshotFromMessage(message, previous = null) {
	const state = message?.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY);
	if (!state) throw new Error("Linked Initiative Test has no TestResult snapshot.");
	const result = TestResultChat._templateContext(state).result;
	return {
		...(previous ?? {}),
		roll: Number(result.roll),
		originalRoll: Number(previous?.originalRoll ?? state.originalRoll ?? state.roll ?? result.roll),
		target: Number(result.target),
		success: result.success === true,
		margin: Number(result.margin),
		testMessageId: String(message.id ?? ""),
	};
}

function sourceForLinkedTest(testMessageId) {
	for (const message of game.messages ?? []) {
		const impact = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
		if (!impact) continue;
		if (String(impact.initiative?.testMessageId ?? "") === testMessageId) return message;
		if (String(fearResultMessage(impact)?.id ?? "") === testMessageId) return message;
	}
	return null;
}

function initiativeTestMessage(impact) {
	const id = String(impact?.initiative?.testMessageId ?? "").trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function fearRequestMessage(impact) {
	const id = String(impact?.fearRequestMessageId ?? "").trim();
	if (id) return game.messages?.get(id) ?? null;
	for (const message of game.messages ?? []) {
		const request = message.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
		if (
			request?.source?.kind === "spell-fire-ball" &&
			String(request.source?.castId ?? "") === String(impact?.castId ?? "") &&
			String(request.actorUuid ?? "") === String(impact?.targetUuid ?? "")
		) return message;
	}
	return null;
}

function fearResultMessage(impact) {
	const request = fearRequestMessage(impact);
	const state = request?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG_KEY);
	const id = String(state?.resultMessageId ?? "").trim();
	return id ? game.messages?.get(id) ?? null : null;
}

function damageDieRow({ kind, label, faces, value }) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row wfrp1e-damage-card__roll-row";
	const text = document.createElement("span");
	text.textContent = label;
	const roll = document.createElement("div");
	roll.className = "wfrp1e-damage-roll";
	roll.append(nativeDieResult(faces, value));
	const equals = document.createElement("span");
	equals.className = "wfrp1e-damage-roll__operator";
	equals.textContent = "=";
	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.max = String(faces);
	input.step = "1";
	input.inputMode = "numeric";
	input.value = String(value ?? "");
	input.className = "wfrp1e-damage-roll__total";
	input.dataset.fireBallDamageDie = kind;
	roll.append(equals, input);
	row.append(text, roll);
	return row;
}

/** Use Foundry's native .dice-tooltip/.dice-rolls/.roll.die.dN contract. */
function nativeDieResult(faces, value) {
	const tooltip = document.createElement("div");
	tooltip.className = "dice-tooltip wfrp-fireball-native-die-tooltip";
	/* Core normally expands this container from a roll card. Here one physical
	 * result is always visible, so only the container visibility is overridden;
	 * the die artwork itself remains Foundry's native d8/d10 rendering. */
	tooltip.style.display = "inline-block";
	tooltip.style.flex = "0 0 auto";
	const dice = document.createElement("ol");
	dice.className = "dice-rolls wfrp-fireball-native-die";
	const die = document.createElement("li");
	die.className = `roll die d${faces}`;
	die.textContent = String(value ?? "—");
	die.title = `d${faces}: ${value}`;
	die.setAttribute("aria-label", `d${faces}: ${value}`);
	dice.append(die);
	tooltip.append(dice);
	return tooltip;
}

function testOutcomeLabel(outcome) {
	const roll = Number.isFinite(Number(outcome?.roll)) ? Number(outcome.roll) : "—";
	const target = Number.isFinite(Number(outcome?.target)) ? Number(outcome.target) : "—";
	return `${roll} / ${target} — ${outcome?.success
		? localize("success", "sukces")
		: localize("failure", "porażka")}`;
}

function detailRow(labelText, valueText) {
	const row = document.createElement("div");
	row.className = "wfrp1e-damage-card__row";
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = String(valueText ?? "—");
	row.append(label, value);
	return row;
}

function insertBefore(parent, child, before) {
	if (before) parent.insertBefore(child, before);
	else parent.append(child);
}

function findView(sourceMessageId) {
	const id = String(sourceMessageId ?? "");
	return [...(game.messages ?? [])].find((message) =>
		String(message.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY)?.sourceImpactMessageId ?? "") === id,
	) ?? null;
}

function transactionForView(viewMessage) {
	const view = viewMessage?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
	const actor = ActorRollPolicy.actorFromUuidSync(view?.targetActorUuid);
	return actor && view?.packetId
		? DamageApplication.transactionFor(actor, view.packetId)
		: null;
}

function hasAppliedDamage(source, target) {
	const damage = source?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	return Boolean(
		target &&
		damage?.packet?.id &&
		DamageApplication.transactionFor(target, damage.packet.id)?.state === "applied"
	);
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function boundedInteger(value, minimum, maximum, label) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < minimum || number > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return number;
}

function nonNegativeInteger(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function isDieValue(value, faces) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= faces;
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function requestChatRefresh() {
	requestAnimationFrame(() => {
		void ui.chat?.render?.({ force: true });
		setTimeout(() => void ui.chat?.render?.({ force: true }), 0);
	});
}

function reportError(error) {
	console.error("WFRP1ED | Unable to resolve Fire Ball damage presentation.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to update the Fire Ball resolution.",
		"Nie udało się zaktualizować rozstrzygnięcia Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
