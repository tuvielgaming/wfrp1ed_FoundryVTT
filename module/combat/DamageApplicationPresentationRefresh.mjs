const FLAG_SCOPE = "wfrp1ed";
const DAMAGE_APPLICATIONS_FLAG_KEY = "damageApplications";
let refreshQueued = false;

/**
 * DamageApplication is Actor-authoritative. An Actor OWNER may therefore apply
 * damage without permission to rewrite the originating attack ChatMessage.
 *
 * Every client receives the resulting Actor update. Use that authoritative
 * broadcast as the presentation refresh signal so dedicated Damage cards and
 * their source Attack cards remove stale Apply Damage controls for Player and GM
 * alike. Only damage-transaction flag updates trigger this relatively expensive
 * full Chat render.
 */
Hooks.on("updateActor", (_actor, changes) => {
	if (!damageApplicationsChanged(changes)) return;
	requestChatRefresh();
});

function damageApplicationsChanged(changes) {
	if (!changes || typeof changes !== "object") return false;
	const path = `flags.${FLAG_SCOPE}.${DAMAGE_APPLICATIONS_FLAG_KEY}`;
	return Object.hasOwn(changes, path) ||
		foundry.utils.getProperty?.(changes, path) !== undefined;
}

function requestChatRefresh() {
	if (refreshQueued) return;
	refreshQueued = true;
	requestAnimationFrame(() => {
		setTimeout(() => {
			refreshQueued = false;
			void ui.chat?.render?.({ force: true });
		}, 0);
	});
}
