/**
 * Character.details is a native SchemaField. Foundry can clean a partial object
 * update to that SchemaField by filling omitted siblings with their initial
 * values. The Classic header's Career History / Career Exits +/- actions update
 * only one nested list, so preserve the rest of the existing details record
 * before validation instead of allowing those sibling fields to be blanked.
 */
Hooks.on("preUpdateActor", (actor, changes) => {
	if (
		actor?.type !== "character" ||
		!changes ||
		typeof changes !== "object"
	) {
		return;
	}

	const directHistoryKey = "system.details.careerHistory";
	const directExitsKey = "system.details.careerExits";
	const hasDirectHistory = Object.hasOwn(changes, directHistoryKey);
	const hasDirectExits = Object.hasOwn(changes, directExitsKey);
	const nestedDetails = changes.system?.details;
	const hasNestedLists = Boolean(
		nestedDetails &&
		typeof nestedDetails === "object" &&
		!Array.isArray(nestedDetails) &&
		(
			Object.hasOwn(nestedDetails, "careerHistory") ||
			Object.hasOwn(nestedDetails, "careerExits")
		)
	);

	if (!hasDirectHistory && !hasDirectExits && !hasNestedLists) return;

	const current = foundry.utils.deepClone(actor.system?.details ?? {});
	const incoming = hasNestedLists
		? foundry.utils.deepClone(nestedDetails)
		: {};

	if (hasDirectHistory) {
		incoming.careerHistory = foundry.utils.deepClone(
			changes[directHistoryKey],
		);
		delete changes[directHistoryKey];
	}
	if (hasDirectExits) {
		incoming.careerExits = foundry.utils.deepClone(
			changes[directExitsKey],
		);
		delete changes[directExitsKey];
	}

	changes.system ??= {};
	changes.system.details = {
		...current,
		...incoming,
	};
});
