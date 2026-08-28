import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";
const DAMAGE_FLAG = "damageState";
const DAMAGE_VIEW_FLAG = "fireBallDamageResultView";
const ACTOR_TEST_FLAG = "actorTestRequest";
const TEST_RESULT_FLAG = "testResultState";

let refreshQueued = false;
const disclosureState = new Map();

/**
 * Visible Fire Ball grouping layer.
 *
 * One lightweight aggregate ChatMessage represents one physical Fire Ball and
 * reads its target/Initiative/Damage state from the canonical child
 * ChatMessages. It does not own or duplicate any mechanical state.
 *
 * Cast-level vulnerabilities are intentionally not repeated here. Fear of Fire
 * and Flammable are adjudicated once per target on the cast summary; individual
 * Ball cards keep only Initiative and Damage.
 *
 * The redundant per-target impact/source card is hidden once a Ball aggregate
 * owns it. Any action that still belongs to that canonical impact must therefore
 * be surfaced by the aggregate. The aggregate does not implement the mechanic:
 * it delegates to the canonical impact card/control, preserving the existing
 * permission, socket and damage workflow.
 */
export class FireBallBallGroupPresentation {
	static async create({ castId, castMessageId, caster, spell, ballNumber, impactMessageIds, targets } = {}) {
		const ids = [...new Set((impactMessageIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
		if (!ids.length) return null;
		const state = {
			version: 7,
			castId: String(castId ?? ""),
			castMessageId: String(castMessageId ?? ""),
			casterUuid: String(caster?.uuid ?? ""),
			spellUuid: String(spell?.uuid ?? ""),
			spellName: String(spell?.name ?? localize("Fire Ball", "Ognista Kula")),
			ballNumber: Number(ballNumber) || 1,
			impactMessageIds: ids,
			targets: (targets ?? []).map((target) => ({
				actorUuid: String(target?.actorUuid ?? target?.actor?.uuid ?? ""),
				tokenUuid: String(target?.tokenUuid ?? ""),
				name: String(target?.name ?? target?.actor?.name ?? "—"),
			})),
			createdAt: Date.now(),
		};
		return ChatMessage.create({
			speaker: ChatMessage.getSpeaker({ actor: caster }),
			content: '<section class="wfrp1ed wfrp-fireball-ball-group" data-wfrp-fireball-ball-group></section>',
			flags: { [FLAG_SCOPE]: { [BALL_GROUP_FLAG]: state } },
		});
	}
}

Hooks.on("renderChatMessageHTML", (message, html) => {
	requestAnimationFrame(() => {
		decorate(message, html);
		hideRepresentedImpactMessage(message, html);
	});
});

Hooks.on("updateChatMessage", (message) => {
	if (!isRelatedCanonicalMessage(message)) return;
	requestChatRefresh();
});
Hooks.on("createChatMessage", (message) => {
	if (!isRelatedCanonicalMessage(message)) return;
	requestChatRefresh();
});
Hooks.on("deleteChatMessage", (message) => {
	disclosureState.delete(String(message?.id ?? ""));
});
Hooks.on("updateActor", () => requestChatRefresh());

function decorate(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
	if (!state) return;
	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-ball-group]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-ball-group]");
	if (!(panel instanceof HTMLElement)) return;

	const messageId = String(message?.id ?? "").trim();
	const previousDetails = panel.querySelector("details.wfrp-fireball-ball-group__details");
	const previousDomOpen = previousDetails instanceof HTMLDetailsElement ? previousDetails.open : null;
	const fullyResolved = ballFullyResolved(state);
	const disclosure = disclosureFor(messageId, fullyResolved, previousDomOpen);

	panel.replaceChildren();
	panel.classList.add("wfrp1e-damage-card", "wfrp-fireball-ball-group-card");

	const details = document.createElement("details");
	details.className = "wfrp-fireball-ball-group__details";
	details.open = disclosure.open;
	const summary = document.createElement("summary");
	Object.assign(summary.style, {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content max-content",
		alignItems: "center",
		gap: "0.6rem",
		padding: "0.55rem 0.65rem",
		cursor: "pointer",
		listStyle: "none",
	});
	const title = document.createElement("strong");
	title.textContent = `${state.spellName} ${state.ballNumber}`;
	const compact = document.createElement("span");
	compact.textContent = compactStatus(state);
	compact.style.whiteSpace = "nowrap";
	compact.style.textAlign = "right";
	const arrow = document.createElement("span");
	arrow.className = "wfrp-fireball-ball-group__expand-indicator";
	arrow.textContent = details.open ? "▾" : "▸";
	arrow.setAttribute("aria-hidden", "true");
	Object.assign(arrow.style, {
		fontSize: "1.7rem",
		lineHeight: "1",
		opacity: "0.75",
	});
	summary.append(title, compact, arrow);
	details.append(summary);

	const body = document.createElement("div");
	Object.assign(body.style, {
		padding: "0 0.65rem 0.65rem",
		borderTop: "1px solid rgba(74, 52, 31, 0.22)",
	});

	for (const target of targetEntries(state)) {
		body.append(targetSection(state, target));
	}
	details.append(body);

	details.addEventListener("toggle", () => {
		arrow.textContent = details.open ? "▾" : "▸";
		const current = disclosureState.get(messageId) ?? { fullyResolved };
		disclosureState.set(messageId, {
			...current,
			open: details.open,
			fullyResolved,
		});
	});
	panel.append(details);
}

function disclosureFor(messageId, fullyResolved, previousDomOpen) {
	const id = String(messageId ?? "").trim();
	const existing = id ? disclosureState.get(id) : null;
	if (!existing) {
		const created = {
			open: previousDomOpen ?? !fullyResolved,
			fullyResolved,
		};
		if (id) disclosureState.set(id, created);
		return created;
	}

	/* A live DOM state wins over the cached value. This preserves an explicit
	 * manual fold/unfold while an unresolved Ball is being refreshed in-place. */
	let open = previousDomOpen ?? existing.open;

	/* Collapse exactly once when the final target becomes resolved. If later GM
	 * adjudication makes the Ball unresolved again, reopen it so the newly pending
	 * work is immediately discoverable. */
	if (existing.fullyResolved !== true && fullyResolved === true) open = false;
	else if (existing.fullyResolved === true && fullyResolved !== true) open = true;

	const next = { open, fullyResolved };
	if (id) disclosureState.set(id, next);
	return next;
}

function ballFullyResolved(state) {
	const entries = targetEntries(state);
	return entries.length > 0 && entries.every((target) =>
		targetResolutionComplete(impactRecordForTarget(state, target))
	);
}

function targetSection(groupState, target) {
	const section = document.createElement("section");
	section.className = "wfrp-fireball-ball-group__target";
	Object.assign(section.style, {
		paddingTop: "0.55rem",
		marginTop: "0.25rem",
	});

	const heading = document.createElement("strong");
	heading.textContent = target.name;
	heading.style.display = "block";
	heading.style.marginBottom = "0.25rem";
	section.append(heading);

	const record = impactRecordForTarget(groupState, target);
	const initiative = initiativeSummary(record?.state ?? null);
	const damage = damageSummary(record);
	section.append(
		statusRow(localize("Initiative", "Inicjatywa"), initiative.text, initiative.kind),
		statusRow(localize("Damage", "Obrażenia"), damage.text, damage.kind),
	);

	if (record?.state?.status === "awaiting-damage") {
		section.append(buildRollDamageButton(record));
	}
	return section;
}

function buildRollDamageButton(record) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button wfrp-fireball-ball-group__damage-action";
	button.textContent = localize("Roll Damage", "Rzuć obrażenia");
	button.style.marginTop = "0.35rem";
	button.style.width = "100%";

	const caster = actorFromUuid(record?.state?.casterUuid);
	button.disabled = !ActorRollPolicy.canAdjudicate(caster, game.user);
	button.title = button.disabled
		? localize(
			"Only the GM or an OWNER of the caster may roll this damage.",
			"Tylko MG albo Właściciel rzucającego czar może rzucić te obrażenia.",
		)
		: localize(
			"Roll damage for this Fire Ball hit.",
			"Rzuć obrażenia dla tego trafienia Ognistej Kuli.",
		);

	button.addEventListener("click", () => {
		button.disabled = true;
		void invokeCanonicalDamageRoll(record)
			.catch(reportError)
			.finally(() => {
				if (button.isConnected) {
					const current = record?.message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
					button.disabled = current?.status !== "awaiting-damage" ||
						!ActorRollPolicy.canAdjudicate(actorFromUuid(current?.casterUuid), game.user);
				}
			});
	});
	return button;
}

async function invokeCanonicalDamageRoll(record) {
	const messageId = String(record?.message?.id ?? "").trim();
	if (!messageId) throw new Error(localize(
		"The Fire Ball impact is unavailable.",
		"Trafienie Ognistej Kuli jest niedostępne.",
	));

	let control = canonicalDamageControl(messageId);
	if (!(control instanceof HTMLButtonElement)) {
		await ui.chat?.render?.({ force: true });
		await nextAnimationFrame();
		await nextAnimationFrame();
		control = canonicalDamageControl(messageId);
	}
	if (!(control instanceof HTMLButtonElement)) {
		throw new Error(localize(
			"The canonical Fire Ball damage action is unavailable.",
			"Kanoniczna akcja obrażeń Ognistej Kuli jest niedostępna.",
		));
	}
	if (control.disabled) {
		throw new Error(localize(
			"You may not roll this Fire Ball damage.",
			"Nie masz uprawnień do rzutu obrażeń Ognistej Kuli.",
		));
	}
	control.click();
}

function canonicalDamageControl(messageId) {
	const id = cssEscape(messageId);
	const entry = document.querySelector(`[data-message-id="${id}"]`);
	if (!(entry instanceof HTMLElement)) return null;
	const panel = entry.querySelector("[data-wfrp-fireball-impact-workflow]");
	if (!(panel instanceof HTMLElement)) return null;
	return [...panel.querySelectorAll("button.combat-damage-roll-button")]
		.find((button) => /damage|obrażenia/i.test(String(button.textContent ?? ""))) ?? null;
}

function nextAnimationFrame() {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function statusRow(labelText, valueText, kind = "neutral") {
	const row = document.createElement("div");
	Object.assign(row.style, {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) max-content",
		alignItems: "center",
		gap: "0.6rem",
		minHeight: "1.45rem",
	});
	const label = document.createElement("span");
	label.textContent = labelText;
	const value = document.createElement("strong");
	value.textContent = valueText;
	value.style.whiteSpace = "nowrap";
	value.style.textAlign = "right";
	if (kind === "success") value.style.color = "#31542f";
	else if (kind === "failure") value.style.color = "#7b2626";
	row.append(label, value);
	return row;
}

function compactStatus(state) {
	const entries = targetEntries(state);
	const resolved = entries.filter((target) => targetResolutionComplete(impactRecordForTarget(state, target))).length;
	return `${resolved}/${entries.length} ${localize("resolved", "rozstrzygnięto")}`;
}

function targetResolutionComplete(record) {
	if (!record?.state?.damage) return false;
	const damage = damageSummary(record);
	return damage.kind === "success" || /^\d+/.test(String(damage.text ?? ""));
}

function targetEntries(state) {
	const explicit = Array.isArray(state?.targets) ? state.targets : [];
	if (explicit.length) return explicit;
	return (state?.impactMessageIds ?? []).map((id) => {
		const impact = game.messages?.get(String(id))?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		return impact ? {
			actorUuid: String(impact.targetUuid ?? ""),
			tokenUuid: String(impact.targetTokenUuid ?? ""),
			name: String(impact.targetName ?? "—"),
		} : null;
	}).filter(Boolean);
}

function impactRecordForTarget(state, target) {
	for (const id of state?.impactMessageIds ?? []) {
		const message = game.messages?.get(String(id));
		const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		if (!impact) continue;
		if (target.tokenUuid && String(impact.targetTokenUuid ?? "") === String(target.tokenUuid)) {
			return { message, state: impact };
		}
		if (String(impact.targetUuid ?? "") === String(target.actorUuid ?? "")) {
			return { message, state: impact };
		}
	}
	return null;
}

function initiativeSummary(impact) {
	if (!impact?.initiative) return result(localize("Pending", "Oczekuje"), "neutral");
	const messageId = String(impact.initiative?.testMessageId ?? "").trim();
	const testState = messageId ? game.messages?.get(messageId)?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG) : null;
	const success = testState ? testResultSuccess(testState) : impact.initiative.success === true;
	return result(success ? localize("Success", "Sukces") : localize("Failure", "Porażka"), success ? "success" : "failure");
}

function damageSummary(record) {
	const impact = record?.state;
	if (!impact?.damage) return result(localize("Pending", "Oczekuje"), "neutral");
	const amount = Number(impact.damage.finalDamage);
	const packetId = String(
		record?.message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG)?.packet?.id ?? impact.damage.packetId ?? "",
	).trim();
	const actor = actorFromUuid(impact.targetUuid);
	const transaction = actor && packetId ? DamageApplication.transactionFor(actor, packetId) : null;
	if (transaction?.state === "applied") {
		return result(
			`${Number.isFinite(amount) ? amount : transaction.amountApplied} — ${localize("Applied", "Zastosowano")}`,
			"success",
		);
	}
	return result(Number.isFinite(amount) ? String(amount) : localize("Resolved", "Rozstrzygnięto"), "neutral");
}

function testResultSuccess(state) {
	const roll = Number(state?.roll);
	const baseTarget = Number(state?.baseTarget);
	const general = Number(state?.generalModifier?.value ?? 0);
	const other = (state?.otherModifiers ?? []).reduce((sum, modifier) => {
		if (modifier?.enabled === false) return sum;
		return sum + Number(modifier?.value ?? 0);
	}, 0);
	const target = Math.max(0, Math.min(100, baseTarget + general + other));
	return Number.isFinite(roll) && roll <= target;
}

function result(text, kind) { return { text, kind }; }

function hideRepresentedImpactMessage(message, html) {
	if (!message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)) return;
	const id = String(message?.id ?? "").trim();
	if (!id || !groupOwnsImpact(id)) return;

	const root = asElement(html);
	if (!(root instanceof HTMLElement)) return;
	const entry = root.closest?.(".chat-message, li.message, li.chat-message") ??
		root.parentElement?.closest?.(".chat-message, li.message, li.chat-message") ??
		root;
	if (!(entry instanceof HTMLElement)) return;

	entry.hidden = true;
	entry.style.display = "none";
	entry.setAttribute("aria-hidden", "true");
	entry.dataset.wfrpFireBallGroupedImpactHidden = "";
}

function groupOwnsImpact(impactMessageId) {
	const id = String(impactMessageId ?? "").trim();
	if (!id) return false;
	for (const candidate of game.messages ?? []) {
		const state = candidate.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
		if (!state) continue;
		if ((state.impactMessageIds ?? []).some((value) => String(value ?? "") === id)) return true;
	}
	return false;
}

function isRelatedCanonicalMessage(message) {
	if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG)) return true;
	if (message?.getFlag?.(FLAG_SCOPE, DAMAGE_VIEW_FLAG)) return true;
	const request = message?.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
	if (request?.source?.kind === "spell-fire-ball") return true;
	if (message?.getFlag?.(FLAG_SCOPE, TEST_RESULT_FLAG)) return isLinkedFireBallTestResult(message);
	return false;
}

function isLinkedFireBallTestResult(message) {
	const id = String(message?.id ?? "");
	if (!id) return false;
	for (const candidate of game.messages ?? []) {
		const impact = candidate.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		if (String(impact?.initiative?.testMessageId ?? "") === id) return true;
		const request = candidate.getFlag?.(FLAG_SCOPE, ACTOR_TEST_FLAG);
		if (request?.source?.kind === "spell-fire-ball" && String(request.resultMessageId ?? "") === id) return true;
	}
	return false;
}

function requestChatRefresh() {
	if (refreshQueued) return;
	refreshQueued = true;
	requestAnimationFrame(() => {
		refreshQueued = false;
		refreshVisibleGroups();
		void ui.chat?.render?.({ force: true });
	});
}

function refreshVisibleGroups() {
	for (const message of game.messages ?? []) {
		if (!message.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG)) continue;
		const entry = document.querySelector(`[data-message-id="${cssEscape(String(message.id))}"]`);
		if (entry instanceof HTMLElement) decorate(message, entry);
	}
}

function actorFromUuid(uuid) {
	try {
		const document = foundry.utils.fromUuidSync(String(uuid ?? "").trim());
		if (document instanceof foundry.documents.Actor) return document;
		if (document?.actor instanceof foundry.documents.Actor) return document.actor;
	} catch (_error) {
		return null;
	}
	return null;
}

function cssEscape(value) {
	return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to resolve grouped Fire Ball action.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to resolve Fire Ball action.",
		"Nie udało się rozstrzygnąć akcji Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
