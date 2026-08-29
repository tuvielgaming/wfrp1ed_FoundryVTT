import { CoreCastingFailureWorkflow } from "./CoreCastingFailureWorkflow.mjs";
import { FireBallImpactWorkflow } from "./FireBallImpactWorkflow.mjs";

const FLAG_SCOPE = "wfrp1ed";
const IMPACT_FLAG = "fireBallImpactWorkflow";

/*
 * FireBallProcedure creates its impact messages after the cast summary, but its
 * legacy call site does not pass the Core casting transaction id into
 * FireBallImpactWorkflow.create(). SpellCastLinkage can repair that later, but
 * aggregate-card creation now reacts immediately to impact flags; relying on a
 * later repair creates a race where only some target impacts become grouped.
 *
 * Inject the already-existing Core casting context at the boundary where each
 * impact is created. This does not invent a second transaction id: it reuses the
 * authoritative castId allocated by CoreCastingFailureWorkflow.
 */
const originalCreate = FireBallImpactWorkflow.create.bind(FireBallImpactWorkflow);

FireBallImpactWorkflow.create = async function createFireBallImpactWithCastContext(options = {}) {
	const casterUuid = String(options?.caster?.uuid ?? "").trim();
	const spellUuid = String(options?.spell?.uuid ?? "").trim();
	const context = CoreCastingFailureWorkflow.activeContext({ casterUuid, actorUuid: casterUuid, spellUuid });
	const castId = String(options?.castId ?? context?.castId ?? "").trim();

	const message = await originalCreate({
		...options,
		...(castId ? { castId } : {}),
	});

	if (!message || !castId) return message;

	/* Persist the summary link as soon as Core knows it. SpellCastLinkage remains
	 * the general reconciliation layer and can fill this later if the summary link
	 * is not available in this exact frame. */
	const current = message.getFlag?.(FLAG_SCOPE, IMPACT_FLAG);
	const castMessageId = String(context?.castSummaryMessageId ?? "").trim();
	if (current && castMessageId && !current.castMessageId) {
		const updated = foundry.utils.deepClone(current);
		updated.castMessageId = castMessageId;
		updated.version = Math.max(3, Number(updated.version) || 0);
		updated.updatedAt = Date.now();
		await message.setFlag(FLAG_SCOPE, IMPACT_FLAG, updated);
	}

	return message;
};
