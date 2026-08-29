import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";

const FLAG_SCOPE = "wfrp1ed";
const BALL_GROUP_FLAG = "fireBallBallGroup";
const IMPACT_FLAG = "fireBallImpactWorkflow";

/**
 * Surface the canonical Fire Ball Initiative action inside the visible Ball
 * aggregate card.
 *
 * Grouping hides the original per-target impact card, but that canonical card
 * still owns Initiative resolution, permissions, sockets, Dice So Nice, Luck
 * linkage and later TestResult reconciliation. This integration adds no new
 * Initiative mechanic: it only forwards the visible grouped action to the
 * canonical hidden control.
 */
Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG)) return;
	requestAnimationFrame(() => requestAnimationFrame(() => decorate(message, html)));
});

function decorate(message, html) {
	const group = message?.getFlag?.(FLAG_SCOPE, BALL_GROUP_FLAG);
	if (!group) return;

	const root = asElement(html);
	const panel = root?.matches?.("[data-wfrp-fireball-ball-group]")
		? root
		: root?.querySelector?.("[data-wfrp-fireball-ball-group]");
	if (!(panel instanceof HTMLElement)) return;

	const sections = [...panel.querySelectorAll(".wfrp-fireball-ball-group__target")];
	const targets = targetEntries(group);

	for (let index = 0; index < Math.min(sections.length, targets.length); index += 1) {
		const section = sections[index];
		if (!(section instanceof HTMLElement)) continue;
		section.querySelector(".wfrp-fireball-ball-group__initiative-action")?.remove();

		const record = impactRecordForTarget(group, targets[index]);
		if (record?.state?.status !== "awaiting-initiative") continue;
		section.append(buildRollInitiativeButton(record));
	}
}

function buildRollInitiativeButton(record) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "combat-damage-roll-button wfrp-fireball-ball-group__initiative-action";
	button.textContent = localize("Roll Initiative", "Rzuć Inicjatywę");
	button.style.marginTop = "0.35rem";
	button.style.width = "100%";

	const target = actorFromUuid(record?.state?.targetUuid);
	button.disabled = !ActorRollPolicy.canAdjudicate(target, game.user);
	button.title = button.disabled
		? localize(
			"Only the GM or an OWNER of the target may roll this Test.",
			"Tylko MG albo Właściciel celu może wykonać ten Test.",
		)
		: localize(
			"Roll the Initiative Test that may halve this Fire Ball's damage.",
			"Rzuć Test Inicjatywy, który może zmniejszyć obrażenia tej Ognistej Kuli o połowę.",
		);

	button.addEventListener("click", () => {
		button.disabled = true;
		void invokeCanonicalInitiativeRoll(record)
			.catch(reportError)
			.finally(() => {
				if (!button.isConnected) return;
				const current = record?.message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
				button.disabled = current?.status !== "awaiting-initiative" ||
					!ActorRollPolicy.canAdjudicate(actorFromUuid(current?.targetUuid), game.user);
			});
	});

	return button;
}

async function invokeCanonicalInitiativeRoll(record) {
	const message = record?.message;
	const messageId = String(message?.id ?? "").trim();
	if (!messageId) throw new Error(localize(
		"The Fire Ball impact is unavailable.",
		"Trafienie Ognistej Kuli jest niedostępne.",
	));

	/* First prefer the real ChatLog control. A forced render may take several
	 * animation frames because multiple WFRP presentation hooks rebuild/hide the
	 * same impact card. Wait for that pipeline rather than assuming two frames are
	 * enough. This still invokes the canonical FireBallImpactWorkflow listener. */
	let control = canonicalInitiativeControl(messageId);
	if (!(control instanceof HTMLButtonElement)) {
		await ui.chat?.render?.({ force: true });
		control = await waitForCanonicalControl(messageId, 12);
	}

	/* If Foundry's virtualised ChatLog does not materialise the hidden impact,
	 * replay the ordinary render hook into a detached host and wait for the same
	 * asynchronous decoration pipeline there. */
	if (!(control instanceof HTMLButtonElement)) {
		control = await detachedCanonicalInitiativeControl(message);
	}

	if (!(control instanceof HTMLButtonElement)) {
		throw new Error(localize(
			"The canonical Fire Ball Initiative action is unavailable.",
			"Kanoniczna akcja Testu Inicjatywy Ognistej Kuli jest niedostępna.",
		));
	}
	if (control.disabled) {
		throw new Error(localize(
			"You may not roll this Fire Ball Initiative Test.",
			"Nie masz uprawnień do tego Testu Inicjatywy Ognistej Kuli.",
		));
	}
	control.click();
}

async function waitForCanonicalControl(messageId, frames) {
	for (let index = 0; index < frames; index += 1) {
		const control = canonicalInitiativeControl(messageId);
		if (control instanceof HTMLButtonElement) return control;
		await nextAnimationFrame();
	}
	return null;
}

function canonicalInitiativeControl(messageId) {
	const entry = document.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
	if (!(entry instanceof HTMLElement)) return null;
	return initiativeControlFromPanel(entry.querySelector("[data-wfrp-fireball-impact-workflow]"));
}

async function detachedCanonicalInitiativeControl(message) {
	if (!message) return null;
	const host = document.createElement("div");
	host.innerHTML = String(message.content ?? "");
	if (!host.querySelector("[data-wfrp-fireball-impact-workflow]")) {
		host.innerHTML = '<section class="wfrp1ed wfrp-fireball-impact-workflow" data-wfrp-fireball-impact-workflow></section>';
	}

	Hooks.callAll("renderChatMessageHTML", message, host);
	for (let index = 0; index < 12; index += 1) {
		const control = initiativeControlFromPanel(host.querySelector("[data-wfrp-fireball-impact-workflow]"));
		if (control instanceof HTMLButtonElement) return control;
		await nextAnimationFrame();
	}
	return null;
}

/**
 * The canonical impact card deliberately labels the button only "Roll"/"Rzuć";
 * Initiative is written beside it in the surrounding status. While an impact is
 * awaiting Initiative this is the only roll button on that card, so matching the
 * button text for "Initiative" was guaranteed to fail.
 */
function initiativeControlFromPanel(panel) {
	if (!(panel instanceof HTMLElement)) return null;
	return [...panel.querySelectorAll("button.combat-damage-roll-button")]
		.find((button) => button instanceof HTMLButtonElement) ?? null;
}

function targetEntries(group) {
	const explicit = Array.isArray(group?.targets) ? group.targets : [];
	if (explicit.length) return explicit;
	return (group?.impactMessageIds ?? []).map((id) => {
		const impact = game.messages?.get(String(id))?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		return impact ? {
			actorUuid: String(impact.targetUuid ?? ""),
			tokenUuid: String(impact.targetTokenUuid ?? ""),
			name: String(impact.targetName ?? "—"),
		} : null;
	}).filter(Boolean);
}

function impactRecordForTarget(group, target) {
	for (const id of group?.impactMessageIds ?? []) {
		const message = game.messages?.get(String(id));
		const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
		if (!impact) continue;
		if (target?.tokenUuid && String(impact.targetTokenUuid ?? "") === String(target.tokenUuid)) {
			return { message, state: impact };
		}
		if (String(impact.targetUuid ?? "") === String(target?.actorUuid ?? "")) {
			return { message, state: impact };
		}
	}
	return null;
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

function nextAnimationFrame() {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
	console.error("WFRP1ED | Unable to roll grouped Fire Ball Initiative Test.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to roll Fire Ball Initiative Test.",
		"Nie udało się wykonać Testu Inicjatywy Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
