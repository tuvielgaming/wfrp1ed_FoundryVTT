import { ActorRollPolicy } from "../core/ActorRollPolicy.mjs";
import { DamageApplication } from "../damage/DamageApplication.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG_KEY = "fireBallImpactWorkflow";
const DAMAGE_FLAG_KEY = "damageState";
const VIEW_FLAG_KEY = "fireBallDamageResultView";
const REVERTED_STATE = "reverted";
const queues = new Map();
let installed = false;

/**
 * Bridges the system-wide DamageApplication rollback/invalidation lifecycle back
 * into a Fire Ball impact transaction.
 *
 * DamageApplication remains authoritative: this integration never invents its
 * own invalidation state. Once the current Fire Ball DamagePacket has a
 * canonical `reverted` transaction, only the damage stage of the impact is
 * re-armed. Initiative/Fear/cast targeting remain untouched and the next click
 * on Roll Damage creates a fresh DamagePacket through FireBallImpactWorkflow.
 *
 * The old dedicated Fire Ball Damage card is archived as immutable history
 * before the impact is re-armed. This prevents the next damage roll from
 * overwriting the reverted card while preserving the normal audit trail.
 */
export function installFireBallDamageInvalidationLifecycle() {
	if (installed) return;
	installed = true;

	Hooks.on("updateChatMessage", (message) => {
		if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)) queueRearm(message);
	});

	/* Applied-damage rollback is authoritative on the target Actor. Scanning the
	 * affected target also covers rollback paths that do not need to mutate the
	 * source ChatMessage itself. */
	Hooks.on("updateActor", (actor) => {
		if (!ActorRollPolicy.isPrimaryActiveGM()) return;
		for (const message of game.messages ?? []) {
			const impact = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
			if (!impact?.damage) continue;
			if (String(impact.targetUuid ?? "") !== String(actor?.uuid ?? "")) continue;
			queueRearm(message);
		}
	});

	Hooks.once("ready", () => {
		if (!ActorRollPolicy.isPrimaryActiveGM()) return;
		for (const message of game.messages ?? []) {
			if (message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY)?.damage) queueRearm(message);
		}
	});
}

function queueRearm(message) {
	if (!ActorRollPolicy.isPrimaryActiveGM() || !message?.id) return;
	const id = String(message.id);
	const previous = queues.get(id) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => rearmIfReverted(message))
		.catch((error) => {
			console.error("WFRP1ED | Unable to re-arm invalidated Fire Ball damage.", error);
			ui.notifications.error(error?.message ?? localize(
				"Unable to re-arm invalidated Fire Ball damage.",
				"Nie udało się ponownie przygotować unieważnionych obrażeń Ognistej Kuli.",
			));
		})
		.finally(() => {
			if (queues.get(id) === next) queues.delete(id);
		});
	queues.set(id, next);
}

async function rearmIfReverted(message) {
	const impact = freshImpact(message);
	if (!impact?.initiative || !impact?.damage) return;

	const packetId = String(
		message.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY)?.packet?.id ??
		impact.damage?.packetId ??
		"",
	).trim();
	if (!packetId) return;

	/* Do not let an old reverted packet re-arm a newer resolution. */
	if (String(impact.damage?.packetId ?? "").trim() !== packetId) return;

	const target = ActorRollPolicy.actorFromUuidSync(impact.targetUuid);
	if (!target) return;
	const transaction = DamageApplication.transactionFor(target, packetId);
	if (transaction?.state !== REVERTED_STATE) return;

	/* FireBallDamageResultView mirrors DamageApplication asynchronously. Wait for
	 * that canonical derived view to contain the reverted transaction before
	 * detaching it from the live source. This is synchronization, not a gameplay
	 * delay: no rules state is changed while waiting. */
	const view = await waitForRevertedDamageView(message.id, packetId);
	if (view === null) return;
	if (view) await archiveDamageView(view, message.id, packetId);

	const current = freshImpact(message);
	if (!current?.initiative || !current?.damage) return;
	if (String(current.damage?.packetId ?? "").trim() !== packetId) return;

	const latestTransaction = DamageApplication.transactionFor(target, packetId);
	if (latestTransaction?.state !== REVERTED_STATE) return;

	const updated = foundry.utils.deepClone(current);
	updated.status = "awaiting-damage";
	updated.damage = null;
	updated.damageGeneration = Math.max(1, Number(updated.damageGeneration) || 1) + 1;
	updated.rearmedFromPacketId = packetId;
	updated.damageRearmedAt = Date.now();
	updated.updatedBy = String(game.user?.id ?? "");
	updated.updatedAt = Date.now();

	await message.setFlag(FLAG_SCOPE, IMPACT_FLAG_KEY, updated);
	void ui.chat?.render?.({ force: true });
}

async function waitForRevertedDamageView(sourceMessageId, packetId) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const view = currentDamageView(sourceMessageId, packetId);
		if (!view) return undefined;
		const damage = view.getFlag?.(FLAG_SCOPE, DAMAGE_FLAG_KEY);
		if (damage?.application?.state === REVERTED_STATE) return view;
		await delay(25);
	}

	/* If the derived view still exists but has not caught up, leave the Fire Ball
	 * transaction untouched rather than archiving an apparently valid card. A
	 * later source/Actor update will queue another reconciliation attempt. */
	return null;
}

function currentDamageView(sourceMessageId, packetId) {
	const sourceId = String(sourceMessageId ?? "");
	const packet = String(packetId ?? "");
	return [...(game.messages ?? [])].find((candidate) => {
		const view = candidate?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
		return String(view?.sourceImpactMessageId ?? "") === sourceId &&
			String(view?.packetId ?? "") === packet;
	}) ?? null;
}

async function archiveDamageView(viewMessage, sourceMessageId, packetId) {
	const current = viewMessage?.getFlag?.(FLAG_SCOPE, VIEW_FLAG_KEY);
	if (!current || current.archived === true) return;

	const template = document.createElement("template");
	template.innerHTML = String(viewMessage.content ?? "");
	for (const input of template.content.querySelectorAll("[data-fire-ball-damage-die]")) {
		input.disabled = true;
		input.setAttribute("aria-disabled", "true");
	}

	const archived = {
		...foundry.utils.deepClone(current),
		sourceImpactMessageId: "",
		archivedSourceImpactMessageId: String(sourceMessageId ?? ""),
		archivedPacketId: String(packetId ?? ""),
		archived: true,
		archivedAt: Date.now(),
	};

	await viewMessage.update({
		content: template.innerHTML,
		[`flags.${FLAG_SCOPE}.${VIEW_FLAG_KEY}`]: archived,
	});
}

function freshImpact(message) {
	const state = message?.getFlag?.(FLAG_SCOPE, IMPACT_FLAG_KEY);
	return state && typeof state === "object" && !Array.isArray(state)
		? state
		: null;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
