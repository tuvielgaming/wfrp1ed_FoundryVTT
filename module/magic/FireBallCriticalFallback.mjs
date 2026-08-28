import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DamageChat } from "../damage/DamageChat.mjs";
import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG = "damageState";
const DAMAGE_VIEW_FLAG = "fireBallDamageResultView";
const FALLBACK_KEY = "fireBallCriticalFallback";
const CRITICAL_FAMILY_KEY = "criticalFamily";
const CRITICAL_FALLBACK_REASON_KEY = "criticalFallbackReason";
const MAGIC_CRITICAL_FAMILY = "magic";
const MAGIC_TABLE_MISSING = "magic-table-unavailable";
const reconciling = new Set();
const applying = new Set();

/**
 * Fire Ball critical-routing policy.
 *
 * Fire Ball is magical damage and must never silently fall through to the
 * ordinary weapon/body Detailed Critical Wounds table merely because we use
 * Body as a fallback location. The intended routing order is:
 *
 *   1. a dedicated Magic critical resolver/table, when the system has one;
 *   2. otherwise the Core Sudden Death table.
 *
 * The current system has no dedicated Magic critical resolver yet, so Fire Ball
 * explicitly records the requested critical family as `magic`, records why the
 * fallback was selected, uses Body only as the missing-location fallback, and
 * routes the actual overflow through Sudden Death.
 *
 * IMPORTANT: normalize at damage creation/update *and again at the Apply Damage
 * click boundary*. The latter prevents a fast click from creating an Actor
 * transaction from a stale Detailed packet before the asynchronous ChatMessage
 * normalization hook has completed.
 */
Hooks.on("createChatMessage", (message) => queueNormalize(message));
Hooks.on("updateChatMessage", (message) => queueNormalize(message));

Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, DAMAGE_VIEW_FLAG)) return;
	requestAnimationFrame(() => requestAnimationFrame(() => {
		decorateFallback(message, html);
		bindApplyBoundary(message, html);
	}));
});

function queueNormalize(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG);
	if (state?.packet?.source?.kind !== "spell-fire-ball") return;
	if (!isPrimaryActiveGm()) return;
	const id = String(message?.id ?? "");
	if (!id || reconciling.has(id)) return;
	reconciling.add(id);
	queueMicrotask(() => {
		void normalizeDamageState(message)
			.catch((error) => console.error("WFRP1ED | Unable to normalize Fire Ball magic critical routing.", error))
			.finally(() => reconciling.delete(id));
	});
}

/**
 * Return the currently supported Magic-critical route.
 *
 * This function deliberately asks whether a dedicated Magic resolver exists
 * before selecting the fallback. We do not map `magic` to DETAILED because that
 * mode belongs to the ordinary location/weapon critical subsystem.
 */
function magicCriticalRoute() {
	const dedicatedResolver = game.WFRP1ED?.criticals?.magic?.resolve;
	if (typeof dedicatedResolver === "function") {
		/* A future dedicated integration will own resolution through that API. Until
		 * the DamagePacket enum supports a custom magic route, keep this adapter on
		 * the safe fallback rather than accidentally invoking normal Detailed tables. */
		return {
			mode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
			hitLocation: "body",
			fallback: true,
			reason: "magic-resolver-adapter-pending",
		};
	}

	return {
		mode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
		hitLocation: "body",
		fallback: true,
		reason: MAGIC_TABLE_MISSING,
	};
}

async function normalizeDamageState(message) {
	const current = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG);
	if (current?.packet?.source?.kind !== "spell-fire-ball") return current;

	const route = magicCriticalRoute();
	const packet = current.packet ?? {};
	const special = packet?.mitigation?.special ?? {};
	const alreadyNormalized =
		String(packet?.hitLocation ?? "").toLowerCase() === route.hitLocation &&
		packet?.critical?.mode === route.mode &&
		special?.[CRITICAL_FAMILY_KEY] === MAGIC_CRITICAL_FAMILY &&
		special?.[FALLBACK_KEY] === route.fallback &&
		special?.[CRITICAL_FALLBACK_REASON_KEY] === route.reason;
	if (alreadyNormalized) return current;

	const updated = foundry.utils.deepClone(current);
	updated.packet ??= {};
	updated.packet.hitLocation = route.hitLocation;
	updated.packet.critical = {
		...(updated.packet.critical ?? {}),
		mode: route.mode,
	};
	updated.packet.mitigation ??= {};
	updated.packet.mitigation.special = {
		...(updated.packet.mitigation.special ?? {}),
		[CRITICAL_FAMILY_KEY]: MAGIC_CRITICAL_FAMILY,
		[FALLBACK_KEY]: route.fallback,
		[CRITICAL_FALLBACK_REASON_KEY]: route.reason,
	};
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DAMAGE_FLAG, updated);
	return updated;
}

function bindApplyBoundary(message, html) {
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement) || card.dataset.wfrpFireballMagicApplyBound === "true") return;
	card.dataset.wfrpFireballMagicApplyBound = "true";

	/* Use capture so this policy runs before DamageChat's ordinary Apply handler. */
	card.addEventListener("click", (event) => {
		const target = event.target;
		const button = target instanceof Element
			? target.closest(".wfrp1e-damage-card__apply, [data-wfrp-damage-apply]")
			: null;
		if (!(button instanceof HTMLButtonElement)) return;

		event.preventDefault();
		event.stopImmediatePropagation();
		void applyWithMagicCriticalPolicy(message, button).catch(reportError);
	}, { capture: true });
}

async function applyWithMagicCriticalPolicy(message, button) {
	const id = String(message?.id ?? "");
	if (!id || applying.has(id)) return;
	applying.add(id);
	button.disabled = true;
	try {
		await normalizeDamageState(message);
		await DamageChat.applyMessage(message);
	} finally {
		applying.delete(id);
		if (button.isConnected) button.disabled = !DamageChat.canApplyMessage(message, game.user);
	}
}

function decorateFallback(message, html) {
	const state = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG);
	if (state?.packet?.source?.kind !== "spell-fire-ball") return;
	const root = asElement(html);
	const card = root?.matches?.("[data-wfrp-damage-card]")
		? root
		: root?.querySelector?.("[data-wfrp-damage-card]");
	if (!(card instanceof HTMLElement)) return;

	/* CriticalDamageIntegration appends its common panel to the Damage card. If a
	 * disclosure/render transform placed it inside Damage Details, move the same
	 * canonical panel back to top-level instead of creating a second critical UI. */
	const criticalPanel = card.querySelector("[data-wfrp-critical-result]");
	if (criticalPanel instanceof HTMLElement) {
		const enclosingDetails = criticalPanel.closest("details");
		if (enclosingDetails && enclosingDetails !== card) {
			enclosingDetails.before(criticalPanel);
		}
	}

	card.querySelector("[data-wfrp-fireball-critical-fallback-note]")?.remove();
	const transaction = transactionFor(message, state);
	if (
		transaction?.state !== "applied" ||
		Number(transaction?.criticalValue) <= 0
	) return;

	const note = document.createElement("div");
	note.dataset.wfrpFireballCriticalFallbackNote = "";
	note.className = "combat-damage-context__status";
	note.textContent = localize(
		`Critical hit +${Number(transaction.criticalValue)} — no dedicated Magic critical table is available; Fire Ball uses Body as its fallback location and resolves with the Sudden Death table.`,
		`Trafienie krytyczne +${Number(transaction.criticalValue)} — brak dedykowanej tabeli trafień krytycznych Magii; Ognista Kula używa Korpusu jako lokacji awaryjnej i jest rozstrzygana tabelą Nagłej Śmierci.`,
	);

	const details = card.querySelector(":scope > details");
	const canonicalCritical = card.querySelector(":scope > [data-wfrp-critical-result]");
	if (canonicalCritical) canonicalCritical.before(note);
	else if (details) details.before(note);
	else card.append(note);
}

function transactionFor(message, state) {
	const actor = actorFromUuid(state?.packet?.targetActorUuid);
	const packetId = String(state?.packet?.id ?? "").trim();
	return actor && packetId ? DamageApplication.transactionFor(actor, packetId) : null;
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

function isPrimaryActiveGm() {
	if (!game.user?.isGM) return false;
	const gm = [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
	return String(gm?.id ?? "") === String(game.user.id ?? "");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function reportError(error) {
	console.error("WFRP1ED | Unable to apply Fire Ball damage with Magic critical policy.", error);
	ui.notifications.error(error?.message ?? localize(
		"Unable to apply Fire Ball damage.",
		"Nie udało się zastosować obrażeń Ognistej Kuli.",
	));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
