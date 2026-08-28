import { DamageApplication } from "../damage/DamageApplication.mjs";
import { DAMAGE_CRITICAL_MODE } from "../damage/DamagePacket.mjs";

const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_FLAG = "damageState";
const DAMAGE_VIEW_FLAG = "fireBallDamageResultView";
const FALLBACK_KEY = "fireBallCriticalFallback";
const reconciling = new Set();

/**
 * Fire Ball has no ordinary weapon hit-location result in the current Core
 * procedure. Detailed weapon Critical tables therefore cannot be selected
 * reliably from this damage packet. Until a spell-specific critical table is
 * implemented, route Fire Ball overflow through the Core Sudden Death resolver
 * and record Body as the explicit fallback location for presentation/audit.
 *
 * This changes only critical routing metadata. Damage amount, Toughness and the
 * Fire Ball rule that Armour is ignored remain untouched.
 */
Hooks.on("createChatMessage", (message) => queueNormalize(message));
Hooks.on("updateChatMessage", (message) => queueNormalize(message));

Hooks.on("renderChatMessageHTML", (message, html) => {
	if (!message?.getFlag?.(FLAG_SCOPE, DAMAGE_VIEW_FLAG)) return;
	requestAnimationFrame(() => requestAnimationFrame(() => {
		decorateFallback(message, html);
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
			.catch((error) => console.error("WFRP1ED | Unable to normalize Fire Ball critical fallback.", error))
			.finally(() => reconciling.delete(id));
	});
}

async function normalizeDamageState(message) {
	const current = message?.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG);
	if (current?.packet?.source?.kind !== "spell-fire-ball") return;
	const packet = current.packet ?? {};
	const alreadyFallback =
		String(packet?.hitLocation ?? "").toLowerCase() === "body" &&
		packet?.critical?.mode === DAMAGE_CRITICAL_MODE.SUDDEN_DEATH &&
		packet?.mitigation?.special?.[FALLBACK_KEY] === true;
	if (alreadyFallback) return;

	const updated = foundry.utils.deepClone(current);
	updated.packet ??= {};
	updated.packet.hitLocation = "body";
	updated.packet.critical = {
		...(updated.packet.critical ?? {}),
		mode: DAMAGE_CRITICAL_MODE.SUDDEN_DEATH,
	};
	updated.packet.mitigation ??= {};
	updated.packet.mitigation.special = {
		...(updated.packet.mitigation.special ?? {}),
		[FALLBACK_KEY]: true,
	};
	updated.updatedAt = Date.now();
	await message.setFlag(FLAG_SCOPE, DAMAGE_FLAG, updated);
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
		`Critical hit +${Number(transaction.criticalValue)} — Fire Ball has no hit-location roll; fallback: Body, resolved with the Sudden Death table.`,
		`Trafienie krytyczne +${Number(transaction.criticalValue)} — Ognista Kula nie ma rzutu lokacji trafienia; domyślnie Korpus, rozstrzygnięcie tabelą Nagłej Śmierci.`,
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

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
