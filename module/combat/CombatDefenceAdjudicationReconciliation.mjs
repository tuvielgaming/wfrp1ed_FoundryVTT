const FLAG_SCOPE = "wfrp1ed";
const ATTACK_FLAG_KEY = "combatAttackResult";
const TEST_FLAG_KEY = "testResultState";
const activeParents = new Set();

/**
 * A defence Test is a child of the attack transaction. Its current TestResult
 * remains authoritative; the parent stores only the link and a revision marker.
 *
 * Merely calling ui.chat.render() from the child's update hook is not a reliable
 * transaction boundary: the refresh can occur while Foundry is still finishing
 * the child ChatMessage update, leaving an already-mounted attack card with the
 * previous Dodge/Parry presentation. Touching the linked parent after the child
 * update gives every client one authoritative parent revision to render from.
 */
Hooks.on("updateChatMessage", (message, changes) => {
	if (!testStateChanged(changes)) return;
	const childId = String(message?.id ?? "").trim();
	if (!childId) return;

	for (const parent of game.messages ?? []) {
		const attack = parent.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (String(attack?.defence?.testMessageId ?? "") !== childId) continue;
		void reconcileParent(parent, attack, message).catch(reportError);
	}
});

async function reconcileParent(parent, attack, child) {
	const parentId = String(parent?.id ?? "");
	if (!parentId || activeParents.has(parentId)) return;

	/* Only one authority writes the parent revision. Other clients repaint when
	 * that authoritative ChatMessage update arrives. */
	if (!isPrimaryActiveGM()) {
		scheduleChatRefresh();
		return;
	}
	if (!parent.canUserModify?.(game.user, "update")) return;

	activeParents.add(parentId);
	try {
		const current = parent.getFlag?.(FLAG_SCOPE, ATTACK_FLAG_KEY);
		if (String(current?.defence?.testMessageId ?? "") !== String(child?.id ?? "")) {
			return;
		}
		const updated = foundry.utils.deepClone(current ?? attack ?? {});
		updated.defence = foundry.utils.deepClone(updated.defence ?? {});
		updated.defence.testRevision = Number(
			child.getFlag?.(FLAG_SCOPE, TEST_FLAG_KEY)?.updatedAt ?? Date.now(),
		);
		updated.updatedBy = String(game.user?.id ?? "");
		updated.updatedAt = Date.now();
		await parent.setFlag(FLAG_SCOPE, ATTACK_FLAG_KEY, updated);
	} finally {
		activeParents.delete(parentId);
		scheduleChatRefresh();
	}
}

function testStateChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${TEST_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function isPrimaryActiveGM() {
	if (!game.user?.isGM) return false;
	const gm = [...(game.users ?? [])]
		.filter((user) => user?.active && user?.isGM)
		.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
	return gm?.id === game.user.id;
}

function scheduleChatRefresh() {
	requestAnimationFrame(() => {
		void ui.chat?.render?.({ force: true });
		setTimeout(() => void ui.chat?.render?.({ force: true }), 0);
	});
}

function reportError(error) {
	console.error("WFRP1ED | Unable to reconcile defence Test adjudication with its attack.", error);
}
