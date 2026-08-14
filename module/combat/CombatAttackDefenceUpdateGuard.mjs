const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const DEFENCE_INVALIDATED_STATUS = "invalidated";

/**
 * Preserve intentional deletion of the nested combat-attack defence state.
 *
 * Combat attack state is stored as one object-valued ChatMessage flag. Foundry
 * recursively merges object updates. Therefore replacing that flag with a
 * cloned snapshot from which `defence` was deleted does not necessarily remove
 * the already-persisted nested defence object: the omitted property can survive
 * the merge.
 *
 * Both defence rollback and the transaction error-recovery path intentionally
 * reopen an attack by writing a complete attack-state snapshot without a
 * `defence` property. Normalize that omission to an explicit `null` before the
 * update is applied. All defence consumers already treat a null defence as
 * pending, while the explicit value reliably replaces the previous object.
 */
Hooks.on("preUpdateChatMessage", (message, changes) => {
	if (!message || !changes || typeof changes !== "object") return;

	const current = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
	if (!isObject(current) || !isObject(current.defence)) return;

	const path = `flags.${FLAG_SCOPE}.${ATTACK_FLAG_KEY}`;
	const incoming = directOrNestedFlagUpdate(changes, path);
	if (!isObject(incoming)) return;

	/*
	 * A writer that supplies a defence value is not trying to remove it. Only a
	 * complete attack-state update which omits the currently persisted defence
	 * needs normalization for Foundry's recursive merge semantics.
	 */
	if (Object.hasOwn(incoming, "defence")) return;

	incoming.defence = null;
});

/**
 * Repair attacks which were already rolled back by the buggy omission-based
 * update before this guard existed. The rollback history contains the exact
 * invalidated defence, so this migration is deterministic rather than a guess.
 */
Hooks.once("ready", () => {
	if (!game.user?.isGM) return;
	void repairPreviouslyReopenedAttacks();
});

async function repairPreviouslyReopenedAttacks() {
	let repaired = 0;

	for (const message of game.messages ?? []) {
		const state = message.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (!isObject(state) || !isObject(state.defence)) continue;

		const history = Array.isArray(state.defenceHistory)
			? state.defenceHistory
			: [];
		const latestInvalidated = [...history]
			.reverse()
			.find((entry) => entry?.status === DEFENCE_INVALIDATED_STATUS);
		if (!isObject(latestInvalidated)) continue;

		const sameDefence = String(latestInvalidated.testMessageId ?? "") ===
			String(state.defence.testMessageId ?? "");
		if (!sameDefence) continue;

		const repairedState = foundry.utils.deepClone(state);
		repairedState.defence = null;
		repairedState.updatedBy = game.user?.id ?? "";
		repairedState.updatedAt = Date.now();

		await message.update({
			[`flags.${FLAG_SCOPE}.${ATTACK_FLAG_KEY}`]: repairedState,
		});
		repaired += 1;
	}

	if (repaired > 0) {
		console.info(
			`WFRP1ED | Reopened ${repaired} previously invalidated defence attack(s).`,
		);
		void ui.chat?.render?.({ force: true });
	}
}

function directOrNestedFlagUpdate(changes, path) {
	if (Object.hasOwn(changes, path)) {
		return changes[path];
	}
	return foundry.utils.getProperty(changes, path);
}

function isObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
