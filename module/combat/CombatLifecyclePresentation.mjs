import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import { DAMAGE_MITIGATION_POLICY } from "../damage/DamagePacket.mjs";
import {
	damageRuleEffectGroups,
	damageRuleSourceHeading,
} from "../damage/DamageRulePresentation.mjs";
import {
	resolveDetailedDamageMessageCritical,
} from "../criticals/DetailedCriticalIntegration.mjs";
import {
	canEditCombatDamageDiceTotal,
	requestCombatDamageDiceTotalUpdate,
} from "./CombatDamageIntegration.mjs";

const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DAMAGE_FLAG_KEY = "damageState";
const COMBAT_DAMAGE_FLAG_KEY = "combatDamageRoll";
const DAMAGE_RESULT_VIEW_FLAG_KEY = "combatDamageResultView";
const CRITICAL_RESULT_FLAG_KEY = "criticalResult";
const ADDITIONAL_DAMAGE_FLAG_KEY = "combatAdditionalDamageTest";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";

Hooks.once("init", () => {
	/*
	 * Damage application is a visible action on the result itself. Keep one
	 * interaction contract and do not also hide the same action in the generic
	 * ChatMessage context menu.
	 */
	DamageChat.addContextMenuOptions = () => {};

	Hooks.on("renderChatMessageHTML", (message, html) => {
		relabelAdditionalDamageTest(message, html);
		decorateInlineDamageApplication(message, html);
		decorateDamageResultView(message, html);
		decorateDetailedCriticalResult(message, html);
		removeRevertedCriticalSourcePanel(message, html);

		/*
		 * The attack keeps a folded damage audit. Only the duplicated detailed
		 * critical launcher is removed once the dedicated Damage card exists.
		 */
		requestAnimationFrame(() => hideEmbeddedCriticalPanel(message, html));
	});

	Hooks.on("updateChatMessage", (message) => {
		void synchronizeDamageResultView(message);
	});

	Hooks.on("createChatMessage", (message) => {
		void normalizeCriticalResultSpeaker(message);
	});

	Hooks.on("updateActor", (actor, changes) => {
		refreshDamageResultViewsForActor(actor);
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

/** Put Apply Damage directly on standalone/legacy damage-bearing cards. */
function decorateInlineDamageApplication(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	if (!state?.packet?.id) return;
	if (Number(state.resolution?.finalAmount) <= 0) return;

	/* Combat attack damage is presented by its linked dedicated result card. */
	if (
		message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY) &&
		findDamageResultView(message.id, state.packet.id)
	) {
		return;
	}

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

	host.append(buildApplyDamageButton(message));
}

/**
 * A combat attack remains the source-of-truth transaction, while its damage is
 * presented in a dedicated ChatMessage. The view is regenerated when the GM or
 * attacker owner overrides the summed damage-dice value.
 */
async function synchronizeDamageResultView(sourceMessage) {
	if (!sourceMessage?.id || !sourceMessage.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY)) {
		return;
	}
	if (!isPrimaryActiveGM()) return;

	const damageState = sourceMessage.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = sourceMessage.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);

	if (damageState?.packet?.id && rollState?.status === "resolved") {
		await ensureDamageResultView(sourceMessage, damageState, rollState);
		return;
	}

	await removeOrphanedDamageResultViews(sourceMessage);
}

async function ensureDamageResultView(sourceMessage, damageState, rollState) {
	const packetId = String(damageState?.packet?.id ?? "");
	if (!packetId) return;

	const actor = actorFromUuidSync(damageState.packet?.targetActorUuid);
	const targetName = String(
		actor?.name ??
		damageState.targetName ??
		damageState.packet?.targetActorUuid ??
		"",
	);
	const content = damageResultContent(
		damageState,
		rollState,
		targetName,
	);
	const existing = findDamageResultView(sourceMessage.id, packetId);
	if (existing) {
		if (String(existing.content ?? "") !== content && existing.canUserModify?.(game.user, "update")) {
			await existing.update({ content });
		}
		return;
	}

	const speaker = actor
		? ChatMessage.getSpeaker({ actor })
		: {
			scene: null,
			actor: null,
			token: null,
			alias: targetName,
		};

	await ChatMessage.create({
		speaker,
		content,
		whisper: foundry.utils.deepClone(sourceMessage.whisper ?? []),
		blind: sourceMessage.blind === true,
		flags: {
			[FLAG_SCOPE]: {
				[DAMAGE_RESULT_VIEW_FLAG_KEY]: {
					version: 2,
					sourceAttackMessageId: String(sourceMessage.id),
					packetId,
					targetActorUuid: String(
						damageState.packet?.targetActorUuid ?? "",
					),
					createdAt: Date.now(),
				},
			},
		},
	});

	void ui.chat?.render?.({ force: true });
}

async function removeOrphanedDamageResultViews(sourceMessage) {
	const views = damageResultViewsForSource(sourceMessage.id);
	for (const view of views) {
		const state = view.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		const actor = actorFromUuidSync(state?.targetActorUuid);
		const transaction = actor
			? DamageApplication.transactionFor(actor, state?.packetId)
			: null;

		/* A reverted result remains useful history and may precede a reroll. */
		if (transaction?.state === "reverted") continue;
		if (view.canUserModify?.(game.user, "delete")) {
			await view.delete();
		}
	}
}

function damageResultContent(damageState, rollState, targetName) {
	const resolution = damageState?.resolution ?? {};
	const toughness = resolution.breakdown?.toughness ?? {};
	const armour = resolution.breakdown?.armour ?? {};
	const parry = resolution.breakdown?.parry ?? {};
	const unmitigated = resolution.breakdown?.unmitigated ?? {};
	const rows = [
		rowHtml(localize("Target", "Cel"), targetName || "—"),
		rowHtml(
			localize("Hit location", "Lokacja trafienia"),
			hitLocationLabel(rollState?.hitLocation),
		),
		rollRowHtml(rollState),
		rowHtml(
			localize("Strength", "Siła"),
			signedInteger(rollState?.strength),
		),
	];

	if (Number(rollState?.weaponDamageModifier) !== 0) {
		rows.push(rowHtml(
			localize("Weapon modifier", "Modyfikator broni"),
			signedInteger(rollState.weaponDamageModifier),
		));
	}
	const damageRuleRows = damageRuleRowsHtml(rollState?.damageRuleEffects);
	if (damageRuleRows.length > 0) {
		rows.push(...damageRuleRows);
	} else if (Number(rollState?.ruleDamageModifier) !== 0) {
		rows.push(rowHtml(
			localize("Active Effect (damage)", "Aktywny Efekt (obrażenia)"),
			signedInteger(rollState.ruleDamageModifier),
		));
	}
	if (rollState?.additionalDamage?.triggered) {
		rows.push(rowHtml(
			localize("Additional Damage", "Obrażenia dodatkowe"),
			additionalDamageLabel(rollState.additionalDamage),
		));
	}

	rows.push(
		rowHtml(
			localize("Before Toughness", "Przed Wytrzymałością"),
			String(damageState?.packet?.rawAmount ?? 0),
		),
		rowHtml(
			localize("Toughness", "Wytrzymałość"),
			mitigationLabel(toughness),
		),
		rowHtml(
			localize("Armour", "Pancerz"),
			armourLabel(armour),
		),
	);

	if (parry.applied === true) {
		rows.push(rowHtml(
			localize("Parry", "Parowanie"),
			`${nonNegativeInteger(parry.absorbed)} (${parry.itemName || "—"})`,
		));
	}
	if (Number(unmitigated.value) > 0) {
		rows.push(rowHtml(
			localize("Unavoidable damage", "Nieuchronne obrażenia"),
			signedInteger(unmitigated.value),
		));
	}

	rows.push(rowHtml(
		localize("Final damage", "Końcowe obrażenia"),
		String(resolution.finalAmount ?? 0),
	));

	return `
		<section class="wfrp1e-damage-card combat-damage-result-card" data-wfrp-combat-damage-result-card>
			<div class="wfrp1e-damage-card__header">
				<strong>${escapeHtml(localize("Damage", "Obrażenia"))}</strong>
				<span class="wfrp1e-damage-card__amount">${escapeHtml(String(resolution.finalAmount ?? 0))}</span>
			</div>
			${rows.join("")}
			<div class="wfrp1e-damage-card__status" data-wfrp-damage-result-status></div>
			<div data-wfrp-damage-result-actions></div>
		</section>
	`;
}

function rollRowHtml(rollState) {
	const dice = Array.isArray(rollState?.damageDice)
		? rollState.damageDice.map((value) => Math.min(6, Math.max(1, integer(value))))
		: [];
	const icons = dice.length
		? dice.map((value) => d6IconHtml(value)).join("")
		: `<span class="wfrp1e-damage-roll__empty">—</span>`;
	const total = nonNegativeInteger(rollState?.diceTotal);
	const operator = rollState?.diceTotalOverridden ? "→" : "=";
	const title = localize(
		"GM or attacker owner may replace the summed dice value before damage is applied.",
		"MG lub właściciel atakującego może zmienić sumę kości przed zastosowaniem obrażeń.",
	);

	return `
		<div class="wfrp1e-damage-card__row wfrp1e-damage-card__roll-row">
			<span>${escapeHtml(localize("Roll", "Rzut"))}</span>
			<div class="wfrp1e-damage-roll">
				<span class="wfrp1e-damage-roll__dice">${icons}</span>
				<span class="wfrp1e-damage-roll__operator">${operator}</span>
				<input
					class="wfrp1e-damage-roll__total"
					data-wfrp-damage-dice-total
					type="number"
					min="0"
					step="1"
					value="${total}"
					title="${escapeHtml(title)}"
					disabled
				/>
			</div>
		</div>
	`;
}

function d6IconHtml(value) {
	const names = ["one", "two", "three", "four", "five", "six"];
	const number = Math.min(6, Math.max(1, integer(value)));
	const name = names[number - 1];
	return `<i class="fa-solid fa-dice-${name} wfrp1e-damage-die" aria-label="d6: ${number}" title="d6: ${number}"></i>`;
}

function rowHtml(label, value) {
	return `<div class="wfrp1e-damage-card__row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function damageRuleRowsHtml(entries) {
	const rows = [];
	for (const group of damageRuleEffectGroups(entries)) {
		rows.push(`
			<div class="wfrp1e-damage-card__row wfrp1e-damage-card__effect-source" data-wfrp-damage-rule-source>
				<span>${escapeHtml(damageRuleSourceHeading(group.sourceName))}</span>
			</div>
		`);
		for (const effect of group.effects) {
			rows.push(`
				<div class="wfrp1e-damage-card__row wfrp1e-damage-card__effect-heading" data-wfrp-damage-rule-effect>
					<span>${escapeHtml(effect.effectName)}</span>
				</div>
			`);
			for (const change of effect.changes) {
				const value = change.valueLabel
					? `<strong>${escapeHtml(change.valueLabel)}</strong>`
					: "";
				rows.push(`
					<div class="wfrp1e-damage-card__row wfrp1e-damage-card__effect-row" data-wfrp-damage-rule-effect>
						<span>${escapeHtml(change.label)}</span>
						${value}
					</div>
				`);
			}
		}
		rows.push(`
			<div class="wfrp1e-damage-card__row wfrp1e-damage-card__effect-end" data-wfrp-damage-rule-end aria-hidden="true"></div>
		`);
	}
	return rows;
}

function decorateDamageResultView(message, html) {
	const view = message?.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
	if (!view) return;

	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-combat-damage-result-card]")
		? root
		: root?.querySelector?.("[data-wfrp-combat-damage-result-card]");
	if (!card) return;

	const status = card.querySelector("[data-wfrp-damage-result-status]");
	const actions = card.querySelector("[data-wfrp-damage-result-actions]");
	if (!status || !actions) return;
	const sourceMessage = game.messages?.get(
		String(view.sourceAttackMessageId ?? ""),
	);
	const damageState = sourceMessage?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = sourceMessage?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	const actor = actorFromUuidSync(view.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, view.packetId)
		: null;
	const finalAmount = Number(damageState?.resolution?.finalAmount ?? 0);

	card.classList.toggle("is-applied", transaction?.state === "applied");
	card.classList.toggle("is-zero-damage", finalAmount <= 0 && !transaction);
	card.classList.toggle("is-wfrp-transaction-reverted", transaction?.state === "reverted");
	actions.replaceChildren();
	activateDamageTotalInput(card, sourceMessage, rollState);

	if (transaction?.state === "reverted") {
		status.textContent = localize(
			`REVERTED · Wounds restored ${transaction.woundsAfter} → ${transaction.woundsBefore}`,
			`COFNIĘTO · przywrócono Żywotność ${transaction.woundsAfter} → ${transaction.woundsBefore}`,
		);
		return;
	}

	if (transaction?.state === "applied") {
		status.textContent = localize(
			`Applied · Wounds ${transaction.woundsBefore} → ${transaction.woundsAfter}` +
				(Number(transaction.criticalValue) > 0 ? ` · Critical +${transaction.criticalValue}` : ""),
			`Zastosowano · Żywotność ${transaction.woundsBefore} → ${transaction.woundsAfter}` +
				(Number(transaction.criticalValue) > 0 ? ` · Krytyk +${transaction.criticalValue}` : ""),
		);

		if (
			Number(transaction.criticalValue) > 0 &&
			!transaction.criticalResolution &&
			sourceMessage &&
			canResolveSourceCritical(sourceMessage, damageState)
		) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "wfrp1e-critical-result__action";
			button.innerHTML = `<i class="fa-solid fa-burst"></i> ${localize(
				"Resolve Detailed Critical",
				"Rozstrzygnij szczegółowe trafienie krytyczne",
			)}`;
			button.addEventListener("click", () => {
				button.disabled = true;
				void resolveDetailedDamageMessageCritical(sourceMessage)
					.catch(reportCriticalError)
					.finally(() => {
						if (button.isConnected) button.disabled = false;
					});
			});
			actions.append(button);
		}
		return;
	}

	/* Zero damage has no Actor mutation to confirm, so it is terminal immediately. */
	if (finalAmount <= 0) {
		status.textContent = localize(
			"No damage — resolved.",
			"Brak obrażeń — rozstrzygnięte.",
		);
		return;
	}

	if (sourceMessage && DamageChat.canApplyMessage(sourceMessage)) {
		status.textContent = localize(
			"Damage resolved — ready to apply.",
			"Obrażenia rozstrzygnięte — gotowe do zastosowania.",
		);
		actions.append(buildApplyDamageButton(sourceMessage));
		return;
	}

	status.textContent = localize(
		"Damage resolved — awaiting an authorized user to apply it.",
		"Obrażenia rozstrzygnięte — oczekują na zastosowanie przez uprawnionego użytkownika.",
	);
}

function activateDamageTotalInput(card, sourceMessage, rollState) {
	const input = card.querySelector("[data-wfrp-damage-dice-total]");
	if (!(input instanceof HTMLInputElement) || !sourceMessage) return;
	const editable = canEditCombatDamageDiceTotal(sourceMessage, game.user);
	input.disabled = !editable;
	input.classList.toggle("is-editable", editable);
	if (!editable) return;

	input.addEventListener("change", () => {
		const value = Number(input.value);
		if (!Number.isInteger(value) || value < 0) {
			input.value = String(nonNegativeInteger(rollState?.diceTotal));
			ui.notifications.error(localize(
				"Enter a non-negative whole damage-dice total.",
				"Wprowadź nieujemną całkowitą sumę kości obrażeń.",
			));
			return;
		}

		input.disabled = true;
		void requestCombatDamageDiceTotalUpdate(sourceMessage, value)
			.catch((error) => {
				console.error("WFRP1ED | Unable to edit combat damage dice total.", error);
				input.disabled = false;
				input.value = String(nonNegativeInteger(rollState?.diceTotal));
				ui.notifications.error(
					error?.message ?? localize(
						"Unable to update the damage roll.",
						"Nie udało się zaktualizować rzutu obrażeń.",
					),
				);
			});
	});
}

function buildApplyDamageButton(sourceMessage) {
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
		void DamageChat.applyMessage(sourceMessage).finally(() => {
			if (action.isConnected) action.disabled = false;
		});
	});
	return action;
}

function canResolveSourceCritical(sourceMessage, damageState, user = game.user) {
	if (!sourceMessage || !damageState || !user) return false;
	if (user.isGM) return true;
	const sourceUserId = String(
		damageState.createdBy ??
		sourceMessage.user?.id ??
		sourceMessage.author?.id ??
		"",
	).trim();
	return Boolean(sourceUserId && sourceUserId === String(user.id ?? ""));
}

function hideEmbeddedCriticalPanel(message, html) {
	const attack = message?.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	const damageState = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
	const rollState = message?.getFlag?.(FLAG_SCOPE, COMBAT_DAMAGE_FLAG_KEY);
	if (!attack || !damageState?.packet?.id || rollState?.status !== "resolved") return;

	const view = findDamageResultView(message.id, damageState.packet.id);
	if (!view) return;
	const actor = actorFromUuidSync(damageState.packet.targetActorUuid);
	const transaction = actor
		? DamageApplication.transactionFor(actor, damageState.packet.id)
		: null;

	/* Reverted source card keeps all history/rollback presentation. */
	if (transaction?.state === "reverted") return;

	const root = asElement(html);
	root?.querySelector?.("[data-wfrp-detailed-critical-panel]")?.remove();
}

function findDamageResultView(sourceMessageId, packetId) {
	return damageResultViewsForSource(sourceMessageId).find((message) => {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		return String(view?.packetId ?? "") === String(packetId ?? "");
	}) ?? null;
}

function damageResultViewsForSource(sourceMessageId) {
	const id = String(sourceMessageId ?? "");
	if (!id) return [];
	return [...(game.messages ?? [])].filter((message) => {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		return String(view?.sourceAttackMessageId ?? "") === id;
	});
}

function refreshDamageResultViewsForActor(actor) {
	if (!(actor instanceof foundry.documents.Actor)) return;
	for (const message of game.messages ?? []) {
		const view = message.getFlag?.(FLAG_SCOPE, DAMAGE_RESULT_VIEW_FLAG_KEY);
		if (String(view?.targetActorUuid ?? "") !== String(actor.uuid ?? "")) continue;
		const entry = document.querySelector(`[data-message-id="${message.id}"]`);
		if (entry) decorateDamageResultView(message, entry);
	}
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

function additionalDamageLabel(additional) {
	if (additional?.testSucceeded) {
		const extra = Array.isArray(additional.extraDice) && additional.extraDice.length
			? `; +${additional.extraDice.join(" + ")}`
			: "";
		return localize(
			`WS test succeeded${extra}`,
			`Test WW udany${extra}`,
		);
	}
	return localize("WS test failed", "Test WW nieudany");
}

function hitLocationLabel(location) {
	switch (String(location ?? "")) {
		case "head": return localize("Head", "Głowa");
		case "rightArm": return localize("Right Arm", "Prawa ręka");
		case "leftArm": return localize("Left Arm", "Lewa ręka");
		case "body": return localize("Body", "Korpus");
		case "rightLeg": return localize("Right Leg", "Prawa noga");
		case "leftLeg": return localize("Left Leg", "Lewa noga");
		default: return String(location ?? "—");
	}
}

function armourLabel(armour) {
	if (armour?.policy === DAMAGE_MITIGATION_POLICY.IGNORE) {
		return localize("ignored", "pominięty");
	}
	const value = nonNegativeInteger(armour?.value);
	const penetration = nonNegativeInteger(armour?.penetration?.applied);
	if (penetration > 0) {
		return localize(
			`−${value} (penetration ${penetration})`,
			`−${value} (przebicie ${penetration})`,
		);
	}
	if (armour?.leather?.ignoredByHighDamage === true) {
		return localize(
			`−${value} (leather ignored: blow was 4+)`,
			`−${value} (skóra pominięta: cios zadał 4+)`,
		);
	}
	return `−${value}`;
}

function mitigationLabel(mitigation) {
	if (mitigation?.policy === DAMAGE_MITIGATION_POLICY.IGNORE) {
		return localize("ignored", "pominięta");
	}
	return `−${nonNegativeInteger(mitigation?.value)}`;
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

function integer(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function nonNegativeInteger(value) {
	return Math.max(0, integer(value));
}

function signedInteger(value) {
	const number = integer(value);
	return number >= 0 ? `+${number}` : String(number);
}

function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function reportCriticalError(error) {
	console.error("WFRP1ED | Unable to resolve detailed critical.", error);
	ui.notifications.error(
		error?.message ?? localize(
			"Unable to resolve the detailed critical.",
			"Nie udało się rozstrzygnąć szczegółowego trafienia krytycznego.",
		),
	);
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
