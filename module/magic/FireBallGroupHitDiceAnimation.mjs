const FLAG_SCOPE = "wfrp1ed";
const CAST_FLAG_KEY = "fireBallCast";

let installed = false;
const animatedMessages = new Set();

/**
 * Dice So Nice has no normal d3 mesh. Keep the authoritative Fire Ball group
 * roll as d3, but display each stored d3 result on a physical d6:
 *   1-2 => d3 1
 *   3-4 => d3 2
 *   5-6 => d3 3
 *
 * This is the same visual-only convention used by Risk consequences. The d6
 * never changes target selection or any persisted Fire Ball mechanics.
 */
export function installFireBallGroupHitDiceAnimation() {
	if (installed) return;
	installed = true;

	Hooks.on("preUpdateChatMessage", (message, changes) => {
		const incoming = changedCastState(changes);
		if (!incoming?.group || !Array.isArray(incoming.volleys)) return;
		if (!isAnimationAuthority(message)) return;
		if (message?.getFlag?.(FLAG_SCOPE, CAST_FLAG_KEY)) return;

		const messageId = String(message?.id ?? "").trim();
		if (!messageId || animatedMessages.has(messageId)) return;
		const results = incoming.volleys
			.map((volley) => Number(volley?.groupRoll))
			.filter(isD3);
		if (!results.length) return;

		animatedMessages.add(messageId);
		void animateGroupHits(message, results).finally(() => {
			/* The persisted cast flag is the durable duplicate guard. Keeping this
			 * set only for the current session also protects against duplicate hooks
			 * during the same update. */
			setTimeout(() => animatedMessages.delete(messageId), 10000);
		});
	});
}

async function animateGroupHits(message, results) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;

	const user = message?.author ?? game.user;
	const whisper = Array.isArray(message?.whisper) ? [...message.whisper] : [];
	const blind = message?.blind === true;

	try {
		for (const result of results) {
			const visualRoll = await physicalD6ForD3(result);
			await dice3d.showForRoll(visualRoll, user, true, whisper, blind);
		}
	} catch (error) {
		/* Optional presentation must never interrupt spell resolution. */
		console.error(
			"WFRP1ED | Unable to display Fire Ball group-hit dice animation.",
			error,
		);
	}
}

async function physicalD6ForD3(d3Result) {
	const visualRoll = await new Roll("1d6").evaluate({ allowInteractive: false });
	const term = visualRoll.dice?.[0] ?? visualRoll.terms?.find?.(
		(candidate) => Number(candidate?.faces) === 6,
	);
	const result = term?.results?.[0];
	if (!result) throw new Error("Unable to locate the evaluated d6 result.");

	/* Use the lower face of the matching pair, exactly like the existing Risk
	 * d3 bridge: d3 1 -> d6 1, d3 2 -> d6 3, d3 3 -> d6 5. */
	const d6Face = (Number(d3Result) * 2) - 1;
	result.result = d6Face;
	if (Object.prototype.hasOwnProperty.call(visualRoll, "_total")) {
		visualRoll._total = d6Face;
	}
	return visualRoll;
}

function changedCastState(changes) {
	const direct = changes?.flags?.[FLAG_SCOPE]?.[CAST_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
	const flat = changes?.[`flags.${FLAG_SCOPE}.${CAST_FLAG_KEY}`];
	return flat && typeof flat === "object" && !Array.isArray(flat) ? flat : null;
}

function isD3(value) {
	const number = Number(value);
	return Number.isInteger(number) && number >= 1 && number <= 3;
}

function isAnimationAuthority(message) {
	const gm = primaryActiveGm();
	if (gm) return String(gm.id) === String(game.user?.id ?? "");
	return String(message?.author?.id ?? message?.user?.id ?? "") === String(game.user?.id ?? "");
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) => String(first.id).localeCompare(String(second.id)))[0] ?? null;
}
