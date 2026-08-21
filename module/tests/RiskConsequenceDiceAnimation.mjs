const FLAG_SCOPE = "wfrp1ed";
const TEST_STATE_FLAG_KEY = "testResultState";
const RISK_STATE_FLAG_KEY = "riskConsequenceState";
const RISK_TEST_ID = "risk";

/*
 * Visual-only bridge between the persisted Risk consequence and Dice So Nice.
 *
 * The authoritative D3 result is rolled and stored by RiskConsequenceIntegration.
 * This module never rolls a second mechanical result. It reacts only when the
 * consequence state is created for the first time and asks Dice So Nice to show
 * that already-resolved value.
 *
 * Re-activating a previously stored consequence, reloading Foundry, or merely
 * editing the Risk card must not replay the animation because no new D3 was
 * rolled in those cases.
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
	if (!dice3d || typeof dice3d.show !== "function") return;

	const user = animationUser(message, testState);
	const whisper = Array.isArray(message?.whisper)
		? [...message.whisper]
		: [];
	const blind = message?.blind === true;

	try {
		/*
		 * Modern Dice So Nice installations may expose a d3 model/preset. Try the
		 * literal WFRP die first so installations which support it get a true d3.
		 */
		await dice3d.show(
			{
				formula: "1d3",
				results: [die],
			},
			user,
			true,
			whisper,
			blind,
		);
		return;
	} catch (error) {
		console.debug(
			"WFRP1ED | Dice So Nice has no usable d3 preset; falling back to d6 representation.",
			error,
		);
	}

	try {
		/*
		 * A physical d3 is conventionally represented on a d6 as 1-2 => 1,
		 * 3-4 => 2, 5-6 => 3. Use the lower face of the matching pair. This is
		 * presentation only; `die` remains the already-resolved authoritative D3.
		 */
		const d6Face = (die * 2) - 1;
		await dice3d.show(
			{
				formula: "1d6",
				results: [d6Face],
			},
			user,
			true,
			whisper,
			blind,
		);
	} catch (error) {
		/* Dice animation is optional presentation and must never break Risk. */
		console.debug(
			"WFRP1ED | Unable to display Risk consequence dice animation.",
			error,
		);
	}
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
