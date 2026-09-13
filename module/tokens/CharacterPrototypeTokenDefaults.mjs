/*
 * Character Actors represent persistent player characters and therefore use
 * linked prototype tokens by default. A token created from such an Actor must
 * open and modify the same canonical world Actor rather than a synthetic
 * ActorDelta copy.
 *
 * NPC, Creature, Vehicle, and Loot Pile token policies remain untouched.
 */
Hooks.on("preCreateActor", (actor) => {
	if (actor?.type !== "character") return;

	actor.updateSource({
		"prototypeToken.actorLink": true,
	});
});
