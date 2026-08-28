const FLAG_SCOPE = "wfrp1ed";
const CAST_FLAG_KEY = "fireBallCast";
const REVEAL_FLAG_KEY = "fireBallGroupHitsRevealed";

let installed = false;
const animatedMessages = new Set();

/**
 * Dice So Nice has no normal d3 mesh. Keep every authoritative Core group-hit
 * die as d3, but display the stored d3 faces in one physical d6 animation:
 *   1 -> d6 1
 *   2 -> d6 3
 *   3 -> d6 5
 *
 * WFRP 1e Core Fire Ball uses one d3 per caster level for EACH ball fired into a
 * group, so a Level 3 caster firing two balls displays six physical d6s in one
 * batch. For group casts the entire cast-summary card stays hidden until that
 * complete batch ends, so the numerical result can never appear before the dice.
 */
export function installFireBallGroupHitDiceAnimation() {
	if (installed) return;
	installed = true;

	Hooks.on("renderChatMessageHTML", (message, html) => {
		hideUnrevealedGroupSummary(message, html);
	});

	/* Use the replicated update hook rather than preUpdate: casts initiated by a
	 * player still reach the primary GM, which is the one animation authority. */
	Hooks.on("updateChatMessage", (message, changes) => {
		const incoming = changedCastState(changes);
		if (!incoming?.group || !Array.isArray(incoming.volleys)) return;
		if (!isAnimationAuthority(message)) return;
		if (message?.getFlag?.(FLAG_SCOPE, REVEAL_FLAG_KEY)) return;

		const messageId = String(message?.id ?? "").trim();
		if (!messageId || animatedMessages.has(messageId)) return;
		const results = storedD3Results(incoming.volleys);
		if (!results.length) {
			void revealGroupResults(message);
			return;
		}

		animatedMessages.add(messageId);
		void animateGroupHits(message, results)
			.catch((error) => {
				/* Optional 3D presentation must never leave mechanics/results hidden. */
				console.error(
					"WFRP1ED | Unable to display Fire Ball group-hit dice animation.",
					error,
				);
			})
			.finally(async () => {
				try {
					await revealGroupResults(message);
				} finally {
					setTimeout(() => animatedMessages.delete(messageId), 10000);
				}
			});
	});
}

function storedD3Results(volleys) {
	return volleys.flatMap((volley) => {
		/* Version 5+ stores each Core per-level d3 separately. Keep the older scalar
		 * field as migration compatibility for already-existing chat history. */
		if (Array.isArray(volley?.groupRolls)) {
			return volley.groupRolls.map(Number).filter(isD3);
		}
		const legacy = Number(volley?.groupRoll);
		return isD3(legacy) ? [legacy] : [];
	});
}

function hideUnrevealedGroupSummary(message, html) {
	const root = asElement(html);
	const summary = root?.matches?.(".fire-ball-cast-summary")
		? root
		: root?.querySelector?.(".fire-ball-cast-summary");
	if (!(summary instanceof HTMLElement)) return;
	if (message?.getFlag?.(FLAG_SCOPE, REVEAL_FLAG_KEY)) return;

	/* At the first render the fireBallCast flag may not yet be attached. Detect a
	 * group cast from its Group hits row instead, and hide the whole ChatMessage
	 * until Dice So Nice finishes. Single-target casts have no such row and stay
	 * visible immediately because they have no group-hit animation. */
	const groupRow = [...summary.querySelectorAll(":scope > div")].find((row) => {
		const label = String(row.querySelector(":scope > strong")?.textContent ?? "").trim();
		return label === localize("Group hits:", "Trafienia grupowe:") ||
			label === localize("Group hits", "Trafienia grupowe");
	});
	if (!groupRow) return;

	const entry = summary.closest?.("[data-message-id], .chat-message, li.message, li.chat-message") ?? root;
	if (!(entry instanceof HTMLElement)) return;
	entry.dataset.wfrpFireBallPendingGroupHits = "";
	entry.style.display = "none";
	entry.setAttribute("aria-hidden", "true");
}

async function animateGroupHits(message, results) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;

	const user = message?.author ?? game.user;
	const whisper = Array.isArray(message?.whisper) ? [...message.whisper] : [];
	const blind = message?.blind === true;
	const visualRoll = await physicalD6BatchForD3(results);

	/* One Roll containing all visual d6s makes Dice So Nice launch the complete
	 * group-hit batch together rather than waiting for one die before the next. */
	await dice3d.showForRoll(visualRoll, user, true, whisper, blind);
}

async function physicalD6BatchForD3(d3Results) {
	const values = d3Results.map(Number).filter(isD3);
	if (!values.length) throw new Error("Fire Ball group-hit animation has no d3 results.");

	const visualRoll = await new Roll(`${values.length}d6`).evaluate({
		allowInteractive: false,
	});
	const term = visualRoll.dice?.[0] ?? visualRoll.terms?.find?.(
		(candidate) => Number(candidate?.faces) === 6,
	);
	const physicalResults = term?.results;
	if (!Array.isArray(physicalResults) || physicalResults.length < values.length) {
		throw new Error("Unable to locate all evaluated d6 results.");
	}

	let total = 0;
	for (let index = 0; index < values.length; index += 1) {
		const d6Face = (values[index] * 2) - 1;
		physicalResults[index].result = d6Face;
		total += d6Face;
	}
	if (Object.prototype.hasOwnProperty.call(visualRoll, "_total")) {
		visualRoll._total = total;
	}
	return visualRoll;
}

async function revealGroupResults(message) {
	if (!message?.id || message.getFlag?.(FLAG_SCOPE, REVEAL_FLAG_KEY)) return;
	if (!message.canUserModify?.(game.user, "update")) return;
	await message.setFlag(FLAG_SCOPE, REVEAL_FLAG_KEY, {
		version: 1,
		revealedAt: Date.now(),
	});

	/* The flag update normally replaces the hidden ChatMessage DOM. Unhide the
	 * current node as a safety net for clients which patch the existing element. */
	const entry = document.querySelector(`[data-message-id="${cssEscape(message.id)}"]`);
	if (entry instanceof HTMLElement) {
		delete entry.dataset.wfrpFireBallPendingGroupHits;
		entry.style.removeProperty("display");
		entry.removeAttribute("aria-hidden");
	}
	void ui.chat?.render?.({ force: true });
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

function cssEscape(value) {
	return globalThis.CSS?.escape
		? CSS.escape(String(value))
		: String(value).replace(/["\\]/g, "\\$&");
}

function asElement(value) {
	if (value instanceof HTMLElement) return value;
	if (value?.[0] instanceof HTMLElement) return value[0];
	return null;
}

function localize(english, polish) {
	return game.i18n.lang === "pl" ? polish : english;
}
