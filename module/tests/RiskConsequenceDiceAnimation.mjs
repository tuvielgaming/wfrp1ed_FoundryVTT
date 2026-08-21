const FLAG_SCOPE = "wfrp1ed";
const TEST_STATE_FLAG_KEY = "testResultState";
const RISK_STATE_FLAG_KEY = "riskConsequenceState";
const RISK_TEST_ID = "risk";

/*
 * Visual-only bridge between the persisted Risk consequence and Dice So Nice.
 *
 * Dice So Nice does not provide a standard d3 mesh through its normal Roll API.
 * Therefore WFRP K3 is visualised on a physical d6:
 *   1-2 => K3 1
 *   3-4 => K3 2
 *   5-6 => K3 3
 *
 * The authoritative K3 value remains the one already stored by
 * RiskConsequenceIntegration. This module never changes the mechanical
 * consequence or creates an extra ChatMessage.
 *
 * Sequencing is deliberate: the Risk Test ChatMessage owns the percentile roll,
 * so its Dice So Nice animation must finish before the consequence d6 is shown.
 * This prevents the damage die from overlapping or even finishing before the
 * Risk Test animation.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	if (!isPrimaryActiveGm()) return;

	const incoming = changedRiskState(changes);
	if (!incoming || incoming.active !== true) return;

	const existing = message?.getFlag?.(FLAG_SCOPE, RISK_STATE_FLAG_KEY);
	if (existing && Number.isInteger(Number(existing.die))) return;

	const testState = message?.getFlag?.(FLAG_SCOPE, TEST_STATE_FLAG_KEY);
	if (String(testState?.testId ?? "") !== RISK_TEST_ID) return;

	const die = Number(incoming.die);
	if (!Number.isInteger(die) || die < 1 || die > 3) return;

	void animateStoredRiskD3(message, testState, die);
});

async function animateStoredRiskD3(message, testState, die) {
	const dice3d = game.dice3d;
	if (!dice3d || typeof dice3d.showForRoll !== "function") return;

	const user = animationUser(message, testState);
	const whisper = Array.isArray(message?.whisper)
		? [...message.whisper]
		: [];
	const blind = message?.blind === true;

	try {
		await waitForRiskTestAnimation(dice3d, message);

		const visualRoll = await new Roll("1d6").evaluate({
			allowInteractive: false,
		});
		const term = visualRoll.dice?.[0] ?? visualRoll.terms?.find?.(
			(candidate) => Number(candidate?.faces) === 6,
		);
		const result = term?.results?.[0];
		if (!result) {
			throw new Error("Unable to locate the evaluated d6 result.");
		}

		/*
		 * Use the lower face of the matching d6 pair. The animation is only a
		 * physical representation of the already-resolved K3 consequence.
		 */
		const d6Face = (die * 2) - 1;
		result.result = d6Face;
		if (Object.prototype.hasOwnProperty.call(visualRoll, "_total")) {
			visualRoll._total = d6Face;
		}

		await dice3d.showForRoll(
			visualRoll,
			user,
			true,
			whisper,
			blind,
		);
	} catch (error) {
		/* Dice animation is optional presentation and must never break Risk. */
		console.error(
			"WFRP1ED | Unable to display Risk consequence dice animation.",
			error,
		);
	}
}

async function waitForRiskTestAnimation(dice3d, message) {
	const messageId = String(message?.id ?? "").trim();
	if (!messageId) return;

	/*
	 * Dice So Nice v6 exposes an explicit per-message animation barrier. It also
	 * resolves correctly if called after that message's animation has already
	 * completed, so there is no race between ChatMessage creation and this hook.
	 */
	if (typeof dice3d.waitFor3DAnimationByMessageID === "function") {
		await dice3d.waitFor3DAnimationByMessageID(messageId);
		return;
	}

	/*
	 * Compatibility path for older Dice So Nice versions. The consequence flag
	 * is created while the percentile animation is still pending/running, so
	 * listen for completion of this exact message before starting the d6.
	 */
	await new Promise((resolve) => {
		let hookId = null;
		let timeoutId = null;
		const finish = () => {
			if (hookId !== null) Hooks.off("diceSoNiceRollComplete", hookId);
			if (timeoutId !== null) clearTimeout(timeoutId);
			resolve();
		};

		hookId = Hooks.on("diceSoNiceRollComplete", (...ids) => {
			if (containsMessageId(ids, messageId)) finish();
		});

		/* Safety only: never let optional 3D presentation block Risk forever. */
		timeoutId = setTimeout(finish, 10000);
	});
}

function containsMessageId(values, messageId) {
	for (const value of values ?? []) {
		if (Array.isArray(value)) {
			if (containsMessageId(value, messageId)) return true;
			continue;
		}
		if (String(value ?? "") === messageId) return true;
	}
	return false;
}

function changedRiskState(changes) {
	const direct = changes?.flags?.[FLAG_SCOPE]?.[RISK_STATE_FLAG_KEY];
	if (direct && typeof direct === "object" && !Array.isArray(direct)) {
		return direct;
	}

	const flat = changes?.[`flags.${FLAG_SCOPE}.${RISK_STATE_FLAG_KEY}`];
	return flat && typeof flat === "object" && !Array.isArray(flat)
		? flat
		: null;
}

function animationUser(message, testState) {
	const createdBy = String(testState?.createdBy ?? "").trim();
	if (createdBy) {
		const user = game.users?.get?.(createdBy);
		if (user) return user;
	}

	if (message?.author) return message.author;
	return game.user;
}

function isPrimaryActiveGm() {
	return primaryActiveGm()?.id === game.user?.id;
}

function primaryActiveGm() {
	return [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((first, second) =>
			String(first.id).localeCompare(String(second.id)),
		)[0] ?? null;
}
